# Data contracts

[`magicap-bundle-v3.1-manifest.schema.json`](magicap-bundle-v3.1-manifest.schema.json)
defines the separate outer Capture Bundle that groups independent, unchanged
`.magicap` v3 ZIP packages. Bundle and standalone package files share the
`.magicap` and `.magicap.zip` suffixes; readers identify the format from the ZIP
root `manifest.json` `format` and `version`, not the filename. See the
[Capture Bundle v3.1 contract](../../docs/magicap-bundle-contract-v3.1.md) for
the PR #69 manifest shape, Capture PR #33 Draft differences, version routing,
resource-safety, and future import-failure rules. This contract-only definition
does not add runtime import support or alter existing v1/v2/v3 package schemas.

`manifest-v1.schema.json` is the PHONE-to-PC ZIP manifest. The ZIP contains only
that `manifest.json` member and the JPEG members referenced by `pages[].imagePath`.

`published-book-v1.schema.json` is the image-free allowlist committed to
`marginalia/v1/books/<isbn13>.json`. It intentionally has no page image, complete
OCR text, geometry, stroke, or raw engine-output field.

Readers reject unknown schema versions and unknown object properties. Times are
UTC Unix epoch milliseconds. Page arrays are ordered by `capturedAtMs`, then `id`.

Readers additionally enforce ISBN checksum, unique page/region/annotation/highlight
IDs and image paths, increasing point order, non-degenerate rectangles, page ordering,
and a 10 MiB maximum serialized publication. These cross-field and aggregate rules
cannot be expressed completely by JSON Schema. Empty context is valid only at a book
or captured-page boundary; the PC reviewer requires human confirmation. `coverUrl`
must be HTTPS. Publication intentionally excludes description and raw page/OCR data.

The `fixtures` directory includes valid examples plus deliberately invalid version
and image-leak examples for negative parser tests.
