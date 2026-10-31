/**
 * Windows named-mutex addon for the cross-process Private Shelf write lock.
 *
 * Scope: this is a proof-of-concept native addon for Shelf write exclusion. It is
 * not referenced by the product write path or by the Native Messaging Host.
 *
 * Invariants this addon establishes:
 *
 * - the lock is a Windows kernel mutex, so the kernel releases it when the owning
 *   process dies (no stale lock file, no reclamation step);
 * - acquisition is non-blocking (`WaitForSingleObject` with a timeout supplied by
 *   the caller), so the Electron main thread is never parked waiting for a lock;
 * - ownership is thread-scoped, and release refuses a handle this thread does not
 *   own instead of silently corrupting the ownership state;
 * - WAIT_ABANDONED is reported separately from WAIT_OBJECT_0 so the caller can
 *   reconcile the shared journal before writing again;
 * - the mutex security descriptor grants only the current user, SYSTEM and the
 *   local Administrators group, so another Windows user cannot open or write with
 *   the same lock name.
 *
 * N-API only: the binary is ABI-stable across Node and Electron versions and does
 * not depend on the Node internal ABI.
 */
#define NAPI_VERSION 8

#include <node_api.h>
#include <windows.h>
#include <sddl.h>

#include <cstdio>
#include <string>

namespace {

constexpr DWORD kMutexAllAccess = MUTEX_ALL_ACCESS;

struct MutexHandle {
  HANDLE handle = nullptr;
  DWORD ownerThreadId = 0;
  bool owned = false;
  bool abandoned = false;
  bool createdFresh = false;
};

void ThrowError(napi_env env, const char* code, const std::string& message) {
  napi_throw_error(env, code, message.c_str());
}

std::string Win32Message(const char* context, DWORD code) {
  char buffer[256];
  std::snprintf(buffer, sizeof buffer, "%s failed with Win32 error %lu", context,
                static_cast<unsigned long>(code));
  return std::string(buffer);
}

void ThrowWin32(napi_env env, const char* context, DWORD code) {
  const char* codeName = "mutex-win32-error";
  if (code == ERROR_ACCESS_DENIED || code == ERROR_PRIVILEGE_NOT_HELD) {
    codeName = code == ERROR_ACCESS_DENIED ? "mutex-access-denied" : "mutex-privilege-missing";
  } else if (code == ERROR_ALREADY_EXISTS) {
    codeName = "mutex-already-exists";
  }
  ThrowError(env, codeName, Win32Message(context, code));
}

bool GetString(napi_env env, napi_value value, std::wstring* out) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok) return false;
  // N-API returns UTF-16 as char16_t; Windows APIs expect wchar_t. Both are 16-bit
  // on Windows, so a value copy is safe and keeps the code portable to the header.
  std::u16string text(length, u'\0');
  if (length != 0) {
    size_t copied = 0;
    if (napi_get_value_string_utf16(env, value, text.data(), length + 1, &copied) != napi_ok) {
      return false;
    }
    text.resize(copied);
  }
  out->assign(text.begin(), text.end());
  return true;
}

bool GetUtf8(napi_env env, napi_value value, std::string* out) {
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  out->resize(length);
  if (length == 0) return true;
  size_t copied = 0;
  return napi_get_value_string_utf8(env, value, out->data(), length + 1, &copied) == napi_ok;
}

bool GetInt32(napi_env env, napi_value value, int32_t* out) {
  return napi_get_value_int32(env, value, out) == napi_ok;
}

bool HasProperty(napi_env env, napi_value object, const char* name) {
  bool has = false;
  if (napi_has_named_property(env, object, name, &has) != napi_ok) return false;
  return has;
}

std::wstring CurrentUserSidString() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return std::wstring();
  DWORD length = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &length);
  if (length == 0) {
    CloseHandle(token);
    return std::wstring();
  }
  std::wstring sid;
  auto* buffer = static_cast<BYTE*>(HeapAlloc(GetProcessHeap(), 0, length));
  if (buffer != nullptr) {
    if (GetTokenInformation(token, TokenUser, buffer, length, &length)) {
      auto* user = reinterpret_cast<TOKEN_USER*>(buffer);
      LPWSTR text = nullptr;
      if (ConvertSidToStringSidW(user->User.Sid, &text)) {
        sid.assign(text);
        LocalFree(text);
      }
    }
    HeapFree(GetProcessHeap(), 0, buffer);
  }
  CloseHandle(token);
  return sid;
}

/**
 * Builds the security descriptor applied when the mutex is first created.
 *
 * Only the creating user (plus SYSTEM and Administrators) may open it. A second
 * Windows user therefore receives ERROR_ACCESS_DENIED from `CreateMutexW`, which
 * this addon reports as `mutex-access-denied`.
 */
