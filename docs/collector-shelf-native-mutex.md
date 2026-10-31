# Windows named-mutex Shelf write lock (OD-10 option b)

Status: **technical verification only (PoC)**. Not enabled in the product, not
reachable from the Desktop UI, and not reachable from the Collector Native Messaging
Host.

- Repository: `potoha/MAGINALIA_desktop`
- Parent branch: `dev0.2` @ `8d103a065319f6ecb08226bc7bed9e9deec65b5b` (verified exact)
- Work branch: `codex/collector-windows-native-mutex-spike`
- Product Owner decision: OD-10 selects the Windows OS-managed lock (option **b**);
  a named mutex is the first candidate; product integration only after acceptance.
- Related: Issue #80, PR #79 (merged), PR #81 (open, **not merged and not reused**),
  PR #82 (this branch)
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

The review follow-up recorded here adds three requirements on top of the first
mechanism proof:

1. recovery must not depend on abandonment: when the last handle dies with the last
   participant, the next process creates a brand-new mutex and must still verify the
   journal (§3.5);
2. a failed assessment followed by an ordinary process exit must not let a later
   process skip verification and write (§3.5, evidence 23);
3. a packaged build must load the addon only from the trusted `resources` directory,
   with environment/CWD loading confined to development and tests (§3.7, evidence 14
   and 24).

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

It is necessary but not sufficient. A destroyed mutex object (the usual case when the
Desktop is closed and the Host was the only process) reports nothing at all, so a
persistent recovery record supplies the missing signal (§3.5). The mutex remains the
exclusion authority; the record is only about "a write was in flight".

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
  disappears; a later writer then gets a fresh mutex and no abandonment signal. That is
  exactly why recovery cannot rely on abandonment: the durable `writer-recovery.json`
  record (§3.5) makes the next writer verify the journal even when the kernel has
  nothing to report. Neither mechanism asks a user or a clock to decide anything.

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

### 3.5 Recovery protocol (abandonment **and** a persistent record)

`WAIT_ABANDONED` already means the lock is available. It does **not** mean the Shelf
is sane, and it is not even always available: when the last handle dies with the last
process (Desktop closed, the Host alone and force-killed), the mutex object is
destroyed and the next process creates a brand-new one that reports nothing at all.

The mutex therefore cannot be the only recovery signal. Before the critical section the
writer durably creates `writer-recovery.json` in the Shelf's coordination directory
(`<coordination>/shelves/<uuid>/`, next to `requests/`, never inside it), and removes it
only after the receipt is committed:

| Trigger | Meaning |
| --- | --- |
| record absent, no abandonment | the previous native-lock write (if any) finished; no journal scan, so the normal path stays O(1) |
| record present | a write was in flight and did not finish, **whatever the mutex says** |
| `WAIT_ABANDONED` | verify even when the record is absent |

The record is opened, written and `sync`ed before the first journal write. A truncated or
unreadable record still counts as "pending": only the file being absent is treated as
clean. Its metadata (pid, request id, timestamp) is diagnostic, never authoritative.

The marker is also handled as a security boundary rather than an ordinary file:

- it is **never opened through its final path**. A private temp file is created in the
  same directory with `O_CREAT | O_EXCL` and published with `rename`, so a symlink or
  hardlink planted at the marker path is replaced as a directory entry and its target is
  never written through;
- an existing marker must be a regular file and not a reparse point. A symlink, junction,
  directory or device at that path fails closed (`shelf-write-recovery-state-unavailable`)
  instead of being followed, before anything is created;
- deletion checks the same way and uses `unlink`, which removes the entry itself and can
  neither follow a link nor remove a directory;
- the check is repeated immediately before the atomic replace. A directory or junction
  swapped in during the window makes the rename fail; a link swapped in can at worst be
  replaced, never written through;
- a crash during an update leaves either the previous complete marker or the new complete
  marker. The temp file is never read as evidence, so an interrupted update cannot
  downgrade a pending write to "clean". A crash before the marker is published happens
  before the first journal write, so treating it as clean is correct.

`assessShelfWriteRecoveryState` is read-only and fails closed:

1. re-resolve the Shelf layout — marker UUID, `library.json`, realpath containment,
   `dev`/`ino` fingerprints (a swapped or replaced Shelf fails closed);
2. strictly validate every journal record (`shelf-write-journal-invalid`);
3. every `committed` receipt must still match its Book and Annotation;
4. a `staged` record is acceptable only when the Annotation is absent (died before the
   commit point) or present with the recorded digest (died after it);
5. anything unprovable stops the write.

