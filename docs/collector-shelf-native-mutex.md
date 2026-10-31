# Windows named-mutex Shelf write lock (OD-10 option b)

Status: **technical verification only (PoC)**. Not enabled in the product, not
reachable from the Desktop UI, and not reachable from the Collector Native Messaging
Host.

- Repository: `potoha/MAGINALIA_desktop`
- Parent branch: `dev0.2` @ `8d103a065319f6ecb08226bc7bed9e9deec65b5b` (verified exact)
- Work branch: `codex/collector-windows-native-mutex-spike`
- Product Owner decision: OD-10 selects the Windows OS-managed lock (option **b**);
  a named mutex is the first candidate; product integration only after acceptance.
- Related: Issue #80, PR #79 (merged), PR #81 (open, **not merged and not reused**)
- Canonical sources consulted: `MAGINALIA_IDE/docs/decisions/0019-collector-native-messaging-host.md`
  (Accepted, D070 — "the locking/coordinator design and atomicity mechanism are not
  selected"), Shelf v0.4 contract (`MAGINALIA_IDE/docs/shelf-json-contract.md`,
  `spec/shelf-*.schema.json`), the current Desktop Shelf writer
  (`src/shelf-write-coordination.ts`), and `docs/collector-shelf-writer-coordination.md`
  (the file-lease design owned by the open PR #81).

## 1. Question this spike answers

Issue #80 requires Desktop and the Collector Native Host to write the **same**
Private Shelf exclusively, regardless of whether the Desktop UI is running, and to
survive abnormal termination without leaving a lock that blocks every later writer.

The open design question in D070 is the mechanism. This spike evaluates the Windows
OS-managed option: the exclusion authority is a kernel object, so ownership cannot
outlive a dead process and no reclamation or TTL heuristic is needed.

Non-goals, deliberately unchanged:

| Area | State in this branch |
| --- | --- |
| Native Host `save` | still `unsupported_operation`; no Host code path changed |
| Desktop product writer | still uses the file lease; `externalLock` is opt-in and unused by product code |
| Shelf JSON / journal formats | unchanged (v0.4 records, journal version 1) |
| Real user Shelf / IDE / Collector data | untouched; every test uses a temporary fixture |
| PR #81 | not merged, not rebased, not edited; the only shared file is `src/shelf-write-coordination.ts` |
| Installer / release | no release, no deploy; PR only |

## 2. Mechanism comparison

| Criterion | Windows named mutex (**chosen**) | `LockFileEx` on a byte range | Existing file lease (JS) |
| --- | --- | --- | --- |
| Release on process death | by the kernel, always | by the kernel, always | never; needs TTL + heartbeat |
| Stale-lock recovery | none needed | none needed | reclamation logic, clock-dependent |
| "Previous owner died inside the critical section" signal | yes — `WAIT_ABANDONED` | **no** (the byte range simply becomes free) | no |
| Thread affinity | owner thread must release | handle-based, no thread affinity | n/a |
| Cost per acquisition | one syscall | open + lock + unlock + close | several file operations + fsync |
| Works on a network share | **no** (kernel object is machine-local) | yes | yes |
| User-visible file left behind | no | yes (a lock file) | yes (`writer.lock`) |
| Access control | SDDL DACL on the kernel object | file ACL on the lock file | file ACL |

`WAIT_ABANDONED` is the decisive advantage: the mutex reports **that** the previous
holder died while owning the lock, which is exactly the signal needed to demand a
journal consistency check before writing again. `LockFileEx` cannot distinguish
"previous writer was killed mid-write" from "nobody ever held the lock".

The named mutex is machine-local by construction, so it is correct for a locally
stored Private Shelf and wrong for a Shelf on a network share. That limitation is
recorded as a residual risk, not hidden.

## 3. Design

### 3.1 Lock identity

```
Local\MAGINALIA.ShelfWrite.<shelf-uuid-lowercase>        (default, same session)
Global\MAGINALIA.ShelfWrite.<shelf-uuid-lowercase>       (scope: "machine", cross-session)
```

- The key is the Shelf folder-marker UUID (D068), not a path, so the name is stable
  across folder moves and machines and cannot encode a machine-local absolute path.
- Only a canonical UUID is accepted (`resolveShelfMutexName`), which also removes any
  name-injection surface.
- Shelf-scoped names mean one Shelf's writer never blocks another Shelf; this is
  proven by a real-process test.
- `Scope` is explicit. `Local\` covers the ordinary case (Desktop app + Native Host
  in one interactive session). `Global\` needs `SeCreateGlobalPrivilege`, which a
  standard user normally does not hold; global creation succeeded on the
  verification machine (elevated-ish developer context), standard-user behavior is
  **NOT VERIFIED**.

### 3.2 Thread and handle model

- Acquisition and release happen on the thread that calls them. The addon refuses
  `ReleaseMutex` from another thread (`mutex-thread-mismatch`) instead of leaving JS
  and the kernel disagreeing about ownership.
- Because a mutex is recursive **for the owning thread**, it cannot exclude two async
  tasks inside one process. In-process exclusion therefore stays in JavaScript
  (`heldNames`), which is the same guarantee the existing promise queue gives.
- Every participant keeps **one handle open for its process lifetime**
  (`openShelfMutexParticipant`). A Windows mutex object is destroyed when its last
  handle closes, and a destroyed object cannot be abandoned. The handle cache exists
  for exactly this reason.
- Consequence, documented honestly: if *every* process closes its handle, the object
  disappears; a later writer then gets a fresh mutex and no abandonment signal. That
  is safe — with no participant alive there is no competing writer, and an
  interrupted request is still completed by the existing request-ID idempotency. It
  does mean abandonment-based journal assessment only applies while a participant
  (Desktop or Host) is running, which is the case in every realistic scenario.

### 3.3 Never blocking the Electron main thread

Acquisition is polled, not parked:

```ts
native.acquire(handle, 0)                 // zero-timeout kernel wait
→ if not acquired: await delay(40)        // ordinary timer, event loop stays live
→ until acquireTimeoutMs (default 15 s)
```

No call into the kernel ever blocks for more than one syscall, so IPC, window events
and menus keep running while another process holds the lock. The spike still performs
acquisition on the main thread because that is where the Shelf writer runs today; a
worker-thread host would be a follow-up decision (a worker cannot release a lock the
main thread owns, so ownership must move with the work).

### 3.4 Access control

The mutex is created with an explicit SDDL DACL:

```
D:(A;;0x1F0001;;;SY)(A;;0x1F0001;;;BA)(A;;0x1F0001;;;<current user SID>)
```

Only SYSTEM, local Administrators, and the creating user may open it. Another Windows
user therefore receives `ERROR_ACCESS_DENIED`, surfaced as `mutex-access-denied`.
A test-only `security: "system-only"` descriptor proves the DACL is enforced (the
creating account itself is not granted access and a second create is refused).

True cross-account verification (a second Windows user) is **NOT VERIFIED**: no
second account was available on the verification machine.

### 3.5 Abandonment protocol

`WAIT_ABANDONED` already means the lock is available. It does **not** mean the Shelf
is sane. The writer therefore runs `assessShelfWriteStateAfterAbandon` before touching
anything:

1. re-resolve the Shelf layout — marker UUID, `library.json`, realpath containment,
   `dev`/`ino` fingerprints (a swapped or replaced Shelf fails closed);
2. strictly validate every journal record (`shelf-write-journal-invalid`);
3. every `committed` receipt must still match its Book and Annotation;
4. a `staged` record is acceptable only when the Annotation is absent (died before the
   commit point) or present with the recorded digest (died after it);
5. anything unprovable stops the write.

On a failed assessment the mutex is **deliberately kept held** and the process is
expected to exit. Releasing it would consume the abandonment signal, and the next
writer would treat the mutex as healthy even though the Shelf state was never proven.
The next process re-runs the assessment.

| Observed state | Result |
| --- | --- |
| Mutex acquired normally | write as usual |
| `WAIT_ABANDONED`, journal consistent | record interrupted/committed requests, then write (retry completes the interrupted request) |
| `WAIT_ABANDONED`, damaged journal | `shelf-write-journal-invalid`, no write |
| `WAIT_ABANDONED`, receipt without its records | `shelf-write-receipt-missing`, no write |
| `WAIT_ABANDONED`, staged digest mismatch | `shelf-write-lease-uncertain`, no write |
| `WAIT_ABANDONED`, marker/identity mismatch | `shelf-write-identity-mismatch`, no write |

### 3.6 One writer implementation

`commitShelfQuote` gained one optional seam:

```ts
readonly externalLock?: { assertHeld(): Promise<void> };
```

When present, the file lease is not taken and the writer re-asserts the supplied lock
before each publish. There is still exactly one Shelf writer, one journal, and one set
of records. `src/shelf-native-write-lock.ts` only adds acquisition + abandonment
reconciliation around it. Leaving `externalLock` undefined preserves the previous
behavior byte for byte, which is why the existing file-lease suite still passes
unchanged.

## 4. Verification

All commands run on Windows 10.0.26300, Node v24.14.0, Electron 44.3.0, MSVC 14.51
(VS 18 BuildTools), Windows SDK 10.0.26100.

| # | Acceptance area | Evidence | Result |
| --- | --- | --- | --- |
| 1 | Addon builds and exports the API | `npm run build:native` → `shelf_mutex.node`; `apiVersion === 1` | **PASS** |
| 2 | Deterministic per-Shelf name | unit test: same UUID → same name, case-insensitive, different UUID → different name, non-UUID rejected | **PASS** |
| 3 | Cross-process exclusion | 4 processes × 20 read-modify-writes on one counter → 80 (no lost update) | **PASS** |
| 4 | Concurrent Shelf writes | 6 processes → 1 Book, 6 Annotations, unique IDs, v0.4 valid | **PASS** |
| 5 | Same request ID resent concurrently | 4 processes → exactly 1 Annotation (`committed` + 3 × `already-committed`) | **PASS** |
| 6 | Live holder not displaceable | holder keeps the lock; contender times out with `shelf-write-busy` after really waiting; holder still owns it | **PASS** |
| 7 | Force-kill → abandonment | `TerminateProcess` on the holder; next writer gets `WAIT_ABANDONED` (128) immediately | **PASS** |
| 8 | Mid-write crash recovery | holder killed after Book publish → staged journal + abandonment → retry reconciles, commits once | **PASS** |
| 9 | Orderly crash is not abandonment | `process.exit` mid-write → no abandonment (finalizers release), retry completes the staged request | **PASS** |
| 10 | Fail closed on bad journal | DAMAGED journal + abandonment → `shelf-write-journal-invalid`, no Book, no Annotation, journal untouched | **PASS** |
| 11 | Shelf-scoped separation | holding Shelf A does not block Shelf B | **PASS** |
| 12 | DACL enforcement | SYSTEM-only descriptor → second create `mutex-access-denied` | **PASS** |
| 13 | Electron compatibility | real Electron 44.3.0 main process loads the addon, acquires, blocks a separate Node process, releases and re-acquires | **PASS** |
| 14 | Installer packaging feasibility | `npm run spike:native-package` → `electron-builder --win dir --x64` places `resources/shelf-mutex/shelf_mutex.node`; loads in `ELECTRON_RUN_AS_NODE` and in the packaged Electron main process | **PASS** (dir package; full NSIS installer **NOT VERIFIED**, see §6) |
| 15 | No dev toolchain on user PCs | N-API binary, `/MT` static CRT; `dumpbin /dependents` → `KERNEL32.dll`, `ADVAPI32.dll`, delay-load `node.exe` only | **PASS** |
| 16 | Thread ownership contract | worker-thread test: another thread cannot acquire or release the main thread's lock (`mutex-not-owned`) | **PASS** |
| 17 | Whole Desktop unit suite | 913 passed, 1 failed (`src/tutorial-sample.test.ts`, pre-existing and unrelated) | **PASS (no new failures)** |
| 18 | Cross-session / `Global\` | creation succeeded here; standard-user privilege behavior unproven | **NOT VERIFIED** |
| 19 | Second Windows user denied | only provable through the DACL test above; no second account available | **NOT VERIFIED** |
| 20 | Real Chrome-terminated Native Host | Host `save` is out of scope and remains unsupported | **NOT VERIFIED** |

Reproduce:

```powershell
cd apps/desktop
npm run test:collector-shelf-native     # build:main + build:native + unit + real-process + Electron
npm run spike:native-package            # electron-builder dir package + two load probes
```

Test files:

- `src/shelf-native-mutex.test.ts` — 15 unit tests (name derivation, in-process guard,
  thread ownership, DACL, native-lock commit, abandonment assessment cases).
- `test/collector-shelf-native-lock.test.mjs` + `test/collector-shelf-native-worker.mjs`
  — 10 real-child-process tests.
- `test/electron-native-lock-smoke.test.mjs` + `test/electron-native-lock-main.cjs`
  — real Electron main process.

## 5. Packaging and distribution

### 5.1 What the user's PC needs

Nothing beyond the installed application. Specifically **no** Node.js, Python, Visual
Studio, Windows SDK, `node-gyp`, or VC++ redistributable:

- the addon is a **prebuilt** binary — it is compiled once, in CI, on a build machine;
- it is built with the **static CRT** (`RuntimeLibrary: "0"` = `/MT`), proven by
  `dumpbin /dependents`: `KERNEL32.dll` + `ADVAPI32.dll` (both OS components) and a
  delay-load reference to `node.exe` (resolved inside the host process). No
  `VCRUNTIME140.dll` / `MSVCP140.dll` dependency exists, so no redistributable is
  installed or required;
- it uses **N-API** (`NAPI_VERSION 8`), so one binary is ABI-compatible with both the
  Node runtime and Electron and does not need rebuilding per Electron version.

### 5.2 Where the binary goes

```jsonc
// apps/desktop/packaging/electron-builder.json  (change to make after acceptance)
"extraResources": [
  { "from": "native/shelf-mutex/prebuilt/win32-x64/shelf_mutex.node",
    "to": "shelf-mutex/shelf_mutex.node" }
]
```

`extraResources` is used instead of `files` on purpose: the file stays **outside**
`app.asar`, so it can be loaded with `require` without extraction or a temp copy.

Resolution order implemented in `src/shelf-native-mutex.ts`:

1. `MAGINALIA_SHELF_MUTEX_PATH` (tests / diagnostics only),
2. `<process.resourcesPath>/shelf-mutex/shelf_mutex.node` (packaged),
3. `<cwd>/native/shelf-mutex/build/Release/shelf_mutex.node` and
   `<cwd>/apps/desktop/...` (development, `node-gyp` output),
4. `<dist/main>/../../native/...` (compiled main-process layout).

A missing or unloadable binary raises `native-mutex-unavailable` instead of crashing,
so a checkout without a C++ toolchain can still run every JavaScript suite and report
this mechanism as NOT VERIFIED.

### 5.3 Why the spike uses a `dir` package

`npm run dist:windows` needs `apps/desktop/packaging/runtime/` (Reviewer sidecar,
pandoc, OCR runtime). That directory does not exist in this repository, and producing
it is outside this task. The spike therefore builds a **production-shaped**
`electron-builder --win dir --x64` package with the same `extraResources` mechanism
and local Electron distribution, then proves both load paths from `win-unpacked`.
The NSIS installer only wraps this tree, so the placement proven here is the placement
an installer would ship; the full installer itself is **NOT VERIFIED**.

### 5.4 CI shape (proposed, not implemented)

1. Windows runner with VS Build Tools → `npm run build:native`;
2. copy `native/shelf-mutex/build/Release/shelf_mutex.node` to
   `native/shelf-mutex/prebuilt/win32-x64/`;
3. `npm run spike:native-package` (or the equivalent probe) as a packaging gate;
4. `electron-builder` → NSIS with the `extraResources` entry above;
5. the prebuilt binary is produced per architecture; a `win32-arm64` build needs its
   own artefact (not built here).

## 6. Residual risks and adoption conditions

| Risk | Assessment |
| --- | --- |
| Shelf on a network share | named mutexes are machine-local; requires a different mechanism (file lease or a server-side lock). Must be detected before adoption. |
| Cross-session Desktop/Host | `Local\` requires the same interactive session; a service/session-0 host would need `Global\` + privilege or a different design. |
| Multi-user machine | DACL denies other users, which is intended, but the second-account behavior is unproven. |
| Worker-thread hosting | ownership is thread-bound; moving the writer to a worker thread requires acquisition there too. |
| Orphaned journal from a pre-mutex crash | not abandonment-visible; still completed by request-ID idempotency, not by assessment. |
| Debugger/suspend | a suspended holder keeps the lock; the poll timeout reports `shelf-write-busy` rather than stealing it. |
| Addon supply chain | a prebuilt `.node` is native code; CI provenance and signing belong to the packaging decision, not to this spike. |

Adoption conditions (proposed): keep the mutex machine-local and session-local,
open a participant handle when a Shelf is opened, run acquisition off any blocking
path, keep the abandonment assessment mandatory in the write path, and prove the
installer path (including a real Host `save`) before switching the product writer.

## 7. Files

Added:

- `apps/desktop/native/shelf-mutex/binding.gyp`, `apps/desktop/native/shelf-mutex/src/shelf_mutex.cc`
- `apps/desktop/src/shelf-native-mutex.ts` — name, handle cache, poll acquire, errors, participant handle
- `apps/desktop/src/shelf-native-write-lock.ts` — abandonment assessment + native-lock commit
- `apps/desktop/src/shelf-native-mutex.test.ts`
- `apps/desktop/test/collector-shelf-native-worker.mjs`, `apps/desktop/test/collector-shelf-native-lock.test.mjs`
- `apps/desktop/test/electron-native-lock-main.cjs`, `apps/desktop/test/electron-native-lock-smoke.test.mjs`
- `apps/desktop/packaging/native-mutex-spike/*`, `apps/desktop/scripts/spike-native-mutex-package.mjs`

Changed:

- `apps/desktop/src/shelf-write-coordination.ts` — optional `externalLock` seam (default behavior unchanged)
- `apps/desktop/tsconfig.main.json` — include the two new main-process modules
- `apps/desktop/package.json` — `build:native`, `test:collector-shelf-native`, `spike:native-package`, `node-gyp` devDependency
- `.gitignore` — `apps/desktop/native/shelf-mutex/build/`
- `package-lock.json` — one line for the declared `node-gyp`

Not changed: Native Host, product Shelf writer behavior, Shelf/journal formats,
Reviewer sidecar, `docs/collector-shelf-writer-coordination.md` (owned by PR #81),
`MAGINALIA_IDE`.

## 8. Canonical plan write-back (required after merge, not performed here)

`MAGINALIA_IDE` is out of scope for this task, so the specification change is recorded
here for the accepting PR instead of being written to the canonical source:

```markdown
### OD-10 — Cross-process Private Shelf write lock

Decision: the cross-process lock is a Windows OS-managed kernel lock, not a
cooperative file lease. The first candidate mechanism is a named mutex keyed by the
Shelf folder-marker UUID:

  Local\MAGINALIA.ShelfWrite.<shelf-uuid>    (same interactive session, default)
  Global\MAGINALIA.ShelfWrite.<shelf-uuid>   (cross-session, requires SeCreateGlobalPrivilege)

Status: mechanism proven by technical verification (Issue #80 spike); product
integration NOT yet enabled. The Desktop writer and the Native Host still use the
existing file lease / unsupported `save` respectively.

Invariants:
- acquisition is non-blocking and polled, so the Electron main thread is never parked;
- ownership is thread-scoped, and in-process exclusion remains a JS guard;
- a participant keeps one handle open for its process lifetime so that
  WAIT_ABANDONED remains observable;
- on WAIT_ABANDONED the writer re-validates the Shelf layout and the shared journal
  and fails closed rather than resuming when the state is unprovable;
- the mutex DACL grants only the creating user, SYSTEM and Administrators;
- a named mutex is machine-local: a Shelf on a network share is out of scope until a
  separate decision covers it.

Acceptance evidence: docs/collector-shelf-native-mutex.md §4 (Windows real-process
tests, Electron compatibility, packaging spike). Remaining before product integration:
full NSIS installer build, real Native Host `save`, second-Windows-user and
cross-session verification.
```
