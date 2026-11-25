# MAGINALIA Capture Bundle v3.1 contract

Status: contract-only definition; no current import support

Inner package authority: [`.magicap` v3 contract in MAGINALIA_IDE](https://github.com/potoha/MAGINALIA_IDE/blob/main/docs/magicap-contract-v3.md), governed by [ADR 0013](https://github.com/potoha/MAGINALIA_IDE/blob/main/docs/decisions/0013-handwritten-canonical-source-assets.md) and amended by [ADR 0018](https://github.com/potoha/MAGINALIA_IDE/blob/main/docs/decisions/0018-bookwithoutisbn-canonical-image-provenance.md).

This contract defines a new outer ZIP that groups existing, independent `.magicap` v3 ZIPs. It does not revise the v1, v2, or v3 standalone package schemas, their bytes, or their importer behavior. The shared outer-manifest shape follows Desktop PR [#69](https://github.com/potoha/MAGINALIA_desktop/pull/69); the Capture-side proposal in [PR #33](https://github.com/potoha/MAGINALIA_Capture/pull/33) remains a Draft and is not compatible until it adopts the agreed fields and validation profile.

## Identity and filenames

The outer format identifier is `maginalia-capture-bundle` and its version is the string `"3.1"`. The permitted filename suffixes are `.magicap` and `.magicap.zip`, the same suffixes used by standalone Capture packages. Both contain a ZIP archive with media type `application/zip`. `.magicap.bundle`, `.magicap.bundle.zip`, generic `.zip`, and `m.magicap` are not alternate v3.1 extensions. Filename alone never establishes the format: consumers inspect and validate the root `manifest.json`, including its exact `format` and `version` values.

### Version identification and import routing

The suffix identifies an accepted ZIP container name; it does not identify a MAGICAP version. Every MAGICAP reader first opens the ZIP and validates the root `manifest.json`. The current standalone package versions share one `format` value and are distinguished by an integer `version`; the outer Bundle has a different `format` and a string version:

| Payload | Root `format` | Root `version` | Manifest/schema path |
|---|---|---:|---|
| Standalone v1 package | `maginalia-capture-package` | JSON integer `1` | Existing `magicap-v1-manifest.schema.json` and v1 import behavior |
| Standalone v2 package | `maginalia-capture-package` | JSON integer `2` | Existing `magicap-v2-manifest.schema.json` and v2 import behavior |
| Standalone v3 package | `maginalia-capture-package` | JSON integer `3` | Existing `magicap-v3-manifest.schema.json` and v3 import behavior |
| Outer v3.1 Bundle | `maginalia-capture-bundle` | JSON string `"3.1"` | This document and `magicap-bundle-v3.1-manifest.schema.json` |

The v1, v2, and v3 values are JSON integers, not strings or booleans. The outer v3.1 value is the exact JSON string `"3.1"`, not the number `3.1`. The `format`/`version` pair selects the schema and handler; a filename must never choose or override that pair.

A future importer dispatcher MUST validate the root manifest before choosing an importer. It routes `maginalia-capture-package` plus integer version 1, 2, or 3 to the existing standalone package path. It routes `maginalia-capture-bundle` plus string version `"3.1"` to a dedicated Bundle validator/importer. It MUST NOT pass the outer v3.1 ZIP to `MagicapImporter.import_magicap` or treat its `packages/` members as a standalone v3 package. The Bundle path validates the complete outer contract first, then validates each declared child as an unchanged standalone v3 package. Unknown, malformed, or mismatched discriminator pairs are rejected without suffix-based fallback.

This PR defines that routing contract only. It does not add a production dispatcher, Bundle importer, picker support, or persistence behavior. The existing v1/v2/v3 schemas and `MagicapImporter` remain unchanged.

The root member is `manifest.json`. Child package members are direct children of `packages/`, each ending in `.magicap`. The archive contains exactly the root manifest and the declared child packages. It contains no directory entries, extra files, nested bundles, or unreferenced data.

The common outer manifest uses the structure established in Desktop PR #69. Capture PR #33 currently differs as documented in [Capture Draft alignment](#capture-pr-33-draft-alignment). Its normative shape is:

```json
{
  "format": "maginalia-capture-bundle",
  "version": "3.1",
  "bundleId": "capbundle:01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "createdAt": "2026-10-12T02:30:00Z",
  "packages": [
    {
      "packageId": "capkg:01ARZ3NDEKTSV4RRFFQ69G5FAW",
      "path": "packages/日本語の本.magicap",
      "sizeBytes": 1234,
      "sha256": "<64 lowercase hex digits over the exact child ZIP bytes>",
      "bookId": "capture-book-id-preserved-exactly",
      "get": { "date": "202610120930" },
      "captureIds": ["capture-01"]
    }
  ]
}
```

The normative root schema is [`magicap-bundle-v3.1-manifest.schema.json`](../sidecars/contracts/magicap-bundle-v3.1-manifest.schema.json). Archive-level, cross-record, and nested-package rules below supplement JSON Schema.

The schema requires `format`, string `version`, `bundleId`, `createdAt`, and `packages`. Each package record uses `sizeBytes`; `size` is not an alias. `contractStatus` is not part of the shared manifest and is rejected by the closed schema.

### Capture PR #33 Draft alignment

Capture PR #33 is useful evidence for the producer flow and grouping behavior, but it labels its envelope as Draft and does not implement this shared contract. This PR uses the common manifest structure from Desktop PR #69 and records the remaining differences here so they can be reviewed before either product claims interoperability:

| Contract point | Capture PR #33 Draft | Shared v3.1 contract in Desktop PR #69 | Resolution in this PR |
|---|---|---|---|
| `format` | `maginalia-capture-bundle-draft` | `maginalia-capture-bundle` | Use the Desktop value. |
| `version` | String `"3.1"` | String `"3.1"` | Same exact value and JSON type. |
| Draft marker | Requires `contractStatus: "draft"` | No `contractStatus` member | Omit it from the shared manifest; the closed schema rejects it. Draft/activation state belongs outside the wire contract. |
| Child byte length | `packages[].size` | `packages[].sizeBytes` | Use `sizeBytes`; `size` is not accepted. |
| Child paths | Sequential names such as `packages/package-001.magicap` | Safe direct children of `packages/` ending in `.magicap` | The sequential Capture path shape is valid when it satisfies the shared path and uniqueness checks. |
| Download name | `MAGICAP-v3.1-DRAFT-….zip` | PR #69 originally proposed `.magicap.bundle` / `.magicap.bundle.zip` | The 2026-10-14 Product Owner decision supersedes both proposals: use `.magicap` or `.magicap.zip`; the manifest determines the format. |
| ZIP limits and JSON parsing | Per-inner limits; no shared outer-plus-inner entry count; duplicate JSON keys are not rejected by the Draft parser | Shared entry/expanded-byte budgets and strict JSON with duplicate-key rejection | A producer may impose lower limits, but every emitted Bundle must satisfy this consumer contract. Capture alignment and shared-fixture proof remain required before activation. |

The Capture PR's smaller producer-side byte caps are compatible as additional restrictions. Its other Draft fields, filename, or parser behavior must not be inferred as accepted alternatives. This contract update does not change Capture PR #33, enable Capture Bundle export, or establish real Capture-to-Reviewer compatibility.

## Grouping and inner package identity

Each child is a complete, independent `.magicap` v3 ZIP and remains valid on its own. The inner v3 `manifest.json` remains the only source of truth for `source`, source files, package `createdAt`, and other bibliographic provenance. The outer manifest deliberately does not copy or reinterpret those fields.

Producers must wrap the exact existing child ZIP bytes. They must not unpack, rebuild, recompress, or rewrite an inner archive while bundling it. Outer ZIP compression is allowed only when reading that member reproduces the identical child byte sequence. SHA-256 identifies content integrity; it does not establish authorship or authorize redistribution.

One child represents captures sharing the exact decoded `capture.bookId` Unicode string and exact inner `manifest.get.date` string. Equality is by Unicode code point; equivalent JSON escapes decode to the same value. Consumers must not trim, normalize, derive, or replace the opaque `bookId` with an ISBN, Shelf ID, or another identifier. `get.date` must be a real calendar time in `YYYYMMDDHHMM`; this is stricter than the current standalone v3 schema's range-pattern check and applies only to bundle eligibility. A package must contain at least one capture so this grouping is evidenced by its contents. Standalone v3 keeps its existing empty-capture rules.

Different acquisition dates for the same opaque `bookId` require separate inner packages. Such packages may retain distinct sources or metadata snapshots; consumers do not infer that they describe one canonical Book or merge them. Duplicate exact `(bookId, get.date)` groups, duplicate package IDs, duplicate package paths (including aliases), or a capture ID repeated anywhere in the bundle invalidate the complete bundle. Page-image IDs remain local to each independent child package.

`captureIds` is the set of capture IDs in that child. The inner package ID, capture count, exact capture-ID set, and exact book/date values must match the outer record. The child ZIP byte count and SHA-256 must match `sizeBytes` and `sha256` before its contents are considered.

## Validation and resource-safety profile

Consumers validate the whole outer archive and every child before making durable changes. The reference validator under `sidecars/contracts/test_tools/` is test-only; it calls the current v3 validator against temporary staging and never persists Reviewer state.

The initial resource limits are:

| Limit | Maximum |
|---|---:|
| Compressed outer ZIP bytes | 512 MiB |
| Shared expanded bytes: outer entries plus every child entry | 2 GiB |
| Shared entry count: outer plus all child entries | 5,000 |
| Any single entry, including a child ZIP | 256 MiB |
| Compression ratio at each ZIP layer | 200:1 |
| Each JSON manifest or capture record | 1 MiB |

ZIP entries may use only the interoperable `STORED` (method 0) or `DEFLATED` (method 8) compression methods at both the outer and child layers. Other methods are rejected during central-directory preflight with a contract validation error, before an entry is read. Budgets are shared across the bundle; they do not reset for each child. Consumers check central-directory metadata before extraction and still bound actual streamed reads, verify actual sizes and ZIP CRCs, and hash exact child bytes. Archive depth is exactly outer bundle → standalone v3 package; nested bundles are rejected.

ZIP entries must be regular files, unencrypted, and named with safe relative paths. Reject symbolic links and special files; duplicate names and aliases under case folding or Unicode normalization; absolute, drive, UNC, backslash, NUL, control-character, empty, `.` or `..` components; Windows-illegal `<`, `>`, `"`, `|`, `?`, or `*` characters; ADS colons; components ending in dot or space; and Windows reserved device components. Unicode filenames are allowed when they satisfy these checks and are encoded as UTF-8 in ZIP metadata. Directory entries are not allowed. The outer archive's member set must exactly equal `manifest.json` plus the child paths declared by the schema-valid manifest. These bundle eligibility checks are stricter than some legacy standalone v3 importer checks; they do not change or retroactively reject standalone packages.

Outer and inner manifests and capture JSON use strict UTF-8 without a byte-order mark, reject duplicate object keys and non-finite numbers, and reject unpaired surrogate strings. The inner manifest must validate as the existing v3 contract. Child validation also verifies each v3 canonical source file's exact SHA-256 and existing capture image rules through the current v3 validator.

Any failure rejects the complete bundle before import begins. Errors identify the bundle or child path and the violated rule without treating a partial set of children as a successful import.

## Future import failure policy

Import remains a read-only transfer of pending Capture data. Import does not delete or mutate the input bundle, create canonical human-verified quotes, approve captures, or infer human-verified text. A future importer must validate all children before durable writes and coordinate Reviewer database state with staged assets. A normal failure rolls back only state and staging created by that uncommitted attempt while preserving pre-existing data and the input.

A future importer must prove a coordinated transaction or journal across database and asset writes. If a crash or external failure leaves any package committed or uncertain, it must not claim bundle success or automatically delete existing or possibly user-reviewed data. It reports `RECOVERY_REQUIRED` with truthful per-package state, then requires explicit recovery/retry checks that are idempotent. This document defines the policy; it does not claim that current import code implements it or that crash recovery has been tested.

For duplicate-import safety, a future importer must preflight the bundle ID and every package ID against durable import identity and digest records before writing. It must never overwrite a package with the same ID; an ID already associated with different bytes is a conflict. The default policy is to reject the entire bundle if any child was already imported, rather than silently skipping that child. Recovery or explicit retry uses a committed per-package identity-and-digest ledger, preserves user edits, and reports each package's actual state. The schema validator has no durable state and does not prove these idempotency properties.

## Compatibility and current support

- Standalone `.magicap` v1 and v2 retain their existing legacy-readable behavior.
- Standalone `.magicap` v3 retains its existing manifest, schema, ZIP members, and importer semantics.
- An outer bundle has its own format ID, string version, bundle ID, and manifest schema, while sharing the `.magicap` / `.magicap.zip` suffixes with standalone packages. It is not a standalone `.magicap` package and must not be routed to the existing v1/v2/v3 importer or the legacy generic-ZIP path.
- The current Reviewer importer and Desktop picker do not import this outer format. This contract and its tests provide no runtime-import or Electron-smoke evidence.
- The currently checked-in `.magicap` v3 schema has not yet adopted the D069 file-backed `bookwithoutisbn` alternative. The sample package uses a URL-backed `bookwithoutisbn` with canonical image evidence so it validates against that unchanged schema. Applying the D069 alternative to v3 schema/importer validation remains a separate consumer-alignment task; this bundle contract does not revise v3.
- `17_CAPTURE_REVIEW_UX_SPEC.md` continues to describe the current picker, which accepts `.magicap` / `.magicap.zip` for current standalone packages. Manifest-based Bundle dispatch and UI support require a separate implementation slice.
