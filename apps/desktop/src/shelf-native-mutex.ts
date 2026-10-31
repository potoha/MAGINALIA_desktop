/**
 * Windows named-mutex write lock for one Private Shelf (technical verification).
 *
 * This is the OD-10(b) spike: the cross-process exclusion authority is a Windows
 * kernel mutex instead of a lock file. It is not reachable from the product write
 * path, the Desktop UI, or the Native Messaging Host.
 *
 * Why a kernel mutex (see `docs/collector-shelf-native-mutex.md`):
 *
 * - ownership is released by the kernel when the holding process dies, so a crash
 *   cannot leave a lock that blocks every later writer;
 * - `WAIT_ABANDONED` tells the next writer that the previous holder died while it
 *   still owned the lock, which is the signal to reconcile the shared journal
 *   before writing again (`shelf-native-write-lock.ts`);
 * - acquisition is non-blocking (`waitMs = 0`) and polling happens on the JS event
 *   loop, so the Electron main thread is never parked inside the kernel.
 *
 * Ownership is thread-scoped by the Windows API, so the addon refuses to release a
 * lock from another thread. Two consequences this module encodes:
 *
 * 1. `assertHeld()` is a real check, not a formality: it compares the kernel's owner
 *    thread with the current thread before every publish;
 * 2. the OS mutex is recursive for the owning thread, so it cannot exclude two
 *    async tasks in the same process. In-process exclusion therefore stays in
 *    JavaScript (`heldNames`), exactly like the existing module promise queue.
 *
 * Every participant must keep one handle open for the lifetime of its process:
 * a Windows mutex object is destroyed when its last handle closes, and only a
 * surviving handle can observe `WAIT_ABANDONED`. `handleFor()` caches one handle
 * per lock name for exactly that reason.
 */
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Absolute paths are required, so the base only has to be a valid filename. This
// avoids depending on `__dirname`, which is absent when the module is loaded as ESM
// by the test runner.
const requireNative = createRequire(path.join(process.cwd(), "shelf-native-mutex.cjs"));

export type ShelfNativeMutexErrorCode =
  | "native-mutex-unavailable"
  | "native-mutex-invalid-name"
  | "native-mutex-access-denied"
  | "native-mutex-privilege-missing"
  | "native-mutex-thread-mismatch"
  | "native-mutex-failed"
  | "shelf-write-busy"
  | "shelf-write-invalid-request"
  | "shelf-write-lease-lost";

export class ShelfNativeMutexError extends Error {
  public constructor(
    public readonly code: ShelfNativeMutexErrorCode,
    message: string,
    public readonly detail?: string
  ) {
    super(message);
    this.name = "ShelfNativeMutexError";
  }
}