On a failed assessment the mutex is **kept held** and the process is expected to exit.
The recovery record is preserved exactly as it is — it is not rewritten, repaired or
deleted — so the next process verifies even when the lock is released cleanly. That
matters because `process.exit()` skips environment teardown: when a process simply
exits after a failure the finalizer may or may not run, and the record is what makes the
outcome identical either way. Neither journal records nor Annotation/Book files are ever
repaired or deleted by recovery.

| Observed state | Result |
| --- | --- |
| Mutex acquired normally, no record | write as usual |
| Record present (no abandonment), journal consistent | report `trigger: "pending-write"`, then write (retry completes the interrupted request) |
| `WAIT_ABANDONED`, no record, journal consistent | report `trigger: "abandoned"`, then write |
| Either trigger, damaged journal | `shelf-write-journal-invalid`, no write, record kept |
| Either trigger, receipt without its records | `shelf-write-receipt-missing`, no write, record kept |
| Either trigger, staged digest mismatch | `shelf-write-lease-uncertain`, no write, record kept |
| Either trigger, marker/identity mismatch | `shelf-write-identity-mismatch`, no write, record kept |
| Record cannot be created/read durably | `shelf-write-recovery-state-unavailable`, no write |

### 3.6 One writer implementation

`commitShelfQuote` gained one optional seam:

```ts
readonly externalLock?: { assertHeld(): Promise<void> };
```

When present, the file lease is not taken and the writer re-asserts the supplied lock
before each publish. There is still exactly one Shelf writer, one journal, and one set
of records. `src/shelf-native-write-lock.ts` only adds acquisition + recovery
reconciliation around it. Leaving `externalLock` undefined preserves the previous
behavior byte for byte, which is why the existing file-lease suite still passes
unchanged.

### 3.7 Addon loading policy

`src/shelf-native-mutex.ts` has one resolver, `resolveNativeAddonCandidates`, with two
modes:

| Mode | Condition | Candidates |
| --- | --- | --- |
| packaged | `process.resourcesPath` is set and `process.defaultApp !== true` | exactly `<resources>/shelf-mutex/shelf_mutex.node` |
| development | every other case (plain Node, `electron main.js`) | `MAGINALIA_SHELF_MUTEX_PATH`, then the `node-gyp` output under the cwd, then the compiled layout |

Packaged mode is a security boundary, not a convenience order:

- there is **no fallback list**: either the trusted file loads or the lock is
  unavailable (`native-mutex-unavailable`);
- the candidate must be inside `process.resourcesPath` after resolution
  (`isPathWithin`) and must be a regular file rather than a symlink (`lstatSync`);
- `MAGINALIA_SHELF_MUTEX_PATH`, the working directory and `__dirname` are ignored, so a
  shortcut, launcher, or stray environment variable cannot redirect the process to an
  arbitrary `.node` file.

