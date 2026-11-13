/**
 * Desktop-only Windows integration addon for the Collector wizard (WP-3).
 *
 * Design: collector-wizard-integration-design.md section 3.3. This addon is separate
 * from `shelf_mutex.node` so the Collector Host binary gains no registry-writing code.
 *
 * Security properties this file establishes:
 *
 * - The only registry WRITES in the whole binary are `RegSetValueExW` /
 *   `RegDeleteKeyExW` on one compile-time constant key under HKCU
 *   (`Software\Google\Chrome\NativeMessagingHosts\org.maginalia.collector`), with a value
 *   computed from `FOLDERID_UserProgramFiles` plus a constant suffix. There is no generic
 *   registry write or delete function and no exported function accepts a key, a value, a
 *   hive for writing, or a path for writing.
 * - `registerCollectorHost`, `unregisterCollectorHost` and
 *   `replaceForeignCollectorHostRegistration` read NO arguments (they never call
 *   `napi_get_cb_info`), so a caller cannot influence them.
 * - `unregisterCollectorHost` deletes the key only when its default value is a REG_SZ
 *   equal to our manifest path (case-insensitive ordinal), otherwise it reports `foreign`.
 * - Nothing here reads environment variables, the working directory or argv.
 * - `readRegistryValue` / `readRegistryValueNames` are read-only (KEY_QUERY_VALUE) and
 *   never expand REG_EXPAND_SZ, so no environment variable can influence a result.
 *
 * Test seam: when (and only when) compiled with MAGINALIA_WI_TEST_SEAM (the separate
 * `windows_integration_test` target, never staged or shipped), the constant key becomes a
 * mutable private subkey under `HKCU\Software\MAGINALIA-Tests\`, starts unset (every write
 * refuses until a test root is chosen), and a few test-only exports exist. The product
 * target contains none of that code; a test checks its export table and strings.
 *
 * N-API only: ABI-stable across Node and Electron versions.
 */
#define NAPI_VERSION 8

#include <node_api.h>
#include <windows.h>
#include <knownfolders.h>
#include <shlobj.h>

#include <cstdio>
#include <cstring>
#include <cwchar>
#include <string>
#include <vector>

namespace {

constexpr wchar_t kHostKeyPath[] =
    L"Software\\Google\\Chrome\\NativeMessagingHosts\\org.maginalia.collector";
constexpr wchar_t kProgramFolderName[] = L"MAGINALIA Collector";
constexpr wchar_t kManifestFileName[] = L"org.maginalia.collector.json";

constexpr DWORD kMaxValueBytes = 64 * 1024;
constexpr DWORD kMaxValueNames = 4096;
constexpr size_t kMaxSubkeyChars = 1024;

#ifdef MAGINALIA_WI_TEST_SEAM
constexpr wchar_t kTestRootPrefix[] = L"Software\\MAGINALIA-Tests\\";
constexpr wchar_t kTestHostSuffix[] = L"\\NativeMessagingHosts\\org.maginalia.collector";
std::wstring g_testHostKeyPath;  // empty until testSetRoot: every write refuses
const wchar_t* HostKeyPath() { return g_testHostKeyPath.c_str(); }
bool HostKeyConfigured() { return !g_testHostKeyPath.empty(); }
#else
const wchar_t* HostKeyPath() { return kHostKeyPath; }
bool HostKeyConfigured() { return true; }
#endif

void ThrowError(napi_env env, const char* code, const std::string& message) {
  napi_throw_error(env, code, message.c_str());
}

bool GetString(napi_env env, napi_value value, std::wstring* out) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok) return false;
  std::u16string text(length + 1, u'\0');
  size_t copied = 0;
  if (napi_get_value_string_utf16(env, value, text.data(), text.size(), &copied) != napi_ok) {
    return false;
  }
  text.resize(copied);
  out->assign(text.begin(), text.end());
  return true;
}

bool GetUtf8(napi_env env, napi_value value, std::string* out) {
  napi_valuetype type = napi_undefined;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) return false;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok) return false;
  out->assign(length + 1, '\0');
  size_t copied = 0;
  if (napi_get_value_string_utf8(env, value, out->data(), out->size(), &copied) != napi_ok) {
    return false;
  }
  out->resize(copied);
  return true;
}