bool BuildSecurityAttributes(const std::string& security, SECURITY_ATTRIBUTES* attributes,
                             PSECURITY_DESCRIPTOR* descriptor) {
  std::wstring sddl;
  if (security == "system-only") {
    // Test-only: proves the DACL is enforced, because the creating user itself is
    // not granted access and a second open must be refused.
    sddl = L"D:(A;;0x1F0001;;;SY)";
  } else {
    std::wstring sid = CurrentUserSidString();
    if (sid.empty()) return false;
    sddl = L"D:(A;;0x1F0001;;;SY)(A;;0x1F0001;;;BA)(A;;0x1F0001;;;" + sid + L")";
  }

  PSECURITY_DESCRIPTOR local = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &local,
                                                            nullptr)) {
    return false;
  }
  attributes->nLength = sizeof(SECURITY_ATTRIBUTES);
  attributes->lpSecurityDescriptor = local;
  attributes->bInheritHandle = FALSE;
  *descriptor = local;
  return true;
}

MutexHandle* GetHandle(napi_env env, napi_value value) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_external) return nullptr;
  void* data = nullptr;
  if (napi_get_value_external(env, value, &data) != napi_ok) return nullptr;
  return static_cast<MutexHandle*>(data);
}

void Finalize(napi_env /*env*/, void* data, void* /*hint*/) {
  auto* handle = static_cast<MutexHandle*>(data);
  if (handle == nullptr) return;
  if (handle->owned && handle->handle != nullptr
      && handle->ownerThreadId == GetCurrentThreadId()) {
    // Only the owning thread may release. If the finalizer runs on another thread,
    // the kernel still releases the mutex when the process exits.
    ReleaseMutex(handle->handle);
  }
  if (handle->handle != nullptr) CloseHandle(handle->handle);
  delete handle;
}

napi_value MakeHandleObject(napi_env env, MutexHandle* handle) {
  napi_value external = nullptr;
  if (napi_create_external(env, handle, Finalize, nullptr, &external) != napi_ok) return nullptr;
  return external;
}

napi_value CreateMutexFn(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) return nullptr;
  if (argc < 1) {
    ThrowError(env, "mutex-invalid-argument", "createMutex(name[, options]) requires a name.");
    return nullptr;
  }
  std::wstring name;
  if (!GetString(env, argv[0], &name) || name.empty()) {
    ThrowError(env, "mutex-invalid-argument", "The mutex name must be a non-empty string.");
    return nullptr;
  }
  if (name.size() > 200) {
    ThrowError(env, "mutex-invalid-argument", "The mutex name is too long.");
    return nullptr;
  }

  std::string security = "current-user";
  if (argc >= 2 && argv[1] != nullptr) {
    napi_valuetype type = napi_undefined;
    if (napi_typeof(env, argv[1], &type) == napi_ok && type == napi_object
        && HasProperty(env, argv[1], "security")) {
      napi_value value = nullptr;
      if (napi_get_named_property(env, argv[1], "security", &value) == napi_ok) {
        if (!GetUtf8(env, value, &security)) security = "current-user";
      }
    }
  }

  SECURITY_ATTRIBUTES attributes{};
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  if (!BuildSecurityAttributes(security, &attributes, &descriptor)) {
    ThrowWin32(env, "ConvertStringSecurityDescriptorToSecurityDescriptor", GetLastError());
    return nullptr;
  }

  // bInitialOwner = FALSE: ownership is taken explicitly by `acquire`, never
  // implicitly by creation, so a creation-only handle cannot block a writer.
  SetLastError(0);
  HANDLE mutex = CreateMutexW(&attributes, FALSE, name.c_str());
  DWORD error = GetLastError();
  LocalFree(descriptor);
  if (mutex == nullptr) {
    ThrowWin32(env, "CreateMutexW", error == 0 ? GetLastError() : error);
    return nullptr;
  }

  auto* handle = new MutexHandle();
  handle->handle = mutex;
  handle->createdFresh = (error != ERROR_ALREADY_EXISTS);
  return MakeHandleObject(env, handle);
}

napi_value OpenMutexFn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) return nullptr;
  std::wstring name;
  if (argc < 1 || !GetString(env, argv[0], &name) || name.empty()) {
    ThrowError(env, "mutex-invalid-argument", "openMutex(name) requires a name.");
    return nullptr;
  }
  SetLastError(0);
  HANDLE mutex = OpenMutexW(kMutexAllAccess, FALSE, name.c_str());
  DWORD error = GetLastError();
  if (mutex == nullptr) {
    ThrowWin32(env, "OpenMutexW", error == 0 ? ERROR_FILE_NOT_FOUND : error);
    return nullptr;
  }
  auto* handle = new MutexHandle();
  handle->handle = mutex;
  handle->createdFresh = false;
  return MakeHandleObject(env, handle);
}

