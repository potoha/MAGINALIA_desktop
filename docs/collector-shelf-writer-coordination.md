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
- A crashed holder is evicted by an atomic rename of the lock to a quarantine name; only one contender
  wins the rename. Staleness = dead PID **or** heartbeat older than 120 s (PID reuse guard).
- Release compares the holder token, so a writer that lost its lease cannot delete the new holder's
  lock.

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
  retries while IDs may differ per attempt.
- Same request ID + same digest → `already-committed` receipt, no write, no rewrite (asserted by
  comparing file bytes across processes).
- Same request ID + different digest → `shelf-write-request-mismatch` (writes nothing).
- `staged` + Annotation already on disk with the recorded digest → receipt is completed without
  re-publishing.
- `committed` receipt whose Annotation is missing or changed → `shelf-write-receipt-missing` (fail
  closed rather than "re-saving" over user data).
- The journal stores IDs, digests, timestamps and writer PID only — **no quote text, URL, title or
  comment**, so it is not a second copy of user data.

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
be committed as Shelf user data.

Residual risk (not hidden): the window between the last fingerprint check and `link()` is a TOCTOU
window. It is narrowed to a single syscall but not eliminated; eliminating it needs a directory handle
or handle-relative publish primitive that Node does not provide portably.

### 3.6 Shelf v0.4 compatibility

Produced records are validated with `@maginalia/format` **before** the journal is written and again by
the tests from the bytes on disk: `type`, `version: "0.4"`, `id` patterns
(`book:<Crockford ULID>` / `ann:<Crockford ULID>`), `source.kind = "website"`, `source.id` →
Book, `get.date = YYYYMMDDHHMM`, non-empty `quote`, optional `comment`. No field outside the strict
v0.4 schema is added.

## 4. Verification

All commands run in the worktree at the result commit. Fixtures are created in the OS temporary
directory (`Private Shelf 本棚` / `coordination`), removed afterwards; no real Shelf, `Documents/
MAGINALIA`, `shelf_location.yml`, IDE or Collector repository is touched.

| # | Check | Command | Result |
| --- | --- | --- | --- |
| 1 | Main-process typecheck | `apps/desktop: npx tsc -p tsconfig.main.json --noEmit` | PASS |
| 2 | Full Desktop typecheck | `apps/desktop: npx tsc -p tsconfig.json --noEmit` | PASS |
| 3 | Lease/journal/refusal unit tests (18) | `npx vitest run --config vitest.config.mts src/shelf-write-coordination.test.ts` | PASS |
| 4 | Reviewer writer regression (5+14) | `npx vitest run ... src/reviewer-shelf-materializer.test.ts src/reviewer-shelf-reconciliation.test.ts src/tutorial-seed.test.ts` | PASS |
| 5 | Whole Desktop suite (`npm test`) | 886/887 pass; the single failure (`src/tutorial-sample.test.ts`, Unicode-normalization of the tutorial marker) reproduces on the unmodified base commit, so it is pre-existing and unrelated | PASS (no new failure) |
| 6 | Real two-process evidence (9 tests) | `npm run build:main && node --test test/collector-shelf-write-coordination.test.mjs` | PASS |

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
5. Same request ID with different content → `shelf-write-request-mismatch`, no new files.
6. Wrong expected Shelf UUID → `shelf-write-identity-mismatch`, Shelf untouched.
7. `annotations/` replaced by a junction before the write → `shelf-write-layout-invalid`, external
   directory stays empty.
8. `annotations/` swapped for a junction mid-write (after the Book publish) → `shelf-write-unsafe-path`,
   nothing written through the junction.
9. Coordination root inside the Shelf → `shelf-write-unsafe-path`.

In-process unit evidence additionally covers: busy refusal while the lease is held, stale-PID eviction,
heartbeat-expiry eviction, token-checked release, marker mismatch/missing/conflict, overlap refusal,
comment-field routing, and the Desktop writer refusing while a Host-side lease is held.

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