napi_value MakeString(napi_env env, const std::wstring& text) {
  napi_value value = nullptr;
  napi_create_string_utf16(env, reinterpret_cast<const char16_t*>(text.data()), text.size(), &value);
  return value;
}

napi_value MakeAscii(napi_env env, const char* text) {
  napi_value value = nullptr;
  napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value);
  return value;
}

void SetProperty(napi_env env, napi_value object, const char* name, napi_value value) {
  napi_set_named_property(env, object, name, value);
}

bool ContainsNul(const std::wstring& text) { return text.find(L'\0') != std::wstring::npos; }

// ----- Known folders ---------------------------------------------------------------------

struct KnownFolderEntry {
  const char* id;
  const KNOWNFOLDERID* folder;
};

const KnownFolderEntry kKnownFolders[] = {
    {"UserProgramFiles", &FOLDERID_UserProgramFiles},
    {"LocalAppData", &FOLDERID_LocalAppData},
    {"ProgramFiles", &FOLDERID_ProgramFiles},
    {"ProgramFilesX86", &FOLDERID_ProgramFilesX86},
};

bool IsLocalDrivePath(const std::wstring& path) {
  const bool isDrivePath = path.size() >= 3
      && ((path[0] >= L'A' && path[0] <= L'Z') || (path[0] >= L'a' && path[0] <= L'z'))
      && path[1] == L':' && (path[2] == L'\\' || path[2] == L'/');
  if (!isDrivePath) return false;
  const wchar_t driveRoot[] = {path[0], L':', L'\\', L'\0'};
  const UINT driveType = GetDriveTypeW(driveRoot);
  return driveType == DRIVE_FIXED || driveType == DRIVE_RAMDISK;
}

// Returns false when the folder is unavailable or not a local drive path.
bool ResolveKnownFolder(const KNOWNFOLDERID& id, std::wstring* out) {
  PWSTR raw = nullptr;
  const HRESULT result = SHGetKnownFolderPath(id, KF_FLAG_DEFAULT, nullptr, &raw);
  if (FAILED(result) || raw == nullptr) {
    if (raw != nullptr) CoTaskMemFree(raw);
    return false;
  }
  std::wstring path(raw);
  CoTaskMemFree(raw);
  if (!IsLocalDrivePath(path)) return false;
  *out = path;
  return true;
}

napi_value GetKnownFolderPathFn(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::string id;
  if (argc != 1 || !GetUtf8(env, argv[0], &id)) {
    ThrowError(env, "invalid-argument", "getKnownFolderPath expects one folder id string.");
    return nullptr;
  }
  for (const auto& entry : kKnownFolders) {
    if (id == entry.id) {
      std::wstring path;
      if (!ResolveKnownFolder(*entry.folder, &path)) {
        ThrowError(env, "known-folder-unavailable",
                   "The Windows known folder is unavailable or not on a local drive.");
        return nullptr;
      }
      return MakeString(env, path);
    }
  }
  ThrowError(env, "invalid-argument", "Unknown known folder id.");
  return nullptr;
}

// ----- Read-only registry helpers --------------------------------------------------------

bool ParseHive(napi_env env, napi_value value, HKEY* hive) {
  std::string name;
  if (!GetUtf8(env, value, &name)) return false;
  if (name == "HKCU") { *hive = HKEY_CURRENT_USER; return true; }
  if (name == "HKLM") { *hive = HKEY_LOCAL_MACHINE; return true; }
  return false;
}

bool ParseView(napi_env env, napi_value value, REGSAM* flag) {
  std::string name;
  if (!GetUtf8(env, value, &name)) return false;
  if (name == "default") { *flag = 0; return true; }
  if (name == "64") { *flag = KEY_WOW64_64KEY; return true; }
  if (name == "32") { *flag = KEY_WOW64_32KEY; return true; }
  return false;
}

bool ValidSubkey(const std::wstring& subkey) {
  return !subkey.empty() && subkey.size() <= kMaxSubkeyChars && !ContainsNul(subkey);
}

enum class ValueKind { kMissing, kString, kExpandString, kDword, kOther, kError };