napi_value AcquireFn(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) return nullptr;
  MutexHandle* handle = argc >= 1 ? GetHandle(env, argv[0]) : nullptr;
  if (handle == nullptr || handle->handle == nullptr) {
    ThrowError(env, "mutex-invalid-handle", "acquire(handle[, waitMs]) requires a mutex handle.");
    return nullptr;
  }
  int32_t waitMs = 0;
  if (argc >= 2 && argv[1] != nullptr) {
    if (!GetInt32(env, argv[1], &waitMs) || waitMs < 0) {
      ThrowError(env, "mutex-invalid-argument", "waitMs must be a non-negative integer.");
      return nullptr;
    }
  }
  // A recursive wait on the same thread would increment the kernel recursion count
  // while JavaScript still believes it holds exactly one lock. Reject it instead.
  if (handle->owned) {
    ThrowError(env, "mutex-already-owned",
               "This handle is already owned by this thread; nesting is not supported.");
    return nullptr;
  }

  DWORD result = WaitForSingleObject(handle->handle, static_cast<DWORD>(waitMs));
  napi_value out = nullptr;
  if (napi_create_object(env, &out) != napi_ok) return nullptr;
  bool acquired = result == WAIT_OBJECT_0 || result == WAIT_ABANDONED;
  bool abandoned = result == WAIT_ABANDONED;
  if (result == WAIT_FAILED) {
    ThrowWin32(env, "WaitForSingleObject", GetLastError());
    return nullptr;
  }
  if (acquired) {
    handle->owned = true;
    handle->ownerThreadId = GetCurrentThreadId();
    handle->abandoned = abandoned;
  }
  napi_value value = nullptr;
  napi_get_boolean(env, acquired, &value);
  napi_set_named_property(env, out, "acquired", value);
  napi_get_boolean(env, abandoned, &value);
  napi_set_named_property(env, out, "abandoned", value);
  napi_create_uint32(env, static_cast<uint32_t>(result), &value);
  napi_set_named_property(env, out, "waitResult", value);
  return out;
}

napi_value ReleaseFn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) return nullptr;
  MutexHandle* handle = argc >= 1 ? GetHandle(env, argv[0]) : nullptr;
  if (handle == nullptr || handle->handle == nullptr) {
    ThrowError(env, "mutex-invalid-handle", "release(handle) requires a mutex handle.");
    return nullptr;
  }
  if (!handle->owned) {
    ThrowError(env, "mutex-not-owned", "This handle does not own the mutex.");
    return nullptr;
  }
  if (handle->ownerThreadId != GetCurrentThreadId()) {
    // ReleaseMutex would fail with ERROR_NOT_OWNER; report it explicitly so the
    // caller never believes the lock was released.
    ThrowError(env, "mutex-thread-mismatch",
               "The mutex must be released on the thread that acquired it.");
    return nullptr;
  }
  if (!ReleaseMutex(handle->handle)) {
    ThrowWin32(env, "ReleaseMutex", GetLastError());
    return nullptr;
  }
  handle->owned = false;
  handle->ownerThreadId = 0;
  handle->abandoned = false;
  napi_value out = nullptr;
  napi_create_object(env, &out);
  napi_value value = nullptr;
  napi_get_boolean(env, true, &value);
  napi_set_named_property(env, out, "released", value);
  return out;
}

napi_value CloseHandleFn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) return nullptr;
  MutexHandle* handle = argc >= 1 ? GetHandle(env, argv[0]) : nullptr;
  if (handle == nullptr || handle->handle == nullptr) {
    ThrowError(env, "mutex-invalid-handle", "close(handle) requires a mutex handle.");
    return nullptr;
  }
  if (handle->owned && handle->ownerThreadId == GetCurrentThreadId()) {
    ReleaseMutex(handle->handle);
    handle->owned = false;
    handle->ownerThreadId = 0;
  }
  CloseHandle(handle->handle);
  handle->handle = nullptr;
  return nullptr;
}

napi_value StateFn(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok) return nullptr;
  MutexHandle* handle = argc >= 1 ? GetHandle(env, argv[0]) : nullptr;
  if (handle == nullptr) {
    ThrowError(env, "mutex-invalid-handle", "state(handle) requires a mutex handle.");
    return nullptr;
  }
  napi_value out = nullptr;
  if (napi_create_object(env, &out) != napi_ok) return nullptr;
  napi_value value = nullptr;
  napi_get_boolean(env, handle->owned, &value);
  napi_set_named_property(env, out, "owned", value);
  napi_get_boolean(env, handle->abandoned, &value);
  napi_set_named_property(env, out, "abandoned", value);
  napi_get_boolean(env, handle->createdFresh, &value);
  napi_set_named_property(env, out, "createdFresh", value);
  napi_create_uint32(env, handle->ownerThreadId, &value);
  napi_set_named_property(env, out, "ownerThreadId", value);
  napi_create_uint32(env, GetCurrentThreadId(), &value);
  napi_set_named_property(env, out, "currentThreadId", value);
  napi_get_boolean(env, handle->handle != nullptr, &value);
  napi_set_named_property(env, out, "open", value);
  return out;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"createMutex", nullptr, CreateMutexFn, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"openMutex", nullptr, OpenMutexFn, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"acquire", nullptr, AcquireFn, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"release", nullptr, ReleaseFn, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"close", nullptr, CloseHandleFn, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"state", nullptr, StateFn, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, sizeof properties / sizeof properties[0], properties)
      != napi_ok) {
    return nullptr;
  }
  napi_value version = nullptr;
  napi_create_int32(env, 1, &version);
  napi_set_named_property(env, exports, "apiVersion", version);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
