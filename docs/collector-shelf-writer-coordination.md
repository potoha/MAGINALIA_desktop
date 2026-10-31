# Cross-process Private Shelf writer foundation

Status: **design + technical verification (PoC)**. Not enabled in the product and
not reachable from the Native Messaging Host.

- Repository: `potoha/MAGINALIA_desktop`
- Parent branch: `dev0.2` @ `8d103a065319f6ecb08226bc7bed9e9deec65b5b` (verified exact; the merge of PR #79)
- Work branch: `codex/collector-shelf-lease-safety`
- Issue: Desktop Issue #80 — cross-process lease acquire / reclaim / release races
- Canonical sources consulted: `MAGINALIA_IDE/docs/decisions/0019-collector-native-messaging-host.md`
  (Accepted, D070 — the locking mechanism is explicitly unselected),
  `MAGINALIA_IDE/docs/shelf-json-contract.md` (v0.4), `MAGINALIA_IDE/spec/shelf-*.schema.json`,
  `MAGINALIA_IDE/plan/30_MAGINALIA_COLLECTOR_REQUIREMENTS.md`.

## 1. Problem

ADR 0019 / D070 accept the Collector → Native Messaging Host → Private Shelf boundary but state that
"the locking/coordinator design and atomicity mechanism are not selected" and that the current Desktop
write queue is **process-local**. Issue #9 requires: stable-ID path resolution, existing Book reuse
with multiple Annotations, a unique request ID with duplicate/concurrent-write control, no
partial/duplicate/corrupt records on interruption, and "saved" only after the write is complete.

Two OS processes can address the same configured Shelf:

| Process | Writer today | Process-local protection |
| --- | --- | --- |
| Desktop main | `reviewer-shelf-materializer.ts` (`materializeReviewerRecords`) | module promise queue only |
| Native host | none (`save` is `unsupported_operation`) | n/a |
| First-run / tutorial seed | `tutorial-seed.ts`, `first-run-setup.ts` | exclusive `wx` per file |
| Generic repository creation | `repository-service.ts` | exclusive `wx` per file |

PR #79 built the shared foundation (lease, journal, receipt, single commit point) but its lease still
contained **check-then-act windows**: after observing a stale lock it renamed the file, so a writer that
acquired a new lock in that window could have its lease moved; and `release()` unlinked after a token
comparison, so a lock replaced in that window could be deleted. Issue #80 asks for those windows to be
closed, or for automatic reclamation to be withdrawn and replaced by an explicit, fail-closed recovery.

## 2. What exists already (verified by inspection)

- **Shelf v0.4 validation**: `@maginalia/format` `validateShelfEntity` / `parseShelfEntity`, strict
  `additionalProperties: false` schemas vendored in `spec/`.
- **No-replace publication**: `writeNoReplace` (temp file + hard link; `EEXIST` → byte compare).
- **Book reuse**: `matchingBook` / `booksAreCompatible` (kind + ISBN + URL + source-file digests;
  more than one overlapping Book is a conflict, not a guess).
- **Path safety**: `ensureDirectory` rejects symlinks and out-of-root realpaths per segment;
  `assertSafeRoot`, `inspectFolderMarkers` (typed `*.magi`, conflict detection).
- **Reviewer idempotency**: alias + content digest stored in `deviceMetadata.maginaliaReviewer`.

## 3. Exclusion mechanism: comparison and adopted option

### 3.1 What Windows + Node can actually guarantee

The hard requirement is: **a live holder is never displaced, not even for one syscall.** Taking a lease
away from another process therefore needs an atomic "remove/rename this name *only if* it still refers
to the file I observed". The comparable primitives on Windows 11 for a Node/Electron process are:

| Mechanism | Atomic acquisition | Atomic *release of someone else's* lock | Live holder can be displaced | Runtime/packaging cost |
| --- | --- | --- | --- | --- |
| File created with `wx` + automatic reap of a dead PID (PR #79 PoC) | yes (`O_EXCL`) | **no** — observe → rename is a two-step window | **yes**, briefly | none |
| File created with `wx`, **no** automatic reclamation, explicit recovery (adopted) | yes | n/a — no write-path code removes a foreign lock | **no** (structurally) | none; operator step after a crash |
| OS mutex / exclusive file handle (`CreateMutexW`, `CreateFile` with `FILE_SHARE_NONE`) via native addon | yes | kernel releases it on process death | no | native module per platform/arch, Electron ABI rebuild, packaging + signing |
| Single-writer broker (one process owns the Shelf; others RPC) | yes | broker decides | no | new cross-process write contract; broker liveness dependency |
| Lock **directory** (`mkdir`) instead of a file | yes (atomic) | **no** — same two-step window as `wx` | **yes**, briefly | none |
| mtime/heartbeat staleness (`proper-lockfile`-style) | yes | n/a — it deletes by age | **yes**, a slow-but-alive holder is evicted by design | none |

Facts behind that table, verified for this slice:

- libuv opens files with `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE`, and Node exposes no
  sharing-mode or `DeleteFile`-with-precondition API, so an exclusive OS handle is **not** reachable
  without a native addon.
- `rename()` and `unlink()` have no "if the file is still the one I observed" form. File identity
  (`dev`/`ino`) can be *checked*, but only before the call, so any takeover keeps a residual window.
- `mkdir` is atomic but has exactly the same removal problem as `wx`.

Consequences:

- The previous PR #79 mechanism (row 1) cannot satisfy the invariant: it is a timing argument, not a
  structural one, and Issue #80 reproduced the window with a deterministic seam.
- The heartbeat/age mechanism (row 6) contradicts the invariant outright: it evicts a healthy but slow
  writer, which is exactly the failure mode a lease must prevent.
- An OS mutex (row 3) is the only mechanism that both satisfies the invariant **and** needs no recovery
  step, because the kernel drops the lock when the holder dies. It was not adopted here: it adds a
  native dependency, an Electron ABI/packaging/ signing obligation, and a machine-wide (not
  Shelf-scoped) name that has to be derived and sanitized. That is a product/packaging decision, not a
  PoC implementation detail — see OD-10.

**Adopted for this slice: nothing on the write path removes a lock it did not create.** A dead holder's
lease is reported (`shelf-write-lease-stale`) with the exact holder identity, and is removed only by an
explicit recovery call that re-proves the holder is dead and the token is the observed one.

### 3.2 One lease model (acquire / hold / release / recover)

- Lease path: `<coordinationRoot>/shelves/<shelf-uuid>/writer.lock`. The key is the **marker UUID
  (D068)**, not a machine path, so a moved or renamed Shelf folder keeps the same exclusion domain, and
  no coordination state becomes user data or a second source of truth.
- **Acquire** is a single `open(..., "wx")` plus `fsync`. Creation itself is the atomic compare-and-set;
  a lease is never created twice, upgraded, or overwritten. Contenders back off with bounded jitter and
  either take the free lock or fail with a bounded outcome — never with a silent skip.
- **Hold**: a live holder keeps its lease no matter how old its heartbeat is. Staleness is *not* a theft
  threshold. `assertHeld()` runs immediately before the Book publish and again before the commit point,
  so a writer that somehow lost its lease cannot publish.
- **Release** is a verified retire, not a delete:
  1. the caller's lock is renamed to a private `writer.lock.<uuid>.retire` name;
  2. **then** the moved file is read and its token compared with the caller's token;
  3. only an equal token is unlinked.
  The delete decision is taken on a file no other process can have replaced, so a lock that was replaced
  in the window is restored with `link()` and left byte-identical. If restoration is impossible the
  outcome is `uncertain` and nothing is deleted.
- **Recover** (`reclaimStaleShelfWriteLease`, explicit only) re-observes the lock, requires the caller to
  name the exact token it saw, requires the holder PID to be provably dead, and then retires the lock
  with the same verified-rename routine. It is safe against a concurrent acquirer and against a
  concurrent recoverer:
  - a lock that was already reclaimed and re-acquired has a different token, so it is refused;
  - a second recoverer either observes no lock (`reclaimed: false`, nothing removed) or loses the rename
    and fails closed with `shelf-write-lease-uncertain`;
  - a live PID is refused, including the PID-reuse case where an old lock's PID belongs to a new live
    process.
- **Unprovable states fail closed.** Malformed/unreadable lock, live-but-stale heartbeat, token
  mismatch, or a lost race during recovery all produce `shelf-write-lease-uncertain` and touch nothing.

### 3.3 Commit order and the single commit point

```text
lease
 └─ journal "staged"        (generated Book/Annotation IDs + content digest, fsynced)
     ├─ assets              (add-only, sha256-verified)     … Reviewer path only
     ├─ Book                (add-only, reused when compatible)
     ├─ [commit point] Annotation
     └─ journal "committed" (the receipt, fsynced)
```

The Annotation is the only file whose presence means "the quote exists". Assets and Book are add-only
preludes that a retry reuses or re-publishes byte-identically ("same"). There is therefore nothing to
roll back: an interruption leaves at worst a reusable Book, and the retry completes the same request.

### 3.4 Idempotency and receipts

- Journal: `<coordinationRoot>/shelves/<uuid>/requests/<requestId>.json`, written temp → `fsync` → rename.
- `requestDigest` = sha256 of the request **content without generated IDs**, so it is stable across
  retries while IDs may differ per attempt. Every input that changes the persisted bytes is part of it,
  **including the `commentField` selector**: the same text stored in `comment` or in `privateMemo` is
  different content, so it is detected as a mismatch rather than accepted as a retry.
- Same request ID + same digest → `already-committed` receipt, no write, no rewrite (asserted by
  comparing file bytes across processes).
- Same request ID + different digest → `shelf-write-request-mismatch` (writes nothing).
- `staged` + Annotation already on disk with the recorded digest → receipt is completed without
  re-publishing.
- `committed` receipt whose Book **or** Annotation is missing or changed → `shelf-write-receipt-missing`
  (fail closed rather than "re-saving" over user data).
- The journal stores IDs, digests, timestamps and writer PID only — **no quote text, URL, title or
  comment**, so it is not a second copy of user data.
- A crash between Book and Annotation leaves a `staged` record and a stale lease. The retry **does not**
  take the lease: it reports `shelf-write-lease-stale`. After one explicit reclaim, the retry reuses the
  staged Annotation ID and commits exactly once.

#### Journal records are untrusted input

A journal is read back from disk after a crash, so it can be truncated, hand-edited, or copied from
another Shelf. Reading is therefore a strict validation, not a parse:

- the file must be a regular, non-symlink file under 8 KiB;
- the record's `requestId` must equal its own file name, and `shelfId` must equal the Shelf that is
  actually open (a record from another Shelf is refused);
- every ID (`shelfId`, `requestId`, `bookId`, `annotationId`) must match its canonical pattern **before**
  it is used to build any path, so a record can never point inside `requests/` at a traversal path or
  outside the Book/Annotation directories;
- `requestDigest` and `annotationDigest` must be `sha256:<64 hex>`; unknown top-level and `writer` keys
  are rejected; timestamps must be ISO-8601 UTC;
- `state` must be internally consistent: `committed` requires `committedAt` and a complete Annotation
  digest, `aborted` requires `abortedReason`, and a non-aborted record may not carry an abort reason.

Any deviation fails closed with `shelf-write-journal-invalid`.

### 3.5 Windows path, junction and path-swap defence

At resolve time: `assertSafeRoot` (rejects a symlinked root) → marker inspection (missing/conflicting/
mismatched marker fails closed, never adopted or created) → `library.json` directories confined to the
root → per-segment `lstat` + `realpath` containment → fingerprint of `{realpath, dev, ino}` for the
root, `books/` and `annotations/`.

At the commit point (immediately before the Annotation publish, and again before the Book publish):
`assertShelfWriteLayoutCurrent` re-derives the same fingerprints. A junction/symlink substitution
changes `lstat` to a link; a moved/renamed directory changes the realpath; a re-created directory
changes `dev`/`ino`. Any difference is `shelf-write-unsafe-path` and nothing is written.

The coordination root may not overlap the Shelf in either direction, so coordination state can never
be committed as Shelf user data. The overlap check runs **before any directory is created**: the
`library.json` directories are resolved read-only, the not-yet-existing coordination root is
canonicalized through its deepest existing ancestor (so a junction in the parent chain is still
honoured), the overlap is rejected there, and only afterwards is the directory created and re-checked
against its realpath.

Residual risk (not hidden): the window between the last fingerprint check and `link()` is a TOCTOU
window. It is narrowed to a single syscall but not eliminated; eliminating it needs a directory handle
or handle-relative publish primitive that Node does not provide portably.

### 3.6 Shelf v0.4 compatibility

Produced records are validated with `@maginalia/format` **before** the journal is written and again by
the tests from the bytes on disk: `type`, `version: "0.4"`, `id` patterns
(`book:<Crockford ULID>` / `ann:<Crockford ULID>`), `source.kind = "website"`, `source.id` → Book,
`get.date = YYYYMMDDHHMM`, non-empty `quote`, optional `comment`. No field outside the strict v0.4
schema is added.

### 3.7 Error codes and recovery surface

| Code | Meaning |
| --- | --- |
| `shelf-write-invalid-request` | Caller input is not a valid request (IDs, URL, get.date, comment, recovery token) |
| `shelf-write-unsafe-path` | Layout, record directory or coordination root is unsafe or changed |
| `shelf-write-shelf-unavailable` | Configured Shelf root is unavailable |
| `shelf-write-identity-unavailable` / `-conflict` / `-mismatch` | Marker missing, conflicting, or not the expected Shelf |
| `shelf-write-layout-invalid` | `library.json` directories are not resolvable/writable |
| `shelf-write-busy` | A live, healthy holder kept the lease for the whole acquire window |
| `shelf-write-lease-lost` | This writer's token is no longer the lock's token |
| `shelf-write-lease-stale` | The lease holder is **provably dead**; explicit recovery is required |
| `shelf-write-lease-uncertain` | Unprovable state (live-but-unproven holder, malformed lock, or a lost race during recovery) — fail closed |
| `shelf-write-journal-unavailable` | Journal/lease filesystem operation failed |
| `shelf-write-journal-invalid` | A journal record is malformed, foreign, or internally inconsistent |
| `shelf-write-request-mismatch` | Same request ID, different content (digest, incl. comment field) |
| `shelf-write-book-conflict` | The source URL matches incompatible Books |
| `shelf-write-record-conflict` | A different record already occupies the planned filename |
| `shelf-write-receipt-missing` | A committed receipt's Book or Annotation is missing/changed |

`shelf-write-lease-stale` and `shelf-write-lease-uncertain` carry an optional `context` object with
`{ token, pid, processLabel, acquiredAt, heartbeatAt }` — coordination metadata only, never user
content. That is what a recovery UI needs to name the stuck lock, and it is what the recovery call
requires as `expectedToken`.

### 3.8 Recovery procedure (the operational cost of the adopted option)

Automatic reclamation does not exist. A crashed or killed writer therefore blocks new saves until one
explicit recovery runs:

1. The writer fails with `shelf-write-lease-stale`, showing the holder label (for example
   `collector-native-host`) and PID from `context`.
2. The user-facing surface offers "recover the Shelf write lock". A product surface must not
   auto-reclaim silently, and must not offer this while a writer is mid-save.
3. The surface calls
   `reclaimStaleShelfWriteLease({ coordinationRoot, shelfId, expectedToken })` with the token from the
   failure context. A token from a stale screen is refused (`shelf-write-lease-uncertain`), so an old
   dialog cannot remove a newer holder.
4. Recovery succeeds only if the holder PID is still dead and the lock still has that token. It returns
   the retired holder for the log.
5. The save is retried by the normal path; the journal replays `staged` → `committed` exactly once.

If the failure is `shelf-write-lease-uncertain`, the recovery call is deliberately unavailable. The only
remedy is the documented operator action of deleting
`<coordinationRoot>/shelves/<shelf-uuid>/writer.lock` after confirming no MAGINALIA process is running.
No code path performs that deletion, because the state is not provable.

Under the adopted model the *only* debris a crash can leave is the dead lock itself plus, if `unlink`
failed during a retire, a `writer.lock.<uuid>.retire` file. Retire debris is inert (the real lock path is
free) and is reported by inspection rather than silently cleaned.

## 4. Verification

All commands run in the worktree at the result commit. Fixtures are created in the OS temporary
directory (`Private Shelf 本棚` / `coordination`), removed afterwards; no real Shelf,
`Documents/MAGINALIA`, `shelf_location.yml`, IDE or Collector repository is touched.

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | Main-process typecheck | `apps/desktop: npx tsc -p tsconfig.main.json --noEmit` | PASS |
| 2 | Full Desktop typecheck | `apps/desktop: npx tsc -p tsconfig.json --noEmit` | PASS |
| 3 | Lease/journal/refusal unit tests (36) | `npx vitest run --config vitest.config.mts src/shelf-write-coordination.test.ts` | PASS |
| 4 | Reviewer writer + reconciliation regression (47) | `npx vitest run ... src/reviewer-shelf-materializer.test.ts src/reviewer-shelf-reconciliation.test.ts src/shelf-write-coordination.test.ts` | PASS |
| 5 | Canonical PoC command (build + unit + real child processes) | `apps/desktop: npm run test:collector-shelf-write` | PASS (36 unit, 14 real-process) |
| 6 | Whole Desktop suite (`npm test`) | 904/905 pass; the single failure (`src/tutorial-sample.test.ts`, Unicode normalization of the tutorial marker) reproduces on the unmodified base commit, so it is pre-existing and unrelated | PASS (no new failure) |

Real-process evidence (`test/collector-shelf-write-coordination.test.mjs`, every case spawns real child
processes against an isolated fixture Shelf):

1. 6 concurrent processes, same URL → exactly **1 Book**, **6 Annotations**, all referencing it, all
   v0.4-valid (validated with `@maginalia/format` from the bytes on disk).
2. 4 concurrent processes, same request ID → **1 Annotation**, receipt states
   `committed` + 3 × `already-committed`, one Annotation ID.
3. Process killed between Book and Annotation publish → Book survives, no Annotation, journal `staged`,
   dead lease left behind. A retry and a crowd of 4 simultaneous retries all fail
   `shelf-write-lease-stale` with the exact holder token/PID, the lock file stays **byte-identical**, and
   no Annotation appears. One explicit reclaim (token taken from the failure) then lets the retry reuse
   the Book and the staged Annotation ID and commit exactly once.
4. Holder **hard-killed** while holding the lease (a separate case from the write-path crash): the
   terminated holder never reports a release, the next writer gets `shelf-write-lease-stale`, nothing is
   written, and after one explicit reclaim a normal commit succeeds.
5. **PID reuse**: a lease whose `pid` belongs to a live process that did not create it →
   acquisition `shelf-write-lease-uncertain` and recovery `shelf-write-lease-uncertain`; the lock is
   byte-identical and nothing is written.
6. **Concurrent explicit reclaims** of one dead lease (4 processes, same token) → exactly one
   `reclaimed: true`; the others report `reclaimed: false` (lock already gone, nothing removed) or fail
   `shelf-write-lease-uncertain`. No lock or retire debris remains, and the subsequent commit yields one
   Book and one Annotation.
7. Fresh process replaying a committed request → `already-committed`, original `recordedAt`, and the
   Annotation file bytes are unchanged.
8. Same request ID with different content → `shelf-write-request-mismatch`; the same check with only the
   comment field changed (`privateMemo` instead of `comment`) is also refused.
9. Wrong expected Shelf UUID → `shelf-write-identity-mismatch`, Shelf untouched.
10. `annotations/` replaced by a junction before the write → `shelf-write-layout-invalid`, external
    directory stays empty; swapped for a junction mid-write → `shelf-write-unsafe-path`.
11. Coordination root inside the Shelf → `shelf-write-unsafe-path`.
12. A live holder with a heartbeat older than the contender's threshold → the contender gets
    `shelf-write-lease-uncertain`, an explicit reclaim attempt with that holder's own token is also
    refused with `shelf-write-lease-uncertain`, the holder's lock is unchanged, its `assertHeld()` after
    the attacks still passes, and no record was written. After release, the next process commits.
13. A journal tampered to point its `annotationId` at `../../escape` → a fresh process refuses with
    `shelf-write-journal-invalid`; the existing Annotation is untouched and no file appears at the
    traversed path.

In-process unit evidence additionally covers: busy refusal while the lease is held; a stale lease is
reported and **never** taken over (lock byte-identical, no `.reap`/`.pin`/`.retire` debris); explicit
recovery succeeds and leaves an empty directory; recovery refuses a token the caller did not observe;
recovery refuses a live holder; the whole `commitShelfQuote` path refuses under a stale lease and keeps
refusing across repeated attempts (no escalation to takeover); a **deterministic recovery race** (a
competitor installs a live lease from the `onBeforeRetireRename` seam) leaves the winner's lock
byte-identical and fails closed; a malformed lock fails closed for both acquisition and recovery;
release removes only its own lock; release cannot delete a newer holder's lock (deterministic
`releaseFaults.beforeRetireVerify` seam); releasing with a superseded token restores the foreign lock
byte-identically; the Reviewer writer refuses under a stale lease and writes zero records, then succeeds
after one explicit reclaim; marker mismatch/missing/conflict; overlap refusal with the Shelf proven
unmodified; comment-field routing and mismatch; strict journal validation (foreign Shelf, filename/
request-ID mismatch, traversal Annotation ID, malformed Book ID, non-digest digests, bad timestamp,
unknown field, inconsistent state, invalid JSON, committed-without-Book, committed-without-Annotation);
and the Desktop writer refusing while a Host-side lease is held.

## 5. Not verified

- Native Messaging Host → real Shelf **write** (deliberately not enabled; the host still answers `save`
  with `unsupported_operation` and `writesEnabled: false`).
- Desktop UI ↔ Host exclusion in production, because the Desktop writer is only lease-capable when a
  caller opts in and no product caller does yet.
- Real Electron smoke, packaged installer behavior, Chrome extension end-to-end save, and real-user Shelf
  re-open in the Desktop UI.
- Power-loss/kernel-level durability. Files and the journal are `fsync`ed, but Windows provides no
  portable directory fsync and Node exposes no write-through rename, so "durable acknowledgement" is
  proven against process kill, not against abrupt power loss.
- Orphan cleanup: an add-only Book left by a crashed request that is never retried stays on disk
  (harmless, reused by locator) and no sweeper exists.
- A real Chrome process terminating a Native Messaging Host mid-save (the mechanism that would make the
  recovery procedure routine rather than exceptional). Only a killed child process was exercised.

### Residual risks of the adopted lease protocol

- **Recovery is manual by design.** A dead holder blocks every writer until one explicit reclaim. There
  is no auto-reclaim to race against, so the invariant holds, but the operational cost is real: a Chrome-
  terminated Host, a killed Desktop, or a power loss each require the recovery step. If that cost is
  unacceptable in production, the alternative is the OS-mutex mechanism (OD-10), not a weaker JS lock.
- **Single-syscall window in recovery only.** `retireOwnLock` still has one window: between the token/
  death check and the `rename()`. If a live lease is created inside it, the moved file is restored with
  `link()` and left byte-identical (or, if restoration is impossible, recovery fails closed and the
  displaced holder detects the loss through `assertHeld()` before publishing — so no duplicate or wrong
  record can be produced). No write path can enter that window: only the explicit recovery call reaches
  it.
- **No heartbeat renewal.** The heartbeat is written once at acquisition. A holder that is alive but
  wedged past `leaseTtlMs` blocks other writers with `shelf-write-lease-uncertain` instead of being
  evicted. This is deliberate (a healthy writer must not lose its lease). A renewal timer would only
  improve diagnostics; it must not become a theft threshold.
- **Hard-link dependency.** The verified restore path and the retirement restore need `link()`. On a
  filesystem without hard links (some network shares) the affected operation fails closed with
  `shelf-write-lease-uncertain` rather than falling back to an unverified delete.
- **Retire debris.** If `unlink` fails after a successful retire rename, a
  `writer.lock.<uuid>.retire` file remains. It does not block acquisition (the real name is free), but it
  is untracked debris that no sweeper collects.

## 6. Open decisions (must not be settled by this slice)

| ID | Decision needed | Options / note | This slice's assumption |
| --- | --- | --- | --- |
| OD-1 | Production location of the coordination root | Desktop `userData` vs `%LOCALAPPDATA%\MAGINALIA\coordination` vs beside the Shelf (rejected: pollutes user data) | Caller-supplied; must not overlap the Shelf |
| OD-2 | Direct Host write vs Host→Desktop delegation | ADR 0019 accepts the semantic operation but not the writer; this PoC assumes the Host may write directly through the shared foundation | Not decided |
| OD-3 | Journal retention / GC and whether receipts are exposed to the extension | Keep committed receipts forever vs TTL pruning; staged orphan sweep policy | Journal is unbounded; no sweeper |
| OD-4 | Which Annotation field carries the Collector comment | `comment` (Collector instruction) vs `privateMemo` (current Reviewer writer) | `comment` by default, switchable |
| OD-5 | Who generates the request ID and what it is bound to | Extension UUID/ULID; bound to extension ID/install? | Opaque `[A-Za-z0-9._:-]{8,128}` |
| OD-6 | Web Book identity when a URL serves different documents | Today a matching URL (no source files) always reuses one Book even if title/authors differ; the contract says URL alone is not identity | Reuse by locator + compatibility, conflicts only on hard mismatches |
| OD-7 | Enabling the Host write path | Requires production identity binding, registration/packaging, and an approved `save` contract | Not enabled |
| OD-8 | Whether file+journal `fsync` is sufficient "durable acknowledgement" | Windows lacks portable directory fsync / write-through rename | Proven against process kill only |
| OD-9 | Fairness between concurrent writers | Bounded backoff, no ordering guarantee; a long Reviewer materialization can make a Host write return `busy` | `busy` is a retryable, non-destructive outcome |
| **OD-10** | **Lease safety mechanism for production** | (a) keep the JS `wx` lease with **no auto-reclaim** + explicit recovery (this slice); (b) add an OS-mutex/exclusive-handle native addon so the kernel releases on death and no recovery is ever needed | (a) implemented and verified; (b) not implemented |
| **OD-11** | **Recovery UX owner and text** | Who shows `shelf-write-lease-stale` and how (Host-side message to the extension, Desktop dialog, or both); whether recovery is user-triggered only | Fail closed; recovery is an explicit call, no product surface yet |
| **OD-12** | **Policy for `shelf-write-lease-uncertain` and manual lock deletion** | Support instruction vs a product "reset write lock" action; whether the Host may ever override | Documented manual deletion only; no code path deletes an unprovable lock |

Production adoption is blocked on **OD-10** first: the answer decides whether the recovery procedure is
a rare repair path (native mutex) or a routine part of the user experience (JS lease).

## 7. Proposed canonical plan write-back (not applied — IDE untouched)

The work order forbids modifying `MAGINALIA_IDE`. The following text is what acceptance of this slice
should add to `plan/30_MAGINALIA_COLLECTOR_REQUIREMENTS.md` (and, once OD-1…OD-3 / OD-10 are approved,
to ADR 0019's open-items paragraph):

```text
### 下書き: クロスプロセスShelf書込基盤（lease安全化・技術検証済み／未有効）

- Desktop PR (branch `codex/collector-shelf-lease-safety`, base dev0.2 8d103a0 = PR #79 merge) で、
  Shelf UUID 単位のプロセス間lease、add-only公開 + Annotationを単一commit pointとする順序、
  request IDによる冪等journal/receipt、commit直前のrealpath/dev/ino再検証を実装・検証した。
- Windows 11 / Node では「観測したファイルのままである場合に限り削除/renameする」原子的プリミティブが
  存在しないため、自動reapを廃止した。書き込み経路は自分が作成していないlockを rename/削除しない。
  死んだholderのleaseは `shelf-write-lease-stale`（holder情報付き）で報告し、明示的な
  `reclaimStaleShelfWriteLease({ expectedToken })` のみが解除できる。生存holderは心拍の経過だけでは
  奪わない（`shelf-write-lease-uncertain`）。所有権不明時はすべてfail closed。
- releaseはtoken確認後unlinkではなく、専用名へrename→移動後ファイルのtoken検証→削除の順に変更し、
  check-then-act窓で置換されたlockを削除しない（誤って移動した場合は `link()` でバイト同一に復元）。
- 検証: 実子プロセスでholder kill、PID再利用、同時取得、明示reclaim競合、crash→staged→reclaim→retry、
  Reviewer Writer回帰、Shelf v0.4妥当性、journal改竄拒否を確認。単一プロセスでは回復競合・release競合を
  決定的に再現した。
- 残存リスク: 回復時の単一rename窓（誤移動は復元／不能ならfail closed、書込経路からは到達不能）、
  心拍更新なし、hard link非対応FSではfail closed、retire残骸は未回収。
- 運用上の代償: クラッシュ後は明示回復まで保存が止まる。ChromeがNative Hostを終了させる場合、
  回復は例外的ではなく日常的になり得る。
- 未決定: coordination rootの本番位置、直接書込か委譲か、journal保持/GC、comment格納先、
  request IDの発行者と束縛、同一URLで異なる文書のBook同一性、Windowsでの耐久ack保証、優先順位、
  **本番採用する排他方式（JS lease + 明示回復 / OS mutexネイティブアドオン）**、
  **回復UIの所有者と文言**、**`-uncertain` 時の手動lock削除ポリシー**。
- Hostからの実Shelf書込、本番identity binding、registration/packagingは未実装・未検証。
```

## 8. Enablement gate (before any real Host write)

1. Owner decides **OD-10** (JS lease + explicit recovery, or an OS-mutex native addon) and, on that
   basis, **OD-11** / **OD-12**.
2. Owner approves OD-1…OD-3 (and OD-4/OD-6 if they change what is written).
3. Product IPC/renderer surface and the Host `save` operation are specified against Shelf v0.4,
   including what the user sees for `shelf-write-lease-stale` / `-uncertain`.
4. Production descriptor/origin binding replaces the experimental one.
5. The coordination root is plumbed into both the Desktop writer and the Host from one source.
6. Real Chrome + real Electron + a disposable real Shelf re-open smoke, plus a crash/kill matrix
   (including a Chrome-terminated Host), are recorded as PASS; mocks alone are not acceptance.