struct ReadValue {
  ValueKind kind = ValueKind::kMissing;
  std::wstring text;
  DWORD dword = 0;
  LONG error = ERROR_SUCCESS;
};

// Reads one value from an open key without expanding anything.
ReadValue ReadOpenValue(HKEY key, const std::wstring& name) {
  ReadValue result;
  DWORD type = 0;
  DWORD size = 0;
  LONG status = RegQueryValueExW(key, name.c_str(), nullptr, &type, nullptr, &size);
  if (status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND) return result;
  if (status != ERROR_SUCCESS) { result.kind = ValueKind::kError; result.error = status; return result; }
  if (size > kMaxValueBytes) { result.kind = ValueKind::kError; result.error = ERROR_MORE_DATA; return result; }
  std::vector<BYTE> buffer(size + sizeof(wchar_t) * 2, 0);
  DWORD capacity = size;
  status = RegQueryValueExW(key, name.c_str(), nullptr, &type, buffer.data(), &capacity);
  if (status != ERROR_SUCCESS) { result.kind = ValueKind::kError; result.error = status; return result; }
  if (type == REG_SZ || type == REG_EXPAND_SZ) {
    // The stored data may lack a terminator; the buffer has spare zeroed room.
    std::wstring text(reinterpret_cast<const wchar_t*>(buffer.data()), capacity / sizeof(wchar_t));
    const size_t nul = text.find(L'\0');
    if (nul != std::wstring::npos) text.resize(nul);
    result.kind = type == REG_SZ ? ValueKind::kString : ValueKind::kExpandString;
    result.text = text;
  } else if (type == REG_DWORD && capacity == sizeof(DWORD)) {
    result.kind = ValueKind::kDword;
    std::memcpy(&result.dword, buffer.data(), sizeof(DWORD));
  } else {
    result.kind = ValueKind::kOther;
  }
  return result;
}

napi_value ReadRegistryValueFn(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5] = {nullptr, nullptr, nullptr, nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  HKEY hive = nullptr;
  REGSAM view = 0;
  std::wstring subkey;
  std::wstring name;
  if (argc != 4 || !ParseHive(env, argv[0], &hive) || !GetString(env, argv[1], &subkey)
      || !GetString(env, argv[2], &name) || !ParseView(env, argv[3], &view)
      || !ValidSubkey(subkey) || ContainsNul(name) || name.size() > 16383) {
    ThrowError(env, "invalid-argument", "readRegistryValue expects (hive, subkey, name, view).");
    return nullptr;
  }
  HKEY key = nullptr;
  const LONG opened = RegOpenKeyExW(hive, subkey.c_str(), 0, KEY_QUERY_VALUE | view, &key);
  napi_value null = nullptr;
  napi_get_null(env, &null);
  if (opened == ERROR_FILE_NOT_FOUND || opened == ERROR_PATH_NOT_FOUND) return null;
  if (opened != ERROR_SUCCESS) {
    char message[96];
    std::snprintf(message, sizeof message, "RegOpenKeyExW failed with Win32 error %lu", static_cast<unsigned long>(opened));
    ThrowError(env, opened == ERROR_ACCESS_DENIED ? "registry-access-denied" : "registry-read-failed", message);
    return nullptr;
  }
  const ReadValue value = ReadOpenValue(key, name);
  RegCloseKey(key);
  if (value.kind == ValueKind::kMissing) return null;
  if (value.kind == ValueKind::kError) {
    char message[96];
    std::snprintf(message, sizeof message, "RegQueryValueExW failed with Win32 error %lu", static_cast<unsigned long>(value.error));
    ThrowError(env, "registry-read-failed", message);
    return nullptr;
  }
  napi_value out = nullptr;
  napi_create_object(env, &out);
  switch (value.kind) {
    case ValueKind::kString:
      SetProperty(env, out, "type", MakeAscii(env, "sz"));
      SetProperty(env, out, "value", MakeString(env, value.text));
      break;
    case ValueKind::kExpandString:
      SetProperty(env, out, "type", MakeAscii(env, "expand-sz"));
      SetProperty(env, out, "value", MakeString(env, value.text));
      break;
    case ValueKind::kDword: {
      napi_value number = nullptr;
      napi_create_uint32(env, value.dword, &number);
      SetProperty(env, out, "type", MakeAscii(env, "dword"));
      SetProperty(env, out, "value", number);
      break;
    }
    default: {
      napi_value nothing = nullptr;
      napi_get_null(env, &nothing);
      SetProperty(env, out, "type", MakeAscii(env, "other"));
      SetProperty(env, out, "value", nothing);
      break;
    }
  }
  return out;
}

