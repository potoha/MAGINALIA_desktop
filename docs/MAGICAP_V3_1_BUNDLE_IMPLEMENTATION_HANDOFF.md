# MAGICAP v3.1 Bundle Contract — Implementation Handoff

## Delivery identity

- Repository: `potoha/MAGINALIA_desktop` (the checkout and origin still use the historical `MAGINALIA_ALPHA` name).
- Required parent branch and PR target: `dev0.2`. The latest Product Owner instruction changes the original PR target from `main` to `dev0.2`.
- Required base: branch `dev0.2`, SHA `1e0fe37cfdfa4ad369ccff1d4f07f68d5277a86c` (matched the task packet and PR #69).
- Work branch before changes: `codex/magicap-v3-1-bundle-contract` at `0051961c9b1ad4c9d712920671ef86df5f5430de`, clean and tracking the same remote SHA.
- Implementation result commit: `7aa4ffa2582c0ed9320cf0d405e35c4454cd3918`.
- This handoff is delivered in a documentation follow-up commit. The final delivery HEAD is recorded in the existing PR body and delivery response.
- The source diff is committed; the test-created `sidecars/reviewer/.pytest-tmp-v31/` directory remains untracked and is not part of either commit.
- Stop boundary: update and push existing PR #69; do not create another PR, merge, or deploy.

## Implemented scope and architecture

The outer ZIP is identified by root `format: "maginalia-capture-bundle"`, string `version: "3.1"`, and `capbundle:<ULID>` identity. Its permitted filename suffixes are `.magicap` and `.magicap.zip`, shared with standalone v1/v2/v3 packages. The suffix is not a version discriminator. A future dispatcher must inspect the root manifest and route this outer format to a dedicated Bundle path, never to the existing standalone importer.

The shared manifest structure follows PR #69: `format`, string `version`, `bundleId`, `createdAt`, and `packages[]` records containing `packageId`, `path`, `sizeBytes`, `sha256`, opaque Capture `bookId`, `get.date`, and `captureIds`. The contract documents standalone v1/v2/v3 manifest dispatch and the distinct v3.1 Bundle route. One member represents one exact Book/date group; the same Book on different dates uses separate members. Inner source metadata remains authoritative. No Shelf Book identity or Reviewer annotation identity is invented or remapped.

The Bundle profile accepts ZIP methods STORED and DEFLATED only, and rejects unsupported methods during outer/inner metadata preflight. It also rejects invalid references, duplicate package/Capture identities or Book/date groups, unsafe or colliding paths, missing or undeclared files, corrupt hashes/CRC, invalid JSON, encrypted/special ZIP members, unsupported child versions, and excessive expansion. Outer and child entry counts and expanded sizes share one budget. The contract also defines byte preservation, validation-before-persistence, coordinated future persistence, and truthful `RECOVERY_REQUIRED` handling without destructive cleanup of existing user data.

Capture PR #33 remains a Draft proposal and differs in `format`, requires `contractStatus`, uses `packages[].size`, and emits its own draft filename. Its sequential `packages/package-NNN.magicap` child paths fit the shared path pattern. The contract records these differences and the Draft's per-inner-only limits / duplicate-key behavior; Capture output compatibility and activation remain unverified.

The reference verifier is test-only under `sidecars/contracts/test_tools/`. It streams and checks the outer and child archives, then calls existing v3 validation/extraction in temporary staging. It does not initialize a Reviewer database, call persistence/import methods, register commands, or add product import support.

## Changed files

| File or set | Result |
|---|---|
| `docs/magicap-bundle-contract-v3.1.md` | Normative archive/grouping/security/compatibility and failure-protection contract |
| `sidecars/contracts/magicap-bundle-v3.1-manifest.schema.json` | Strict root manifest JSON Schema |
| `sidecars/contracts/README.md` | Contract discovery link and scope boundary |
| `sidecars/contracts/test_tools/magicap_bundle_validator.py` | Contract-only, staged reference verification |
| `sidecars/contracts/test_tools/build_magicap_bundle_fixtures.py` | Deterministic small ZIP fixture generator |
| `sidecars/contracts/fixtures/magicap-bundle-v3.1.*.magicap` | 26 actual ZIP fixtures renamed without changing their bytes: one valid and 25 invalid |
| `sidecars/reviewer/tests/test_magicap_bundle_contract.py` | 43 contract tests and regressions |
| `docs/MAGICAP_V3_1_BUNDLE_IMPLEMENTATION_HANDOFF.md` | This report |

There are 32 implementation files plus this report. Exact paths are available with `git diff --name-only 1e0fe37cfdfa4ad369ccff1d4f07f68d5277a86c HEAD`.

## Verification and acceptance

Executed from `sidecars/reviewer` in the isolated worktree with Python 3.14.4 via `uv`:

```text
uv run --frozen --extra test python -m pytest -q --basetemp=.pytest-tmp-v31 -p no:cacheprovider
```

Result: **121 passed**, including 43 Bundle contract cases and all 78 existing Reviewer cases. One FastAPI/Starlette test-client deprecation warning remains. `git diff --check` passed. A protected-path comparison confirmed no changes to the v1/v2/v3 schemas, production Reviewer importer, or legacy importer tests.

The valid fixture contains three opaque Books, four independent v3 ZIPs, and five Captures: an ISBN-backed Book on two acquisition dates, a URL-backed ISBN-free Book, and Handwritten material with hashed canonical JPEG bytes. Tests read real nested ZIPs, verify reference/size/hash consistency and exact image bytes, and reproduce all 26 checked-in fixture byte sequences under the renamed `.magicap` filenames. Regression tests prove that both `.magicap` and `.magicap.zip` can hold either standalone v3 or v3.1 bytes and that the manifest, not the suffix, determines which contract validates. The test rejects Capture Draft's alternate `format`, `contractStatus`, and `size` fields. Patched matching local and central ZIP headers exercise unsupported compression-method rejection at both archive layers.

| Acceptance item | Status | Evidence or limitation |
|---|---|---|
| Product Owner filename decision and manifest-based v1/v2/v3/v3.1 identification | PASS | Contract, schema, two-suffix regressions; no suffix-only version routing |
| Dedicated v3.1 route kept separate from existing importer | PASS | Normative routing contract; production route intentionally not implemented |
| Capture PR #33 differences documented against PR #69 manifest | PASS | Contract comparison table and negative Draft-shape tests |
| Existing 26 fixtures updated without changing bytes | PASS | 26 exact renames and deterministic fixture reproduction |
| Unsupported ZIP methods rejected at outer and inner layers | PASS | STORED/DEFLATED profile and consistent-header method-99 regressions |
| Multiple Books and acquisition dates | PASS | Four-child valid ZIP and exact group assertions |
| ISBN-backed, ISBN-free, Handwritten | PASS | Existing-v3-conforming fixtures; ISBN-free fixture is URL-backed |
| Child size/hash/Book/date/Capture consistency | PASS | Positive assertions and negative ZIP fixtures |
| Inner bytes and canonical image integrity | PASS | Fixture composer stores child bytes unchanged; deterministic archive and exact-image checks |
| Duplicate IDs, unsafe paths, bombs, missing files, corrupt hashes | PASS | Concrete invalid ZIPs, bounded shared-budget tests, and outer/inner regression tests |
| Data protection and partial-failure policy defined | PASS | Contract requires complete prevalidation and coordinated persistence/recovery |
| Existing v1/v2/v3 schemas, importer behavior, and tests preserved | PASS | Protected-path diff empty; all 78 existing tests pass |
| Prior PR #69 compression review finding addressed | PASS | Preflight validation and outer/inner patched-header tests |
| Production Bundle importer, real Capture compatibility, atomic persistence, and crash recovery | NOT VERIFIED | Explicitly deferred; Capture PR #33 remains a differing Draft |
| Electron picker/UI and production smoke | NOT VERIFIED | Explicitly outside this contract-only change |

No acceptance item remains FAIL. Test and contract PASS do not imply runtime Bundle support.

## Canonical sources and latest Product Owner boundary

Checked relevant planning and accepted decisions:

- `MAGINALIA_IDE/plan/09_DECISION_LOG.md`: D061 and D069.
- `MAGINALIA_IDE/plan/17_CAPTURE_REVIEW_UX_SPEC.md`: explicit read-only snapshot and current standalone picker boundaries.
- `MAGINALIA_IDE/docs/decisions/0013-handwritten-canonical-source-assets.md` and `0018-bookwithoutisbn-canonical-image-provenance.md`.
- `MAGINALIA_IDE/docs/magicap-contract-v3.md`.

These sources preserve versioned contracts and canonical source-byte integrity. The current UX plan keeps the existing standalone picker suffixes, and the current v3 contract remains the child-package authority. This task's explicit boundary prohibited all MAGINALIA_IDE edits, so **no plan or decision was written back or marked DONE**. Existing local edits in `plan/19_DESKTOP_RENDERER_EDITOR_INTERACTION.md`, `plan/23_POST_MVP_IMPLEMENTATION_ROADMAP.md`, and `plan/27_ALPHA_CLOSE_SLICE_SEQUENCE.md` were left untouched. No canonical plan status was advanced.

D069/ADR 0018 accepts `bookwithoutisbn` with title and canonical files but no ISBN/URL. Desktop's current v3 schemas still reject that alternative. This is a known alignment gap, not a Bundle-specific redefinition: this PR leaves both existing v3 schemas unchanged, uses an explicit synthetic URL-backed ISBN-free fixture, and makes no locator-free import claim. A later authorized v3 schema/consumer task must resolve that gap without fabricating provenance.

## Remaining risks and next action

Remaining risks are the deferred D069 alignment in the current Desktop v3 consumer, reliance of this test-only verifier on existing private v3 validation helpers, and unimplemented production staging/transactions/crash recovery and routing. These helpers are repository test reuse, not a new runtime dependency or public import API. The fixed fixtures use synthetic data only. No Capture or IDE files were changed; no production deploy or PR merge occurred.

Next action: Product Owner reviews the updated PR #69. Before normal-user Bundle export or import is enabled, align Capture PR #33 to this manifest/profile and prove producer output with shared fixtures, then implement separate scoped Reviewer routing/import, persistence/recovery, and Electron acceptance. Do not implement Bundle import by passing the outer archive through the existing per-package importer.
