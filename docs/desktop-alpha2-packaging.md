# Desktop α2 packaging: native Shelf mutex addon

Since #87, the installed Desktop Reviewer writer loads its Windows
named-mutex addon from exactly one place:
`<resources>/shelf-mutex/shelf_mutex.node` (`src/shelf-native-mutex.ts`).
α1 did not ship this addon. α2 ships it through `extraResources`, which
resolves the installed-Desktop addon P0 raised in the #87 review. Bundling the
Collector Native Messaging Host into the installer is described in
"Collector payload (WP-4)" below.

## Build flow

`npm run dist:windows` (repository root) runs these steps in order:

1. `package:windows:runtime`: Reviewer, NDLOCR, pandoc, contracts and tutorial.
2. `build:native`: `node-gyp rebuild` with N-API 8 and the static CRT (`/MT`).
3. `package:windows:stage`: `scripts/shelf-mutex-addon.mjs` checks the addon
   and fails closed if it is missing or wrong. It then copies the addon and
   `PROVENANCE.json` to `packaging/runtime/shelf-mutex/`. The checks are:
   - `binding.gyp` still declares `NAPI_VERSION=8` and `RuntimeLibrary "0"`;
   - the file is a PE32+ x64 DLL;
   - it imports no VC++ runtime DLL;
   - it loads in Node and exposes the mutex API.
4. `package:windows:installer`: NSIS build. `extraResources` maps
   `packaging/runtime/shelf-mutex` (only `shelf_mutex.node` and
   `PROVENANCE.json`) to `<resources>/shelf-mutex`.

`package:windows:dir` builds the same tree without NSIS.

## Verifying a built package

`node scripts/verify-packaged-shelf-mutex.mjs <win-unpacked>` checks:

- the packaged file's SHA-256 against the shipped and staged provenance;
- that the packaged executable, run as Node (`ELECTRON_RUN_AS_NODE=1`) from
  an unrelated working directory, uses the product loader inside `app.asar`
  in packaged mode, with exactly the one resources candidate, and can acquire
  and release a mutex.

This verifies the directory tree that NSIS wraps. It is **not** an NSIS
installation PASS. Installing, upgrading and uninstalling the NSIS package
remain manual acceptance steps.

## Collector payload (WP-4)

The Desktop installer carries the Collector Native Messaging Host and the Collector
Chrome extension as read-only resources. Nothing is registered or written outside the
install directory by the installer; the app places and registers the Host at runtime
(`collector-wizard-integration-design.md` sections 2 and 3). The earlier standalone
Host installer (`installer.nsi`, `dist:collector-host`) no longer exists.

Resources layout (`extraResources`):

```text
<resources>/collector-host/        MAGINALIA-Collector-Host.exe, shelf_mutex.node,
                                   LICENSE.txt, NOTICE.txt, NODE-LICENSE.txt, PROVENANCE.txt
<resources>/collector-extension/   the exact Collector release file list, verbatim bytes
<resources>/collector-payload.json descriptor (hashes), informational copy of compiled constants
```

`dist:windows` flow with the payload:

1. `package:windows:runtime`, then `build:native` (unchanged).
2. `package:windows:collector-host`: `scripts/build-collector-host.mjs` builds the Host
   payload into `release/collector-host/payload/` using the Node.js that runs it
   (>= 24, with its `LICENSE` next to `node.exe`; a pinned official distribution is
   recommended). The Host addon is the `build:native` output, not a rebuild.
3. `package:windows:stage`: `scripts/stage-collector-payload.mjs` verifies the pinned
   Collector ZIP and copies the payload into `packaging/runtime/`. The checks are:
   - the ZIP SHA-256 equals `runtime-versions.json` `collectorExtension.sha256`;
   - strict extraction: no absolute, `..`, backslash, colon or control-character names, no
     directories, nested paths, links or other non-regular entries, no duplicates
     (case-insensitive), no entry outside the pinned file list and none missing, no
     encryption, ZIP64, comment or trailing bytes, CRC-32 and sizes verified, size
     limits (ZIP 4 MiB, entry 2 MiB, total 8 MiB, 64 entries);
   - `manifest.json` has Manifest V3 and the pinned `version`;
   - the extension ID derived from `manifest.key` (SHA-256 of the DER key, first 32 hex
     digits mapped `0-f` to `a-p`) equals the pin and the Host constant
     `COLLECTOR_EXTENSION_ID`;
   - the Host `shelf_mutex.node` is byte-identical to the staged Shelf mutex addon.
   Any mismatch fails the build. `collector-payload.json` is generated here.
4. `package:windows:installer` / `package:windows:dir` (unchanged).

Pin data lives in `packaging/runtime-versions.json` under `collectorExtension`
(version, asset, release URL, SHA-256, extension ID, file list). The pinned URL is the
conventional GitHub Release asset URL of `potoha/MAGINALIA-Collector`.

### Local ZIP for an unpublished release