function fail(code: ShelfNativeMutexErrorCode, message: string, detail?: string): never {
  throw new ShelfNativeMutexError(code, message, detail);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Prefix shared by every MAGINALIA Shelf write mutex. */
export const SHELF_MUTEX_NAME_PREFIX = "MAGINALIA.ShelfWrite.";

export type ShelfMutexScope = "session" | "machine";

interface NativeMutexModule {
  readonly apiVersion: number;
  createMutex(name: string, options?: { security?: "current-user" | "system-only" }): object;
  openMutex(name: string): object;
  acquire(handle: object, waitMs?: number): {
    readonly acquired: boolean;
    readonly abandoned: boolean;
    readonly waitResult: number;
  };
  release(handle: object): { readonly released: boolean };
  close(handle: object): void;
  state(handle: object): {
    readonly owned: boolean;
    readonly abandoned: boolean;
    readonly createdFresh: boolean;
    readonly ownerThreadId: number;
    readonly currentThreadId: number;
    readonly open: boolean;
  };
}

type NativeMutexHandle = object;

let nativeModule: NativeMutexModule | undefined;
let nativeLoadError: Error | undefined;

/**
 * Resolve the addon binary.
 *
 * Packaged: `<resources>/shelf-mutex/shelf_mutex.node` (extraResources, outside
 * `app.asar`, so no extraction and no rebuild on the user's machine).
 * Development: the node-gyp output directory.
 * Tests: `MAGINALIA_SHELF_MUTEX_PATH` overrides both.
 */
function nativeModuleCandidates(): readonly string[] {
  const candidates: string[] = [];
  const override = process.env["MAGINALIA_SHELF_MUTEX_PATH"];
  if (typeof override === "string" && override.length > 0) candidates.push(override);
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (typeof resources === "string" && resources.length > 0) {
    candidates.push(path.join(resources, "shelf-mutex", "shelf_mutex.node"));
  }
  const relative = path.join("native", "shelf-mutex", "build", "Release", "shelf_mutex.node");
  candidates.push(path.join(process.cwd(), relative));
  candidates.push(path.join(process.cwd(), "apps", "desktop", relative));
  // Compiled main-process code: dist/main -> apps/desktop.
  if (typeof __dirname === "string") candidates.push(path.join(__dirname, "..", "..", relative));
  return candidates;
}

/**
 * Load the addon once. A missing binary is reported as `native-mutex-unavailable`
 * rather than crashing the caller, so a build without a C++ toolchain can still run
 * the JavaScript suites and report this mechanism as NOT VERIFIED.
 */
export function loadNativeShelfMutex(): NativeMutexModule {
  if (nativeModule !== undefined) return nativeModule;
  if (nativeLoadError !== undefined) {
    fail("native-mutex-unavailable", "The Shelf mutex addon could not be loaded.", nativeLoadError.message);
  }
  const attempts: string[] = [];
  for (const candidate of nativeModuleCandidates()) {
    try {
      const loaded = requireNative(candidate) as NativeMutexModule;
      if (loaded === null || typeof loaded !== "object" || typeof loaded.acquire !== "function") {
        attempts.push(`${candidate}: not a Shelf mutex addon`);
        continue;
      }
      nativeModule = loaded;
      return loaded;
    } catch (error: unknown) {
      attempts.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  nativeLoadError = new Error(attempts.join("; "));
  fail("native-mutex-unavailable", "The Shelf mutex addon could not be loaded.", attempts.join("; "));
}

/** True when the addon binary is present and loads. Used by tests and diagnostics. */
export function nativeShelfMutexAvailable(): boolean {
  try {
    loadNativeShelfMutex();
    return true;
  } catch {
    return false;
  }
}

/**
 * Deterministic OS mutex name for one Shelf.
 *
 * The key is the Shelf folder-marker UUID (D068), so the name is stable across
 * machines and folder moves, and it is independent of any machine-local path.
 * Only a canonical UUID is accepted, which also makes name injection impossible.
 *
 * `session` (`Local\`) is the default: the Desktop app and the Collector Native
 * Host run in the same interactive session. `machine` (`Global\`) is available for
 * cross-session use, but creating a global object requires SeCreateGlobalPrivilege,
 * which a standard user normally does not hold.
 */
export function resolveShelfMutexName(shelfId: string, scope: ShelfMutexScope = "session"): string {
  if (typeof shelfId !== "string" || !UUID_PATTERN.test(shelfId)) {
    fail("native-mutex-invalid-name", "The Shelf identity is not a canonical UUID.");
  }
  const namespace = scope === "machine" ? "Global" : "Local";
  const name = `${namespace}\\${SHELF_MUTEX_NAME_PREFIX}${shelfId.toLowerCase()}`;
  if (name.length > 240) fail("native-mutex-invalid-name", "The mutex name is too long.");
  return name;
}

const handles = new Map<string, NativeMutexHandle>();
const heldNames = new Map<string, string>();

function handleFor(name: string): NativeMutexHandle {
  const existing = handles.get(name);
  if (existing !== undefined) return existing;
  const native = loadNativeShelfMutex();
  let handle: NativeMutexHandle;
  try {
    handle = native.createMutex(name);
  } catch (error: unknown) {
    throw translateNativeError(error, name);
  }
  handles.set(name, handle);
  return handle;
}

function translateNativeError(error: unknown, detail?: string): ShelfNativeMutexError {
  const code = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case "mutex-access-denied":
      return new ShelfNativeMutexError(
        "native-mutex-access-denied",
        "Another Windows user owns this Shelf write lock, or the lock denies access to this account.",
        detail
      );
    case "mutex-privilege-missing":
      return new ShelfNativeMutexError(
        "native-mutex-privilege-missing",
        "Creating a machine-wide Shelf write lock requires SeCreateGlobalPrivilege.",
        detail
      );
    case "mutex-thread-mismatch":
      return new ShelfNativeMutexError(
        "native-mutex-thread-mismatch",
        "A Shelf write lock must be released on the thread that acquired it.",
        detail
      );
    default:
      return new ShelfNativeMutexError("native-mutex-failed", message, detail);
  }
}

export interface AcquireShelfMutexOptions {
  readonly shelfId: string;
  readonly scope?: ShelfMutexScope;
  readonly acquireTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
}

export interface ShelfMutexLease {
  readonly shelfId: string;
  readonly name: string;
  readonly token: string;
  /** `true` when the previous owner died without releasing the lock. */
  readonly abandoned: boolean;
  readonly acquiredAt: number;
  release(): void;
  assertHeld(): Promise<void>;
  state(): { readonly owned: boolean; readonly ownerThreadId: number; readonly currentThreadId: number };
}

export const SHELF_MUTEX_ACQUIRE_TIMEOUT_MS = 15_000;
export const SHELF_MUTEX_POLL_INTERVAL_MS = 40;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * Acquire the Shelf write mutex by polling a zero-timeout kernel wait.
 *
 * Nothing here blocks: each attempt returns immediately, and the wait between
 * attempts is an ordinary timer, so an Electron main-process caller keeps running
 * its event loop (IPC, menus, window events) while another process holds the lock.
 */
export async function acquireShelfMutex(options: AcquireShelfMutexOptions): Promise<ShelfMutexLease> {
  const name = resolveShelfMutexName(options.shelfId, options.scope);
  const native = loadNativeShelfMutex();
  const now = options.now ?? (() => Date.now());
  const acquireTimeoutMs = options.acquireTimeoutMs ?? SHELF_MUTEX_ACQUIRE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? SHELF_MUTEX_POLL_INTERVAL_MS;

  if (heldNames.has(name)) {
    // The kernel mutex is recursive for the owning thread, so two async tasks in one
    // process would both "acquire" it. In-process exclusion stays in JavaScript.
    fail("shelf-write-busy", "This process already holds the Shelf write lock.", name);
  }

  const handle = handleFor(name);
  const deadline = now() + acquireTimeoutMs;
  for (;;) {
    const result = native.acquire(handle, 0);
    if (result.acquired) {
      const token = randomUUID();
      const acquiredAt = now();
      heldNames.set(name, token);
      return Object.freeze({
        shelfId: options.shelfId,
        name,
        token,
        abandoned: result.abandoned,
        acquiredAt,
        release(): void {
          if (heldNames.get(name) !== token) return;
          heldNames.delete(name);
          try {
            native.release(handle);
          } catch (error: unknown) {
            throw translateNativeError(error, name);
          }
        },
        async assertHeld(): Promise<void> {
          let state: ReturnType<NativeMutexModule["state"]>;
          try {
            state = native.state(handle);
          } catch (error: unknown) {
            throw translateNativeError(error, name);
          }
          if (!state.owned || state.ownerThreadId !== state.currentThreadId) {
            fail("shelf-write-lease-lost", "The Shelf write lock is no longer held by this writer.", name);
          }
        },
        state(): { owned: boolean; ownerThreadId: number; currentThreadId: number } {
          const state = native.state(handle);
          return Object.freeze({
            owned: state.owned,
            ownerThreadId: state.ownerThreadId,
            currentThreadId: state.currentThreadId
          });
        }
      });
    }
    if (now() >= deadline) {
      fail("shelf-write-busy", "Another process holds the Shelf write lock.", name);
    }
    await delay(pollIntervalMs);
  }
}

/**
 * Open the mutex object without acquiring it.
 *
 * A Windows mutex object is destroyed when its last handle closes, and a destroyed
 * object cannot be abandoned. A participant therefore keeps one handle open for the
 * whole time it may be involved in a Shelf — the Desktop app while it is running, the
 * Native Host while it is registered — so that another participant dying inside the
 * critical section is observable as `WAIT_ABANDONED` instead of looking like a fresh
 * mutex.
 *
 * The handle is cached like every other handle in this module, so calling this more
 * than once per name is free.
 */
export function openShelfMutexParticipant(
  shelfId: string,
  scope: ShelfMutexScope = "session"
): { readonly name: string } {
  const name = resolveShelfMutexName(shelfId, scope);
  handleFor(name);
  return Object.freeze({ name });
}

/** Close every cached handle (tests and orderly shutdown). */
export function closeShelfMutexHandles(): void {
  if (nativeModule === undefined) return;
  for (const [name, handle] of handles) {
    heldNames.delete(name);
    try {
      nativeModule.close(handle);
    } catch {
      // A handle this thread does not own is closed by the kernel on exit.
    }
  }
  handles.clear();
}

/** Diagnostics: the raw addon state for a lock name, without acquiring it. */
export function inspectShelfMutex(shelfId: string, scope: ShelfMutexScope = "session"): {
  readonly name: string;
  readonly owned: boolean;
  readonly abandoned: boolean;
  readonly createdFresh: boolean;
} {
  const name = resolveShelfMutexName(shelfId, scope);
  const native = loadNativeShelfMutex();
  const handle = handleFor(name);
  const state = native.state(handle);
  return Object.freeze({
    name,
    owned: state.owned,
    abandoned: state.abandoned,
    createdFresh: state.createdFresh
  });
}