// Names of the values directly under one key (list policies such as NativeMessagingBlocklist
// store their entries as values named "1", "2", ...). Returns null when the key is missing.
napi_value ReadRegistryValueNamesFn(napi_env env, napi_callback_info info) {
  size_t argc = 4;
  napi_value argv[4] = {nullptr, nullptr, nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  HKEY hive = nullptr;
  REGSAM view = 0;
  std::wstring subkey;
  if (argc != 3 || !ParseHive(env, argv[0], &hive) || !GetString(env, argv[1], &subkey)
      || !ParseView(env, argv[2], &view) || !ValidSubkey(subkey)) {
    ThrowError(env, "invalid-argument", "readRegistryValueNames expects (hive, subkey, view).");
    return nullptr;
  }
  HKEY key = nullptr;
  const LONG opened = RegOpenKeyExW(hive, subkey.c_str(), 0, KEY_QUERY_VALUE | view, &key);
  napi_value null = nullptr;
  napi_get_null(env, &null);
  if (opened == ERROR_FILE_NOT_FOUND || opened == ERROR_PATH_NOT_FOUND) return null;
  if (opened != ERROR_SUCCESS) {
    ThrowError(env, opened == ERROR_ACCESS_DENIED ? "registry-access-denied" : "registry-read-failed",
               "RegOpenKeyExW failed.");
    return nullptr;
  }
  napi_value array = nullptr;
  napi_create_array(env, &array);
  uint32_t count = 0;
  std::vector<wchar_t> buffer(16384);
  for (DWORD index = 0; index < kMaxValueNames; ++index) {
    DWORD length = static_cast<DWORD>(buffer.size());
    const LONG status = RegEnumValueW(key, index, buffer.data(), &length, nullptr, nullptr, nullptr, nullptr);
    if (status == ERROR_NO_MORE_ITEMS) break;
    if (status != ERROR_SUCCESS) {
      RegCloseKey(key);
      ThrowError(env, "registry-read-failed", "RegEnumValueW failed.");
      return nullptr;
    }
    napi_set_element(env, array, count++, MakeString(env, std::wstring(buffer.data(), length)));
  }
  RegCloseKey(key);
  return array;
}

// ----- The one registry writer -----------------------------------------------------------

// <UserProgramFiles>\MAGINALIA Collector\org.maginalia.collector.json, computed here and
// nowhere else. No argument, environment variable, cwd or argv participates.
bool ComputeManifestPath(std::wstring* out) {
  std::wstring base;
  if (!ResolveKnownFolder(FOLDERID_UserProgramFiles, &base)) return false;
  while (!base.empty() && (base.back() == L'\\' || base.back() == L'/')) base.pop_back();
  *out = base + L"\\" + kProgramFolderName + L"\\" + kManifestFileName;
  return true;
}

bool PathsEqual(const std::wstring& left, const std::wstring& right) {
  return CompareStringOrdinal(left.c_str(), static_cast<int>(left.size()), right.c_str(),
                              static_cast<int>(right.size()), TRUE) == CSTR_EQUAL;
}

napi_value MakeResult(napi_env env, const char* status, LONG error) {
  napi_value out = nullptr;
  napi_create_object(env, &out);
  SetProperty(env, out, "status", MakeAscii(env, status));
  napi_value code = nullptr;
  napi_create_int64(env, error, &code);
  SetProperty(env, out, "errorCode", code);
  return out;
}

const char* StatusFor(LONG error) {
  return error == ERROR_ACCESS_DENIED ? "access-denied" : "failed";
}

// What the constant key currently holds, as far as ownership is concerned.
enum class Existing { kAbsent, kOurs, kForeign, kError };

Existing InspectExisting(const std::wstring& ours, LONG* error) {
  HKEY key = nullptr;
  const LONG opened = RegOpenKeyExW(HKEY_CURRENT_USER, HostKeyPath(), 0, KEY_QUERY_VALUE | KEY_WOW64_64KEY, &key);
  if (opened == ERROR_FILE_NOT_FOUND || opened == ERROR_PATH_NOT_FOUND) return Existing::kAbsent;
  if (opened != ERROR_SUCCESS) { *error = opened; return Existing::kError; }
  const ReadValue value = ReadOpenValue(key, std::wstring());
  RegCloseKey(key);
  if (value.kind == ValueKind::kError) { *error = value.error; return Existing::kError; }
  if (value.kind == ValueKind::kMissing) return Existing::kAbsent;  // key without a default value
  if (value.kind == ValueKind::kString && PathsEqual(value.text, ours)) return Existing::kOurs;
  return Existing::kForeign;
}

napi_value WriteRegistration(napi_env env, bool replaceForeign) {
  if (!HostKeyConfigured()) return MakeResult(env, "failed", ERROR_NOT_READY);
  std::wstring manifest;
  if (!ComputeManifestPath(&manifest)) return MakeResult(env, "failed", ERROR_PATH_NOT_FOUND);
  LONG error = ERROR_SUCCESS;
  const Existing existing = InspectExisting(manifest, &error);
  if (existing == Existing::kError) return MakeResult(env, StatusFor(error), error);
  // `register` never overwrites somebody else's registration; only the explicit
  // `replaceForeign` entry point (called after the user confirmed) does.
  if (existing == Existing::kForeign && !replaceForeign) return MakeResult(env, "foreign", ERROR_SUCCESS);
  HKEY key = nullptr;
  error = RegCreateKeyExW(HKEY_CURRENT_USER, HostKeyPath(), 0, nullptr, REG_OPTION_NON_VOLATILE,
                          KEY_SET_VALUE | KEY_WOW64_64KEY, nullptr, &key, nullptr);
  if (error != ERROR_SUCCESS) return MakeResult(env, StatusFor(error), error);
  error = RegSetValueExW(key, nullptr, 0, REG_SZ, reinterpret_cast<const BYTE*>(manifest.c_str()),
                         static_cast<DWORD>((manifest.size() + 1) * sizeof(wchar_t)));
  RegCloseKey(key);
  if (error != ERROR_SUCCESS) return MakeResult(env, StatusFor(error), error);
  return MakeResult(env, "ok", ERROR_SUCCESS);
}

// No arguments are read: napi_get_cb_info is deliberately not called.
napi_value RegisterCollectorHostFn(napi_env env, napi_callback_info) {
  return WriteRegistration(env, false);
}

napi_value ReplaceForeignCollectorHostRegistrationFn(napi_env env, napi_callback_info) {
  return WriteRegistration(env, true);
}

napi_value UnregisterCollectorHostFn(napi_env env, napi_callback_info) {
  if (!HostKeyConfigured()) return MakeResult(env, "failed", ERROR_NOT_READY);
  std::wstring manifest;
  if (!ComputeManifestPath(&manifest)) return MakeResult(env, "failed", ERROR_PATH_NOT_FOUND);
  LONG error = ERROR_SUCCESS;
  const Existing existing = InspectExisting(manifest, &error);
  if (existing == Existing::kError) return MakeResult(env, StatusFor(error), error);
  if (existing == Existing::kAbsent) return MakeResult(env, "not-registered", ERROR_SUCCESS);
  if (existing == Existing::kForeign) return MakeResult(env, "foreign", ERROR_SUCCESS);
  error = RegDeleteKeyExW(HKEY_CURRENT_USER, HostKeyPath(), KEY_WOW64_64KEY, 0);
  if (error == ERROR_FILE_NOT_FOUND) return MakeResult(env, "not-registered", ERROR_SUCCESS);
  if (error != ERROR_SUCCESS) return MakeResult(env, StatusFor(error), error);
  return MakeResult(env, "ok", ERROR_SUCCESS);
}

#ifdef MAGINALIA_WI_TEST_SEAM
// ----- Test-only seam (never compiled into the product addon) -----------------------------

bool TestRootAllowed(const std::wstring& root) {
  const size_t prefix = std::wcslen(kTestRootPrefix);
  if (root.size() <= prefix || root.size() > 200 || ContainsNul(root)) return false;
  if (CompareStringOrdinal(root.c_str(), static_cast<int>(prefix), kTestRootPrefix, static_cast<int>(prefix), TRUE) != CSTR_EQUAL) return false;
  return root.find(L"..") == std::wstring::npos && root.find(L'/') == std::wstring::npos
      && root.back() != L'\\';
}

napi_value TestSetRootFn(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::wstring root;
  if (argc != 1 || !GetString(env, argv[0], &root) || !TestRootAllowed(root)) {
    ThrowError(env, "invalid-argument", "testSetRoot requires a subkey under Software\\MAGINALIA-Tests\\.");
    return nullptr;
  }
  g_testHostKeyPath = root + kTestHostSuffix;
  return MakeString(env, g_testHostKeyPath);
}

// Seeds a "foreign" default value into the private test key.
napi_value TestSeedValueFn(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2] = {nullptr, nullptr};
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  std::wstring value;
  if (!HostKeyConfigured() || argc != 1 || !GetString(env, argv[0], &value)) {
    ThrowError(env, "invalid-argument", "testSeedValue requires testSetRoot first and one string.");
    return nullptr;
  }
  HKEY key = nullptr;
  LONG error = RegCreateKeyExW(HKEY_CURRENT_USER, HostKeyPath(), 0, nullptr, REG_OPTION_NON_VOLATILE,
                               KEY_SET_VALUE | KEY_WOW64_64KEY, nullptr, &key, nullptr);
  if (error == ERROR_SUCCESS) {
    error = RegSetValueExW(key, nullptr, 0, REG_SZ, reinterpret_cast<const BYTE*>(value.c_str()),
                           static_cast<DWORD>((value.size() + 1) * sizeof(wchar_t)));
    RegCloseKey(key);
  }
  return MakeResult(env, error == ERROR_SUCCESS ? "ok" : "failed", error);
}

