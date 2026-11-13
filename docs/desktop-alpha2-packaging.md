# Desktop α2 packaging: native Shelf mutex addon

Since #87, the installed Desktop Reviewer writer loads its Windows
named-mutex addon from exactly one place:
`<resources>/shelf-mutex/shelf_mutex.node` (`src/shelf-native-mutex.ts`).
α1 did not ship this addon. α2 ships it through `extraResources`, which
resolves the installed-Desktop addon P0 raised in the #87 review. Bundling the
Collector Native Messaging Host into the installer (#83) is not part of this
change.

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

## Upgrade over α1

Release name: "MAGINALIA Alpha2 Wild Berry" (Desktop version 0.2.0). Statically
compared with tag `v0.1.0-alpha.1`. These are unchanged:

- `appId` `org.maginalia.desktop.alpha1`. electron-builder derives `APP_GUID`
  (`8ba6d801-d7a1-5c90-8a01-7a051a834c58`) and the NSIS install and uninstall
  registry keys from it; the generated value is identical for α1 and α2;
- `nsis.perMachine: false`, `deleteAppDataOnUninstall: false` and
  `allowToChangeInstallationDirectory: false`;
- the staged app manifest name (`@maginalia/desktop`), which decides the
  packaged default userData directory (`%APPDATA%\Electron`);
- `establishApplicationIdentity`, which captures the profile Electron selected
  before `setName` and pins it afterwards, so the display-name change cannot
  move userData (`application-identity.test.ts` pins this);
- electron-builder 26.15.3 and Electron 44.3.0.

These change with the release name: `productName` and `shortcutName`
(`MAGINALIA Alpha2 Wild Berry`), the executable name derived from `productName`
(`MAGINALIA Alpha2 Wild Berry.exe`) and the version.

### Install directory and shortcuts (static analysis, installer not run)

- A fresh install goes to `%LOCALAPPDATA%\Programs\<productName>`. An upgrade
  over α1 does not: the NSIS template reads `InstallLocation` from the
  `APP_GUID` registry key and reuses it, so α2 installs into the existing
  α1 folder (`...\Programs\MAGINALIA desktop α1`). The folder name therefore
  stays α1 after an upgrade, which is cosmetic.
- electron-builder runs the α1 uninstaller first (`--updated`, user data is
  kept). Because the executable name changes, `--keep-shortcuts` is not passed,
  so the α1 uninstaller deletes the α1 Start Menu shortcut and the installer
  creates the new one.
- The α1 uninstaller does not remove the optional Desktop shortcut (it is
  created by `installer-shortcut.nsh`). `installer-shortcut.nsh` therefore
  deletes `MAGINALIA desktop α1.lnk` on the Desktop only when its target is
  `<INSTDIR>\MAGINALIA desktop α1.exe`, checked with Windows PowerShell and
  `WScript.Shell`, and then creates `MAGINALIA Alpha2 Wild Berry.lnk`. If the target
  differs or the check fails, nothing is deleted.
- Not verified on a machine: the above is derived from the electron-builder
  template and from compiling both α1 and α2 installers (stubbed payload) and
  comparing the generated defines. The PowerShell fragment was run on its own
  against a temporary shortcut.

## Local verification record (2026-11-13)

Built from commit `ad6bc2178b3a1833fef36e7864305fdd3d26e948` on Windows x64
with Node 24.14.0, electron-builder 26.15.3 and Electron 44.3.0. The build ran
`npm run dist:windows`. The installer was **not** run.

| Item | Value |
| --- | --- |
| Installer | `MAGINALIA-desktop-0.1.0-Setup.exe`, 412,333,681 bytes, SHA-256 `607ef07bf7491ff4cf0535b710eb3730a0040bfa72524e6720db6179cc1a6e30` |
| Version | `0.1.0` at the time of this record; the α2 release is now 0.2.0 |
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
