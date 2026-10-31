# Cross-process Private Shelf writer foundation

Status: **design + technical verification (PoC)**. Not enabled in the product and
not reachable from the Native Messaging Host.

- Repository: `potoha/MAGINALIA_desktop`
- Parent branch: `dev0.2` @ `0dd396ce32e0c3105e2b8d829a1c020d2e704cdc` (verified exact; this is the PR #78 merge)
- Work branch: `codex/collector-shelf-writer-coordination`
- Canonical sources consulted: `MAGINALIA_IDE/docs/decisions/0019-collector-native-messaging-host.md` (Accepted, D070),
  `MAGINALIA_IDE/docs/shelf-json-contract.md` (v0.4), `MAGINALIA_IDE/spec/shelf-*.schema.json`,
  `MAGINALIA_IDE/plan/30_MAGINALIA_COLLECTOR_REQUIREMENTS.md`, Collector Issue #9, Desktop PR #78.

## 1. Problem

ADR 0019 / D070 accept the Collector → Native Messaging Host → Private Shelf boundary but state that
"the locking/coordinator design and atomicity mechanism are not selected" and that the current Desktop
write queue is **process-local**. Issue #9 requires: stable-ID path resolution, existing Book
reuse with multiple Annotations, a unique request ID with duplicate/concurrent-write control,
no partial/duplicate/corrupt records on interruption, and "saved" only after the write is complete.

Two OS processes can address the same configured Shelf:

| Process | Writer today | Process-local protection |
| --- | --- | --- |
| Desktop main | `reviewer-shelf-materializer.ts` (`materializeReviewerRecords`) | module promise queue only |
| Native host | none (`save` is `unsupported_operation`) | n/a |
| First-run / tutorial seed | `tutorial-seed.ts`, `first-run-setup.ts` | exclusive `wx` per file |
| Generic repository creation | `repository-service.ts` | exclusive `wx` per file |

## 2. What exists already (verified by inspection)

- **Shelf v0.4 validation**: `@maginalia/format` `validateShelfEntity` / `parseShelfEntity`, strict
  `additionalProperties: false` schemas vendored in `spec/`.
- **No-replace publication**: `writeNoReplace` (temp file + hard link; `EEXIST` → byte compare).
- **Book reuse**: `matchingBook` / `booksAreCompatible` (kind + ISBN + URL + source-file digests;
  more than one overlapping Book is a conflict, not a guess).
- **Path safety**: `ensureDirectory` rejects symlinks and out-of-root realpaths per segment;
  `assertSafeRoot`, `inspectFolderMarkers` (typed `*.magi`, conflict detection).
- **Reviewer idempotency**: alias + content digest stored in `deviceMetadata.maginaliaReviewer`.

Gaps this slice addresses: no cross-process exclusion, no interruption model across
Asset/Book/Annotation, no durable receipt, no request identity, no path-swap re-check at the commit
point, and no way for the two processes to share one implementation.

## 3. Design

### 3.1 One implementation, two callers

`apps/desktop/src/shelf-write-core.ts` now owns the Reviewer-neutral publication rules that used to be
private to the Reviewer writer: containment checks, configured-directory resolution, no-replace
publication (now with an explicit `fsync` before the link), record enumeration, Book-locator matching,
record filenames and serialization.

`reviewer-shelf-materializer.ts` was changed to consume those primitives and keeps only Reviewer
policy. Its ordering, conflict accounting, error messages, module queue and signature are unchanged;
it gained one **optional** fourth parameter:

```ts
materializeReviewerRecords(shelfRoot, records, lookupMetadata, {
  coordinationRoot,   // machine-local coordination directory
  shelfId,            // stable Shelf UUID from the *.magi marker
  acquireTimeoutMs?,  // test/tuning only
});
```

When the option is omitted, behavior is byte-for-byte today's behavior. When present, the whole
materialization runs under the shared lease, so the Desktop writer and the Host exclude each other.
**This is the only product-code behavior change in this slice, and it is inert unless a caller opts in.**

`apps/desktop/src/shelf-write-coordination.ts` is the new foundation: identity/layout resolution,
the lease, the durable journal, the Collector web-quote commit, and journal inspection.
It is not imported by `main.ts`, IPC, or the host. The only product import is the optional lease used
by the materializer above.

No second Shelf format, schema, ID scheme, or copy database is introduced. Request identity is kept
**out of Shelf JSON** (ADR 0019 forbids a noncanonical request ID there), even though the annotation
`deviceMetadata` schema happens to be free-form.

### 3.2 Exclusion keyed by Shelf UUID

- Lease path: `<coordinationRoot>/shelves/<shelf-uuid>/writer.lock`.
- The key is the **marker UUID (D068)**, not a machine path, so a moved or renamed Shelf folder keeps
  the same exclusion domain.
- Acquisition is a `wx` create (atomic compare-and-set). Contenders back off with bounded jitter and
  fail with `shelf-write-busy` after `acquireTimeoutMs` (default 15 s) — a write is never silently
  skipped or duplicated.
- **Only a provably dead PID justifies reclamation.** A live holder keeps its lease no matter how old
  its heartbeat is; an expired heartbeat means the holder's health cannot be proven, so the contender
  fails closed with `shelf-write-lease-uncertain` instead of stealing. (The heartbeat is written at
  acquisition time only — there is no renewal timer; see residual risk below.)
- Reclamation of a dead holder's lock is a verified swap, never a bare delete or blind rename:
  1. the lock is observed as an immutable record of its exact bytes, parsed metadata and `{dev, ino}`;
  2. the file is pinned with a hard link and the pin's bytes and `{dev, ino}` must match the observation —
     if not, a newer holder already replaced the lock and nothing is touched;
  3. the name is re-read immediately before the swap; if it no longer refers to the observed file, the
     reap is abandoned and retried without renaming anything;
  4. only then is the lock atomically renamed into quarantine, and the quarantined file's bytes and
     `{dev, ino}` must match the observation again;
  5. a mismatch restores the quarantined file atomically with `link()`; if restoration is impossible
     (a third writer already created a lock) the outcome is `shelf-write-lease-uncertain`.
- A lock file that exists but cannot be parsed is given the full acquire window to become valid (it may
  be a live creator mid-write) and then fails closed with `shelf-write-lease-uncertain`. It is never
  deleted on a guess.
- Release compares the holder token, so a writer that lost its lease cannot delete the new holder's
  lock. `assertHeld()` runs immediately before the Book publish and again before the commit point, so a
  writer whose lease was displaced cannot publish anything.

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

Any deviation fails closed with `shelf-write-journal-invalid`. A malformed record can therefore never
produce `committed` or `already-committed`, and journal inspection reports the error instead of silently
skipping the record.

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
against its realpath. A rejected configuration leaves the Shelf byte-for-byte unchanged — proven by a
test that removes `books/` and `annotations/` first and asserts they are still absent, and that
`readdir(shelfRoot)` is identical, after each rejection.

Residual risk (not hidden): the window between the last fingerprint check and `link()` is a TOCTOU
window. It is narrowed to a single syscall but not eliminated; eliminating it needs a directory handle
or handle-relative publish primitive that Node does not provide portably.

### 3.6 Shelf v0.4 compatibility

Produced records are validated with `@maginalia/format` **before** the journal is written and again by
the tests from the bytes on disk: `type`, `version: "0.4"`, `id` patterns
(`book:<Crockford ULID>` / `ann:<Crockford ULID>`), `source.kind = "website"`, `source.id` →
Book, `get.date = YYYYMMDDHHMM`, non-empty `quote`, optional `comment`. No field outside the strict
v0.4 schema is added.

### 3.7 Error codes

| Code | Meaning |
| --- | --- |
| `shelf-write-invalid-request` | Caller input is not a valid request (IDs, URL, get.date, comment) |
| `shelf-write-unsafe-path` | Layout, record directory or coordination root is unsafe or changed |
| `shelf-write-shelf-unavailable` | Configured Shelf root is unavailable |
| `shelf-write-identity-unavailable` / `-conflict` / `-mismatch` | Marker missing, conflicting, or not the expected Shelf |
| `shelf-write-layout-invalid` | `library.json` directories are not resolvable/writable |
| `shelf-write-busy` | A live, healthy holder kept the lease for the whole acquire window |
| `shelf-write-lease-lost` | This writer's token is no longer the lock's token |
| `shelf-write-lease-uncertain` | A live-but-unproven holder, an unreadable lock, or an unprovable reap — fail closed |
| `shelf-write-journal-unavailable` | Journal/lease filesystem operation failed |
| `shelf-write-journal-invalid` | A journal record is malformed, foreign, or internally inconsistent |
| `shelf-write-request-mismatch` | Same request ID, different content (digest, incl. comment field) |
| `shelf-write-book-conflict` | The source URL matches incompatible Books |
| `shelf-write-record-conflict` | A different record already occupies the planned filename |
| `shelf-write-receipt-missing` | A committed receipt's Book or Annotation is missing/changed |

## 4. Verification

All commands run in the worktree at the result commit. Fixtures are created in the OS temporary
directory (`Private Shelf 本棚` / `coordination`), removed afterwards; no real Shelf, `Documents/
MAGINALIA`, `shelf_location.yml`, IDE or Collector repository is touched.

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | Main-process typecheck | `apps/desktop: npx tsc -p tsconfig.main.json --noEmit` | PASS |
| 2 | Full Desktop typecheck | `apps/desktop: npx tsc -p tsconfig.json --noEmit` | PASS |
| 3 | Lease/journal/refusal unit tests (30) | `npx vitest run --config vitest.config.mts src/shelf-write-coordination.test.ts` | PASS |
| 4 | Reviewer writer regression (5+14) | `npx vitest run ... src/reviewer-shelf-materializer.test.ts src/reviewer-shelf-reconciliation.test.ts src/tutorial-seed.test.ts` | PASS |
| 5 | Whole Desktop suite (`npm test`) | 898/899 pass; the single failure (`src/tutorial-sample.test.ts`, Unicode-normalization of the tutorial marker) reproduces on the unmodified base commit, so it is pre-existing and unrelated | PASS (no new failure) |
| 6 | Real two-process evidence (11 tests) | `npm run build:main && node --test test/collector-shelf-write-coordination.test.mjs` | PASS |

Real-process evidence (`test/collector-shelf-write-coordination.test.mjs`, each case spawns real child
processes that write to an isolated fixture Shelf):

1. 6 concurrent processes, same URL → exactly **1 Book**, **6 Annotations**, all referencing it, all
   v0.4-valid.
2. 4 concurrent processes, same request ID → **1 Annotation**, receipt states
   `committed` + 3 × `already-committed`, one Annotation ID.
3. Process killed between Book and Annotation publish (exit 70, lease left behind) → Book survives,
   no Annotation, journal `staged`; a retry takes over the dead lease, reuses the Book and the staged
   Annotation ID, and commits.
4. Fresh process replaying a committed request → `already-committed`, original `recordedAt`, and the
   Annotation file bytes are unchanged.
5. Same request ID with different content → `shelf-write-request-mismatch`, no new files; the same check
   with only the comment field changed (`privateMemo` instead of `comment`) is also refused.
6. Wrong expected Shelf UUID → `shelf-write-identity-mismatch`, Shelf untouched.
7. `annotations/` replaced by a junction before the write → `shelf-write-layout-invalid`, external
   directory stays empty.
8. `annotations/` swapped for a junction mid-write (after the Book publish) → `shelf-write-unsafe-path`,
   nothing written through the junction.
9. Coordination root inside the Shelf → `shelf-write-unsafe-path`.
10. A live holder with a heartbeat older than the contender's threshold → the contender gets
    `shelf-write-lease-uncertain` (never `committed`), the holder's lock is still the holder's PID, the
    holder's `assertHeld()` after the contender ran still passes, and no record was written. Once the
    holder releases, the next process commits normally.
11. A journal tampered to point its `annotationId` at `../../escape` → a fresh process refuses with
    `shelf-write-journal-invalid`; the existing Annotation is untouched and no file appears at the
    traversed path.

In-process unit evidence additionally covers: busy refusal while the lease is held, dead-PID reap with
no quarantine/pin debris, refusal to evict a live holder on heartbeat expiry alone, a **deterministic
reap race** (a competitor installs a live lease from inside the `onBeforeReapRename` seam; the contender
must not move it, must fail `busy`, and the winner's lock bytes and token must be unchanged), fail-closed
on a malformed lock, token-checked release, marker mismatch/missing/conflict, overlap refusal **with the
Shelf proven unmodified** (`books/` and `annotations/` stay absent, `readdir` unchanged), comment-field
routing, comment-field mismatch detection, strict journal validation (foreign Shelf, filename/request-ID
mismatch, traversal Annotation ID, malformed Book ID, non-digest digests, bad timestamp, unknown field,
inconsistent state, invalid JSON, committed-without-Book, committed-without-Annotation), and the Desktop
writer refusing while a Host-side lease is held.

## 5. Not verified

- Native Messaging Host → real Shelf **write** (deliberately not enabled; host still answers
  `save` with `unsupported_operation` and `writesEnabled: false`).
- Desktop UI ↔ Host exclusion in production, because the Desktop writer is only lease-capable when a
  caller opts in and no product caller does yet (in-process evidence only for the writer side).
- Real Electron smoke, packaged installer behavior, Chrome extension end-to-end save, and real-user
  Shelf re-open in the Desktop UI.
- Power-loss/kernel-level durability. Files and the journal are `fsync`ed, but Windows provides no
  portable directory fsync and Node exposes no write-through rename, so "durable acknowledgement" is
  proven against process kill, not against abrupt power loss.
- Orphan cleanup: an add-only Book left by a crashed request that is never retried stays on disk
  (harmless, reused by locator) and no sweeper exists.

### Residual risks of the lease protocol

- **No heartbeat renewal.** The heartbeat is written once at acquisition. A holder that is alive but
  wedged past `leaseTtlMs` blocks other writers with `shelf-write-lease-uncertain` instead of being
  evicted. This is deliberate (a healthy writer must not lose its lease) but means a stuck process, or
  a lock file left unreadable by a crash mid-write, needs operator removal of
  `<coordinationRoot>/shelves/<uuid>/writer.lock`. A renewal timer is the obvious follow-up, but it
  changes the failure model and is not implemented here.
- **Single-syscall reap window.** The name is re-read immediately before the atomic rename, so a lock
  created in the observation window is not renamed. The gap between that final read and the rename
  syscall cannot be closed with portable Node APIs. If it is ever crossed, the quarantined file is
  restored with `link()`; if restoration is impossible the contender fails closed, and the displaced
  holder still detects the loss through `assertHeld()` before any publish, so no duplicate record can
  be produced.
- **Hard-link dependency.** The verified reap and the restore path need `link()`. On a filesystem
  without hard links (some network shares) reclamation fails closed with `shelf-write-lease-uncertain`
  rather than falling back to an unverified delete.

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

## 7. Proposed canonical plan write-back (not applied — IDE untouched)

The work order forbids modifying `MAGINALIA_IDE`. The following text is what acceptance of this slice
should add to `plan/30_MAGINALIA_COLLECTOR_REQUIREMENTS.md` (and, once OD-1…OD-3 are approved, to
ADR 0019's open-items paragraph):

```text
### 下書き: クロスプロセスShelf書込基盤（技術検証済み・未有効）

- Desktop PR (branch `codex/collector-shelf-writer-coordination`, base dev0.2 0dd396c) で
  Shelf UUID 単位のプロセス間lease、add-only公開 + Annotationを単一commit pointとする順序、
  request IDによる冪等journal/receipt、commit直前のrealpath/dev/ino再検証を実装・検証した。
- 既存Reviewer Writerの公開処理は `shelf-write-core` に集約し、第2のWriter/Shelf形式は作っていない。
- lease回収は死PID確認時のみ許可し、生存processのTTL超過はfail closed（`shelf-write-lease-uncertain`）と
  した。回収は観測(内容+dev/ino)→pin検証→再観測→rename→再検証とし、新しいlockを奪わない。
- requestDigestは永続化内容を変える全入力（commentFieldを含む）を対象とし、journalは
  shelfId/requestId/bookId/annotationId/digest/状態を厳格検証する（`shelf-write-journal-invalid`）。
- coordination rootとShelf rootの重複検査は副作用前に実施し、拒否時にShelfが変化しないことを検証した。
- Hostからの実Shelf書込、本番identity binding、registration/packagingは未実装・未検証。
- 未決定: coordination rootの本番位置、直接書込か委譲か、journal保持/GC、comment格納先、
  request IDの発行者と束縛、同一URLで異なる文書のBook同一性、Windowsでの耐久ack保証、優先順位。
```

## 8. Enablement gate (before any real Host write)

1. Owner approves OD-1…OD-3 (and OD-4/OD-6 if they change what is written).
2. Product IPC/renderer surface and the Host `save` operation are specified against Shelf v0.4.
3. Production descriptor/origin binding replaces the experimental one.
4. The coordination root is plumbed into both the Desktop writer and the Host from one source.
5. Real Chrome + real Electron + a disposable real Shelf re-open smoke, plus a crash/kill matrix,
   are recorded as PASS; mocks alone are not acceptance.