// Deletes the whole private test tree (root chosen by testSetRoot).
napi_value TestCleanupFn(napi_env env, napi_callback_info) {
  if (!HostKeyConfigured()) return MakeResult(env, "ok", ERROR_SUCCESS);
  const std::wstring suffix = kTestHostSuffix;
  const std::wstring root = g_testHostKeyPath.substr(0, g_testHostKeyPath.size() - suffix.size());
  if (!TestRootAllowed(root)) return MakeResult(env, "failed", ERROR_INVALID_PARAMETER);
  const LONG error = RegDeleteTreeW(HKEY_CURRENT_USER, root.c_str());
  g_testHostKeyPath.clear();
  // Remove the shared test parent too when it is now empty (fails harmlessly otherwise).
  RegDeleteKeyExW(HKEY_CURRENT_USER, L"Software\\MAGINALIA-Tests", KEY_WOW64_64KEY, 0);
  return MakeResult(env, error == ERROR_SUCCESS || error == ERROR_FILE_NOT_FOUND ? "ok" : "failed", error);
}
#endif  // MAGINALIA_WI_TEST_SEAM

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor properties[] = {
      {"getKnownFolderPath", nullptr, GetKnownFolderPathFn, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readRegistryValue", nullptr, ReadRegistryValueFn, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"readRegistryValueNames", nullptr, ReadRegistryValueNamesFn, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"registerCollectorHost", nullptr, RegisterCollectorHostFn, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"unregisterCollectorHost", nullptr, UnregisterCollectorHostFn, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"replaceForeignCollectorHostRegistration", nullptr, ReplaceForeignCollectorHostRegistrationFn, nullptr, nullptr, nullptr, napi_default, nullptr},
#ifdef MAGINALIA_WI_TEST_SEAM
      {"testSetRoot", nullptr, TestSetRootFn, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"testSeedValue", nullptr, TestSeedValueFn, nullptr, nullptr, nullptr, napi_default, nullptr},
      {"testCleanup", nullptr, TestCleanupFn, nullptr, nullptr, nullptr, napi_default, nullptr},
#endif
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