A packaged Electron binary started with `ELECTRON_RUN_AS_NODE=1` is still "packaged"
(it has a `resources` directory), and is deliberately not treated as a development
bypass. The development smoke test therefore drives its second process with a plain
`node` binary.

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
| 9 | `process.exit` mid-write | `process.exit` skips environment teardown, so the mutex is usually left abandoned (or destroyed); the durable record was written before the critical section, the retry reconciles and commits once | **PASS** |
| 10 | Fail closed on bad journal | DAMAGED journal + abandonment → `shelf-write-journal-invalid`, no Book, no Annotation, journal untouched | **PASS** |
| 11 | Shelf-scoped separation | holding Shelf A does not block Shelf B | **PASS** |
| 12 | DACL enforcement | SYSTEM-only descriptor → second create `mutex-access-denied` | **PASS** |
| 13 | Electron compatibility | real Electron 44.3.0 main process loads the addon, acquires, blocks a separate Node process, releases and re-acquires | **PASS** |
| 14 | Installer packaging feasibility | `npm run spike:native-package` → `electron-builder --win dir --x64` places `resources/shelf-mutex/{shelf_mutex.node,shelf-native-mutex.js}`; addon loads in `ELECTRON_RUN_AS_NODE` and in the packaged Electron main process; the packaged wrapper resolves exactly one trusted candidate | **PASS** (dir package; full NSIS installer **NOT VERIFIED**, see §6) |
| 15 | No dev toolchain on user PCs | N-API binary, `/MT` static CRT; `dumpbin /dependents` → `KERNEL32.dll`, `ADVAPI32.dll`, delay-load `node.exe` only | **PASS** |
| 16 | Thread ownership contract | worker-thread test: another thread cannot acquire or release the main thread's lock (`mutex-not-owned`) | **PASS** |
| 17 | Whole Desktop unit suite | 926 passed, 1 failed (`src/tutorial-sample.test.ts`, pre-existing and unrelated), 1 skipped (file-symlink marker test, see 27) | **PASS (no new failures)** |
| 18 | Cross-session / `Global\` | creation succeeded here; standard-user privilege behavior unproven | **NOT VERIFIED** |
| 19 | Second Windows user denied | only provable through the DACL test above; no second account available | **NOT VERIFIED** |
| 20 | Real Chrome-terminated Native Host | Host `save` is out of scope and remains unsupported | **NOT VERIFIED** |
| 21 | Desktop absent, Host alone force-killed | no participant holds a handle, the mutex object is destroyed: the restart reports `createdFresh: true` / `abandoned: false`, the record reports `pending: true`, assessment runs, the staged request is completed | **PASS** |
| 22 | Malformed journal with a brand-new mutex | damaged journal + record + freshly created mutex (no abandonment possible) → `shelf-write-journal-invalid`; journal, Books and Annotations untouched | **PASS** |
| 23 | Failed assessment, clean release, retry | assessment fails → natural exit really releases the mutex (probe acquires with `abandoned: false`) → a later process still refuses to write because the record persists | **PASS** |
| 24 | Addon load policy | unit: packaged mode offers exactly one candidate and ignores env/cwd; containment rejects sibling and outside paths; development keeps the env override | **PASS** |
| 25 | C++ N-API buffer contract | `GetString`/`GetUtf8` allocate `length + 1` and pass the real capacity to N-API, so the terminator N-API writes stays in bounds | **PASS** |
| 26 | Marker update never writes through a link | hardlink at the marker path + `SENTINEL` file: write succeeds by replacing the directory entry, the sentinel keeps its bytes; no temp file remains after a completed write | **PASS** |
| 27 | Symlink marker refused, sentinel untouched | marker symlinked to an external `SENTINEL` file → `shelf-write-recovery-state-unavailable`, sentinel bytes unchanged; unit and real-child-process variants | **NOT VERIFIED** — the verification account cannot create file symlinks (`EPERM`); both variants skip with a diagnostic instead of passing silently |
| 28 | Junction / directory marker refused | junction to an external directory and a plain directory at the marker path → `shelf-write-recovery-state-unavailable`, target contents unchanged, nothing written (unit + real child process) | **PASS** |
| 29 | Interrupted marker update | a complete new marker left only as a temp file does not replace the pending state: recovery still reports the original interrupted request | **PASS** |

Reproduce:

```powershell
cd apps/desktop
npm run test:collector-shelf-native     # build:main + build:native + unit + real-process + Electron
npm run spike:native-package            # electron-builder dir package + two load probes
```

Test files:

- `src/shelf-native-mutex.test.ts` — 29 unit tests, 28 executed and 1 skipped when the
  account cannot create file symlinks (name derivation, in-process guard, thread
  ownership, DACL, native-lock commit, recovery-state record, recovery marker file
  safety, loader policy).
- `test/collector-shelf-native-lock.test.mjs` + `test/collector-shelf-native-worker.mjs`
  — 15 real-child-process tests, 14 executed and 1 skipped for the same symlink reason,
  including Desktop-absent/Host-only exit, a brand-new mutex over a malformed journal,
  a failed assessment followed by a clean release, and junction/symlink markers planted
  before the child starts.
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
  Node runtime and Electron and does not need rebuilding per Electron version;
- string arguments are decoded with an explicit `length + 1` buffer, so the NUL that
  N-API writes on `napi_get_value_string_utf16`/`utf8` stays inside the allocation
  (Unicode names and long paths are ordinary input, not a special case).

### 5.2 Where the binary goes

```jsonc
// apps/desktop/packaging/electron-builder.json  (change to make after acceptance)
"extraResources": [
  { "from": "native/shelf-mutex/prebuilt/win32-x64/shelf_mutex.node",
    "to": "shelf-mutex/shelf_mutex.node" },
  { "from": "dist/main/shelf-native-mutex.js",
    "to": "shelf-mutex/shelf-native-mutex.js" }
]
```

`extraResources` is used instead of `files` on purpose: the files stay **outside**
`app.asar`, so the addon can be loaded with `require` without extraction or a temp copy,
and the loader that decides what to load ships in the same trusted directory.

Loading policy implemented in `src/shelf-native-mutex.ts` (§3.7):

| Runtime | Candidates |
| --- | --- |
| packaged (`process.resourcesPath` set, `defaultApp !== true`) | **only** `<resources>/shelf-mutex/shelf_mutex.node`, containment-checked and `lstat`-checked; no env, cwd or `__dirname` input |
| development / test | `MAGINALIA_SHELF_MUTEX_PATH`, `<cwd>/native/shelf-mutex/build/Release/shelf_mutex.node`, `<cwd>/apps/desktop/...`, `<dist/main>/../../native/...` |

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
| `process.exit` while owning the lock | Node skips environment teardown, so the addon finalizer does not run and the mutex stays abandoned (or is destroyed with the process) until the next acquire. Harmless: acquisition succeeds immediately and the recovery record, not the mutex state, decides whether the journal is verified. |
| Recovery record deleted by hand | the audit trail for "a write was in flight" is a file like any other. If a user deletes the coordination directory, recovery falls back to request-ID idempotency: the interrupted request is still completed or refused by its own journal, never by a guess. |
| Recovery record present but stale | the record is only removed after a committed receipt, and a later successful write overwrites it before its own critical section. A stale record costs one journal scan and never permits an unverified write. |
| Marker file replaced by a link | the marker is published with a temp-file + `rename` and every create/update/delete is preceded by an `lstat` regular-file check, so a symlink, junction, hardlink or directory at that path fails closed instead of being written through. The file-symlink variant is **NOT VERIFIED** here: this Windows account cannot create file symlinks (`EPERM`), so that test skips with a diagnostic while the junction, directory and hardlink variants run. |
| Addon supply chain | a prebuilt `.node` is native code; CI provenance and signing belong to the packaging decision, not to this spike. In packaged mode the loader trusts exactly one path inside `resources`, but the integrity of that file is the packaging pipeline's responsibility. |
| Debugger/suspend | a suspended holder keeps the lock; the poll timeout reports `shelf-write-busy` rather than stealing it. |

Adoption conditions (proposed): keep the mutex machine-local and session-local,
open a participant handle when a Shelf is opened, run acquisition off any blocking
path, keep the recovery assessment mandatory whenever `WAIT_ABANDONED` or the persistent
record is observed, ship the addon and its loader only under `resources` (never load a
`.node` from cwd or an environment variable in packaged builds), and prove the installer
path (including a real Host `save`) before switching the product writer.

## 7. Files

Added:

- `apps/desktop/native/shelf-mutex/binding.gyp`, `apps/desktop/native/shelf-mutex/src/shelf_mutex.cc`
- `apps/desktop/src/shelf-native-mutex.ts` — name, handle cache, poll acquire, errors,
  participant handle, packaged/development loader policy
- `apps/desktop/src/shelf-native-write-lock.ts` — persistent recovery record, read-only
  recovery assessment, native-lock commit
- `apps/desktop/src/shelf-native-mutex.test.ts`
- `apps/desktop/test/collector-shelf-native-worker.mjs`, `apps/desktop/test/collector-shelf-native-lock.test.mjs`
- `apps/desktop/test/electron-native-lock-main.cjs`, `apps/desktop/test/electron-native-lock-smoke.test.mjs`
- `apps/desktop/packaging/native-mutex-spike/*`, `apps/desktop/scripts/spike-native-mutex-package.mjs`

Changed:

- `apps/desktop/src/shelf-write-coordination.ts` — optional `externalLock` seam (default
  behavior unchanged) and the `shelf-write-recovery-state-unavailable` error code
- `apps/desktop/tsconfig.main.json` — include the two new main-process modules
- `apps/desktop/package.json` — `build:native`, `test:collector-shelf-native`, `spike:native-package`, `node-gyp` devDependency
- `.gitignore` — `apps/desktop/native/shelf-mutex/build/`
- `package-lock.json` — one line for the declared `node-gyp`

Runtime data added by a native-lock write (in the Shelf's coordination directory, not in
a repository file): `<coordination>/shelves/<uuid>/writer-recovery.json`, present only
while a write is in flight.

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
- recovery never depends on abandonment alone: a durable `writer-recovery.json` record
  is written before the critical section and removed only after the receipt commits, so
  a destroyed mutex object, a recreated mutex, or a process exit cannot make the next
  writer assume the previous write finished;
- on either signal the writer re-validates the Shelf layout and the shared journal and
  fails closed rather than resuming when the state is unprovable; a failed assessment
  leaves the record in place, keeps the mutex held, and never repairs or deletes a
  journal record, Book or Annotation;
- the recovery record is a security boundary: it is published atomically from a private
  temp file and never opened through its final path, and a symlink, junction, hardlink or
  any other non-regular entry at that path fails the write closed instead of being
  followed, so marker maintenance can never affect an external file;
- packaged builds load the addon only from `<resources>/shelf-mutex/shelf_mutex.node`;
  environment variables, the working directory and `__dirname` are development/test
  inputs and must never select native code in an installed application;
- the mutex DACL grants only the creating user, SYSTEM and Administrators;
- a named mutex is machine-local: a Shelf on a network share is out of scope until a
  separate decision covers it.

Acceptance evidence: docs/collector-shelf-native-mutex.md §4 (Windows real-process
tests, Electron compatibility, packaging spike). Remaining before product integration:
full NSIS installer build, real Native Host `save`, second-Windows-user and
cross-session verification.
```