Until the release exists, pass the ZIP produced by the Collector repository
(`node scripts/build-dist.mjs`, `dist/maginalia-collector-0.3.0.zip`) with the explicit
build-time flag, an absolute path:

```text
npm run package:windows:stage -- --collector-zip D:\path\to\maginalia-collector-0.3.0.zip
```

The ZIP is still verified against the pinned SHA-256 and every check above; the flag
only replaces the download. There is no environment-variable or runtime equivalent and
no unpinned mode. To run the whole chain with a local ZIP, run the `dist:windows`
steps individually (the flag reaches only the stage step).

### Descriptor

`collector-payload.json` follows design section 2.1 exactly (`version`, `payloadId`,
`host`, `extension`, `protocol`). The JSON Schema is
`packaging/collector-payload.schema.json` and a typed example is
`packaging/collector-payload.example.json`. The Host's allowed origin list is not part
of the descriptor; it stays in the Host source (`collector-native-host-product.ts`).

### Verifying a built package

`node scripts/verify-packaged-collector-payload.mjs <absolute win-unpacked directory>`
is read-only and executes nothing. It re-hashes the Host files and the extension tree
against the descriptor, checks the descriptor against the pin and the Host constant,
requires exactly the expected regular files, and checks that the Host addon equals
`<resources>/shelf-mutex/shelf_mutex.node`.

### What remains manual or NOT VERIFIED

- The Collector `v0.3.0` GitHub Release is not published; the pinned URL has not been
  fetched.
- A full `dist:windows` with the payload and an NSIS install were not run.
- Runtime placement and registration, Chrome behaviour and uninstall cleanup belong to
  later work packages.
- Collector license text is not part of the release ZIP file list; the Host notices
  (`collector-host/NOTICE.txt`, and copies in `THIRD-PARTY-NOTICES`) cover the Host only.

## Upgrade over α1

Statically compared with tag `v0.1.0-alpha.1`. These are unchanged:

- `appId` `org.maginalia.desktop.alpha1`;
- `productName` and shortcut name `MAGINALIA desktop α1`;
- `nsis.perMachine: false` and `deleteAppDataOnUninstall: false`;
- the staged app manifest name (`@maginalia/desktop`);
- `application-identity.ts`, which pins the profile Electron selected before
  `setName`;
- electron-builder 26.15.3 and Electron 44.3.0.

An install over α1 therefore resolves the same userData directory and keeps
it. The packaged default userData comes from the staged manifest `name` (see
below), so that name must not change. `appId` and `productName` also drive
the NSIS install identity, the install directory, the executable name and the
shortcut. Keep both unchanged for an in-place upgrade over α1.

## Local verification record (2026-11-13)

Built from commit `ad6bc2178b3a1833fef36e7864305fdd3d26e948` on Windows x64
with Node 24.14.0, electron-builder 26.15.3 and Electron 44.3.0. The build ran
`npm run dist:windows`. The installer was **not** run.

| Item | Value |
| --- | --- |
| Installer | `MAGINALIA-desktop-0.1.0-Setup.exe`, 412,333,681 bytes, SHA-256 `607ef07bf7491ff4cf0535b710eb3730a0040bfa72524e6720db6179cc1a6e30` |
| Version | `0.1.0`, unchanged; the α2 version number awaits an owner decision |
| Addon | `shelf_mutex.node`, 157,184 bytes, SHA-256 `74701bdb8759628b2f2a5e3a9d84050344eea4af57ee9ab12050b77d5e68f431`, N-API 8, `/MT`, no VC++ runtime imports |
| `verify-packaged-shelf-mutex` on the `win-unpacked` tree NSIS wrapped | PASS: packaged mode, single candidate `shelf-mutex\shelf_mutex.node`, acquire and release OK under ELECTRON_RUN_AS_NODE (Electron 44.3.0, Node 24.20.0) |
| `e2e-isolation-smoke` against the packaged `win-unpacked` executable | PASS 4/4 (see `desktop-e2e-isolation.md`) |
| NSIS install, upgrade over α1, uninstall | NOT VERIFIED (owner joint test) |

The packaged `app.asar/package.json` has `name: "@maginalia/desktop"` and no
`productName`. The default packaged userData is therefore derived from that
name, as it was in α1. This was derived statically and not observed on an
installed α1 profile.

### Build host notes

- With `core.autocrlf=true`, the checkout converts
  `sidecars/reviewer/ndlocr-runtime/licenses/dependencies/ordered-set-MIT-LICENSE.txt`
  to CRLF. The pinned-license SHA-256 check then fails. This is the same class
  of failure as the existing `tutorial-sample.test.ts` CRLF failure. Fix: check
  that file out with LF.
- `build-windows-runtime.mjs` calls `tar.exe`. Under Git Bash this resolves to
  GNU tar, which treats `D:` as a remote host. Run `dist:windows` from
  PowerShell or cmd so that `System32\tar.exe` is used.
