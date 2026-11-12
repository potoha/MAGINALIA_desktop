# Collector Host binding, ownership/ACL checks and Desktop commands

Status: implementation on the Collector α integration stack (Desktop #86, PR A1).
Product Host `save` is wired in the follow-up PR (A2); this document records the
configuration side only.

Canonical sources: MAGINALIA_IDE ADR 0019 (D070/D071) and
`plan/30_MAGINALIA_COLLECTOR_REQUIREMENTS.md`; approved design memo
[Desktop #86 comment](https://github.com/potoha/MAGINALIA_desktop/issues/86#issuecomment-6824997083);
binding invariants in [Desktop #84](https://github.com/potoha/MAGINALIA_desktop/issues/84#issuecomment-6541544663).

## 1. Production configuration = the #87 Shelf binding

| Item | Value |
| --- | --- |
| Base | `SHGetKnownFolderPath(FOLDERID_LocalAppData)` from the native addon, local fixed/RAM drive only |
| Binding | `<LocalAppData>\MAGINALIA\integration\private-shelf-binding.json` |
| Coordination root | `<LocalAppData>\MAGINALIA\coordination` |
| Schema | `ShelfBindingV1 {version, shelfLocationPath, expectedShelfId, locatorSha256, generation}` (unchanged) |
| Locator authority | `shelf_location.yml` `private_shelf.registry` (unchanged, sole authority) |
| Writer | Desktop only, on an explicit user command (below) or the existing Reviewer confirmation |
| Reader | the Collector Native Messaging Host, read-only |

No environment variable, cwd, executable-relative path or descriptor file contributes a
path. Tests inject a disposable LocalAppData root into the reader; they never touch the
real profile.

`readCollectorShelfConfiguration` (`apps/desktop/src/collector-shelf-configuration.ts`)
returns a valid configuration only when every step passes, and otherwise one of the
Collector protocol codes:

| State | Code |
| --- | --- |
| LocalAppData unavailable or not a canonical local path | `configuration_unavailable` |
| binding file absent | `shelf_unconfigured` |
| binding unreadable, corrupt, unknown version, unsafe directory chain | `configuration_unavailable` |
| ownership/ACL/reparse check fails | `configuration_unavailable` |
| `shelf_location.yml` unreadable or invalid | `configuration_unavailable` |
| `private_shelf.registry` is `null` | `shelf_unconfigured` |
| Shelf folder missing / unsafe | `shelf_unavailable` |
| typed marker missing, corrupt, conflicting or not `shelf` | `shelf_identity_unavailable` |
| `locatorSha256` no longer matches the registry | `configuration_unavailable` |
| marker UUID differs from `expectedShelfId` | `shelf_identity_mismatch` |
| `library.json` missing or invalid | `shelf_unavailable` |

Nothing is created, repaired or adopted on this path.

## 2. Ownership / ACL / reparse checks

The addon gains `inspectPathSecurity(path)`. It opens the entry once with
`FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS`, and reads attributes
(`GetFileInformationByHandle`), owner and DACL (`GetSecurityInfo`) from that one handle,
so a final reparse point is reported rather than followed. This is the handle-based
form of the `GetNamedSecurityInfoW` wrapper named in the memo. The policy lives in
`collector-path-security.ts` and is unit-tested with fakes:

- the entry must exist, have the expected type and not be a reparse point;
- the owner SID must equal the current user SID;
- a NULL DACL fails;
- no effective (non inherit-only) allow ACE may grant write-class rights
  (`FILE_WRITE_DATA`, `FILE_APPEND_DATA`, `FILE_WRITE_EA`, `FILE_DELETE_CHILD`,
  `FILE_WRITE_ATTRIBUTES`, `DELETE`, `WRITE_DAC`, `WRITE_OWNER`, `MAXIMUM_ALLOWED`,
  `GENERIC_ALL`, `GENERIC_WRITE`) to anyone except the current user, SYSTEM
  (`S-1-5-18`) and BUILTIN\Administrators (`S-1-5-32-544`); an object ACE with write
  rights fails as unsupported.

Checked entries: the `MAGINALIA` application root, the `integration` directory, the
binding file, and the coordination root when it exists. The application root is one
more entry than the memo lists: whoever can write it can rename the checked children.
The existing directory-chain `lstat`/`realpath` reparse checks of `shelf-binding-store`
still run first.

### Private directory creation

Observed on the development machine: the inherited `%LOCALAPPDATA%` ACL grants an
AppContainer capability SID full control, so a directory created with plain `mkdir`
fails the rule above. Following the #84 contract ("private descriptor and coordination
directories use protected current-user/SYSTEM/Administrators ACLs; existing unsafe
entries are refused, not silently repaired"), the addon gains
`createPrivateDirectory(path)`: `CreateDirectoryW` with owner = current user and a
protected DACL `D:P(A;OICI;FA;;;<user>)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)`. Desktop's
binding store uses it for every missing integration directory component (Reviewer and
Collector share one store). Children created later, including the writer's
coordination directories, inherit only those three entries. An existing directory is
never re-permissioned; if it is unsafe, Collector writes stay disabled and the Desktop
command reports it.

Residual: `%LOCALAPPDATA%` itself is not checked, and an unprotected `MAGINALIA` root
created by an earlier build is refused rather than repaired.

## 3. Desktop commands

| Command ID | Menu | Behavior |
| --- | --- | --- |
| `maginalia.collector.configureSaveDestination` | ファイル → Collector の保存先を設定… | Resolves the Private Shelf from Desktop's `shelf_location.yml` and its typed marker, shows its `library.json` name, asks 「Collector の保存先をこの本棚に設定しますか？」 (or the "変更" variant when the stored binding names another Shelf), re-reads registry and marker, then persists the binding with the next generation. Already valid: an information dialog, no write. |
| `maginalia.collector.clearSaveDestination` | ファイル → Collector の保存先を解除… | Asks for confirmation and removes only `private-shelf-binding.json`. Shelf, journal, coordination directory and the Collector's pending requests are untouched. |

Both commands are renderer Command Registry entries (palette and native menu dispatch
the same ID). The renderer calls one IPC method; the main process owns all dialogs and
returns only a result kind, never paths, UUIDs or names. The configure flow reuses
`resolveReviewerShelfWriteCoordination`, so Reviewer and Collector share one binding
policy. An invalid, conflicting or changed marker, an unset Private Shelf, or an
unreadable existing binding shows an error dialog and writes nothing. After a write the
command runs the ACL check and warns when Collector writes would stay disabled.

## 4. Known limitation: single writer (#87 P1)

`persistShelfBinding` compares the stored generation before an atomic temp-file
rename, but that comparison is **not a cross-process compare-and-swap**. Two Desktop
processes that confirm different Shelves at the same moment could both pass the check,
and the later rename wins. This is accepted for α and documented rather than solved:
the binding is written only by an explicit Desktop UI action (Reviewer confirmation or
the commands above), the Host never writes it, and the Host re-validates the marker
UUID, locator digest and library on every request, so a lost update can at worst make
the Host fail closed or target the Shelf the user confirmed last.

## 5. Verification and not verified

Automated: `src/collector-path-security.test.ts` (policy with fakes, plus the real
addon on a disposable temp directory: private directory, junction refusal, Everyone
write refusal via `icacls` on a disposable file), `src/collector-shelf-configuration.test.ts`
(every fail-closed code, read-only behavior, real-addon positive case),
`src/collector-save-destination.test.ts` (confirm/decline/replace/refusals/clear).

NOT VERIFIED: the commands in a running Electron window (menu click, dialogs), the
binding written by Desktop and consumed by a separately installed Host, a second
Windows user, and behavior when the `MAGINALIA` root already exists with an
unprotected inherited ACL on a machine like the development machine.

## 6. Production Host entry (PR A2)

`apps/desktop/src/collector-native-host-product.ts` is the production Native Messaging
Host `org.maginalia.collector` (process entry: `collector-native-host-product-entry.ts`). It shares `collector-native-host-core.ts` (framing,
64 KiB requests, 1 MiB responses, envelope and `save_web_quote` validation) with the
developer entry `collector-native-host.ts`. The developer entry keeps the descriptor,
`MAGINALIA_COLLECTOR_TEST_ONLY=1` gate, descriptor coordination root and the
recovery probe; none of these exist in the production entry.

- Caller: Chrome's first argument must equal the compiled
  `chrome-extension://blgmoddncpknfnikdfnjelmdmphfgknf/` exactly. Otherwise every
  request answers `host_configuration_or_origin_invalid` before anything is read.
- No environment variable, cwd or descriptor file is read. The native addon is loaded
  only from a fixed code location (`useProductNativeAddonLocation`; Node entry: the
  compiled layout next to `dist/main`).
- `health` reports `writesEnabled: true` and advertises `save_web_quote` only while
  `readCollectorShelfConfiguration` is valid. `configured_shelf` returns the Shelf
  UUID, `library.json` name, `type: "private"` and `writesEnabled: true`, or the
  configuration error code.
- `save_web_quote`: request validation (`invalid_request`), then configuration
  (codes in section 1), then the unchanged `commitShelfQuoteWithNativeLock` with the
  fixed coordination root. A mutex acquisition timeout maps to `shelf_write_busy`,
  and any other writer failure maps to `save_failed`. A receipt is returned only
  after the writer has cleared `writer-recovery.json`, and only in state `committed`
  or `already-committed` for the requested ID and bound Shelf.
- stdout carries frames only. Responses and stderr carry no paths, path-to-UUID
  mapping or quote text.

Tests: `npm run test:collector-product-host` covers the unit cases (origin,
fail-closed codes, request validation, busy, receipt checks, real commit and
idempotent replay) and real child processes:
- the production entry with an attacker-style environment (valid test-only
  descriptor, test gate, bogus addon path, redirected `LOCALAPPDATA`) still answers
  `shelf_unconfigured` and creates nothing;
- a harness running the same loop with a disposable LocalAppData commits, replays
  `already-committed`, answers `shelf_write_busy` while another process holds the
  mutex, and fails closed for an Everyone-writable binding and a mismatched marker.

NOT VERIFIED: a real Chrome caller, the installed standalone executable, and the
Desktop Reviewer writing concurrently with the Host on a real Shelf.

## 7. Standalone Windows distributable (PR A3)

`npm run dist:collector-host` (apps/desktop, Windows x64) produces
`release/collector-host/`:

| File | Content |
| --- | --- |
| `payload/MAGINALIA-Collector-Host.exe` | Node SEA: `node --experimental-sea-config` blob of a Vite/Rolldown CJS bundle of `collector-native-host-product-entry.ts`, injected with `postject` (new direct devDependency, already in the lockfile transitively) |
| `payload/shelf_mutex.node` | the N-API 8 addon, static CRT (`/MT`); the build fails if it imports a VC++ runtime DLL |
| `payload/org.maginalia.collector.json` | host manifest: `name`, `type: stdio`, `path`, exactly one `allowed_origins` entry |
| `payload/PROVENANCE.txt` | commit SHA, Node/N-API/V8, postject, Vite, node-gyp, NSIS versions, SHA-256 of every shipped file |
| `payload/LICENSE.txt`, `payload/NOTICE.txt` | repository license and notice |
| `MAGINALIA-Collector-Host-Setup-<version>.exe` | per-user NSIS installer |
| `SHA256SUMS` | payload files and installer |

Build details:

- `@maginalia/format` reads its schemas from disk at import time. The bundler
  inlines the package's copied schema files, and the build fails if any non-builtin
  `require` remains in the bundle.
- SEA config sets `execArgv: []` and `execArgvExtension: "none"`. Verified on
  Node 24.14.0: `NODE_OPTIONS=--require …` and CLI runtime flags are ignored; without
  this setting the SEA honored `NODE_OPTIONS`.
- The addon is loaded only from `dirname(process.execPath)\shelf_mutex.node`
  (`useProductNativeAddonLocation("sea")`), selected by `node:sea`'s `isSea()`.
  In the SEA, `argv[1]` repeats the executable, so Chrome's origin stays at
  `argv[2]`.
- A build-time self-test bundles `scripts/collector-host-bundle-selftest.ts` with
  the same configuration and runs it against a disposable profile (binding, private
  directories, real ACL check, commit, idempotent resend, schema validation). The
  shipped executable cannot be redirected to a disposable profile by design.
- NSIS comes from electron-builder's checksum-pinned toolset
  (`app-builder-lib` `getMakeNsisPath`, NSIS 3.04, the same one the Desktop
  installer uses).

Installer (`packaging/collector-host/installer.nsi`):

- `RequestExecutionLevel user`, no UAC, fixed directory
  `%LOCALAPPDATA%\Programs\MAGINALIA Collector Host`, Japanese UI.
- Writes `HKCU\Software\Google\Chrome\NativeMessagingHosts\org.maginalia.collector`
  (default value = manifest path) and an Apps-list entry under `HKCU\…\Uninstall\MAGINALIACollectorHost`.
- The manifest `path` is the executable name, relative to the manifest folder (Chrome on
  Windows resolves it there). The manifest is then static ASCII, safe for non-ASCII
  user profile paths, and needs no install-time JSON escaping.
- Install over the top is the update.
- Uninstall deletes only the files it installed, the program folder when empty, the
  host key and the Apps entry. It never touches `%LOCALAPPDATA%\MAGINALIA`, a Shelf,
  or Chrome data.

`npm run smoke:collector-host` runs the built executable directly. It does not
install or register anything. It checks that, without a binding, `health` reports
`writesEnabled: false` and `configured_shelf`/`save_web_quote` return
`shelf_unconfigured`. It also checks: wrong or missing origin, frame errors, a copy
without the addon failing closed with `configuration_unavailable`, env and
`NODE_OPTIONS` injection ignored, and the real `%LOCALAPPDATA%\MAGINALIA` unchanged.

Known limitations / NOT VERIFIED:
- Binaries are unsigned (SmartScreen).
- The build is not byte-reproducible (linker timestamps).
- Node.js's own license text is not yet shipped beside the embedded runtime.
- Installer run, registry entries, Chrome discovery, Apps-list uninstall and
  update-over-top are deferred to the joint test with the owner.
