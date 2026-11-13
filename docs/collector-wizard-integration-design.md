# Collector integration in the Desktop installer and first-run wizard (α2 design)

- **Status:** design proposal for review. No product code is changed by this
  document. Nothing here is DONE; every acceptance item below is NOT VERIFIED
  until the work packages in §9 produce evidence.
- **Base:** `codex/alpha2-rc` at `5098f81` (product Host, binding/ACL code, α2
  addon packaging, command-coverage fixes).
- **Product Owner decision (2026-11-13):** customers cannot handle several
  separate installers. The Host installation and Collector linking move into the
  MAGINALIA Desktop installer and first-run flow. The Collector extension stays an
  unpacked extension loaded in Chrome developer mode for now; the wizard guides
  that step. A later Chrome Web Store release will replace the unpacked guidance
  and will change the extension ID, so `allowed_origins` must accept more than one
  ID. Installer image assets are out of scope.

## 0. Canonical sources checked

| Source | What it fixes for this design |
| --- | --- |
| MAGINALIA_IDE `docs/collector-host-alpha-profile.md` (branch `docs/collector-alpha-host-profile`, `f627221`) | Current α choices: fixed extension ID, SEA Host + addon, HKCU per-user registration, relative manifest `path`, data-preserving uninstall, binding file as the only production descriptor, ACL rule, protocol `maginalia.collector.experimental.v1`, error codes. |
| MAGINALIA_IDE `docs/decisions/0019-collector-native-messaging-host.md` (D070/D071/D072, shared-binding invariants) | Exact-origin allow list, Host limited to the configured Private Shelf, binding written only by Desktop on explicit user action, no silent adoption/repair, fixed OS-derived per-user roots, fail closed. |
| MAGINALIA_IDE `plan/30_MAGINALIA_COLLECTOR_REQUIREMENTS.md` §2.3, §5.1–§5.5, §6 (α2 items 13–16), §8 | Unpacked distribution, α2 "Installer / 初期設定" integration, click-by-click Japanese flow sheet, "導入成功と接続成功を別々に判定", no silent install into unsupported browsers, Chrome-first browser scope. |
| MAGINALIA_IDE `plan/09_DECISION_LOG.md` D007, D023, D032, D070–D072 | First user is a non-technical humanities user; normal install needs no developer tools. |
| MAGINALIA_IDE `plan/12_DISTRIBUTION_AND_ONBOARDING.md` §1, §9, §11–§13, §16–§17 | No developer concepts in the normal path (a β1 blocker otherwise), setup errors must not strand the user, uninstall keeps research data. |
| MAGINALIA_IDE `plan/22_WORKDESK_BROWSER_INSTALLER.md` §3 (Windows registry, Uninstall, Clean-machine acceptance) | Installer registers only ordinary application integration; never research data or paths of research data in the registry. |
| This repository: `docs/collector-host-binding.md`, `docs/desktop-alpha2-packaging.md`, `docs/desktop-e2e-isolation.md`, `docs/collector-native-host-smoke.md` | Implemented Host, standalone installer, α1→α2 upgrade identity, E2E isolation harness. |
| Collector repository PRs #26–#28 (`codex/collector-dist-zip`, `fd45c4a`) | `manifest.json` with `key`, version 0.2.0, `host-client.js` strict response parsing, `onboarding.html`, `scripts/build-dist.mjs` allow-listed ZIP. |

### 0.1 Conflicts with canonical documents (stated, not silently resolved)

1. **α profile §2 says "bundling the Host into [the Desktop Installer] is out of
   α scope (Desktop #83)".** The 2026-11-13 Product Owner decision supersedes
   this for α2. The profile must be updated (WP-0). This is a delivery change,
   not a change to the Host trust boundary.
2. **D023 / plan 12 §17 vs. Chrome developer mode.** Loading an unpacked
   extension requires Chrome's 「デベロッパー モード」, which is a developer
   concept. Plan 30 §5.1 already accepts unpacked distribution for α, and the
   Product Owner re-confirmed it on 2026-11-13. **Recommendation:** record an
   α2-scoped exception in the Decision Log; the Web Store release (§7) is a β1
   prerequisite under plan 12 §17. No terminal, Node, PowerShell or PATH step is
   introduced, so the rest of D023 holds.
3. **Plan 22 §3 "Windows registry"** lists only Add/Remove Programs, identity
   and shortcuts. A per-user Chrome Native Messaging registration is ordinary
   application integration and contains only a program-file path, never research
   data. **Recommendation:** add it to that list (WP-0).
4. **Plan 30 §5.2** says "Installer places the verified distribution files". This
   design places them from the first-run wizard after user consent (the same
   section allows "インストール時／初期設定時"). Compatible; plan 30 §8 item 2 is
   answered by this design once accepted.
5. Found while reading, not fixed here: `plan/30_MAGINALIA_COLLECTOR_REQUIREMENTS.md`
   on MAGINALIA_IDE `main` still contains unresolved merge-conflict markers in its
   header (lines 8–15). It needs a separate docs fix.

## 1. Goal, non-goals and fixed decisions

### Goal

A user installs one program (`MAGINALIA-desktop-<version>-Setup.exe`), completes
the first-run wizard, and ends with: the Host registered for their Windows user,
the Collector extension folder placed and loaded in Chrome, the save destination
confirmed, and a verified connection — without a second installer, a ZIP, a
terminal or a hidden folder hunt.

### Non-goals

- Silent or forced installation of the extension into Chrome (not possible for
  normal users and not wanted; plan 30 §5.2).
- Browsers other than Google Chrome (stable) on Windows x64; machine-wide (HKLM)
  registration; Chrome Beta/Dev/Canary; macOS/Linux.
- Code signing, installer artwork, the α2 version number.
- Changing the Host protocol semantics, the binding schema, the ACL rule, D071
  coordination, Shelf JSON, or the Reviewer path.
- Reviewer capture staging (still disabled; ADR 0019).

### Decisions already fixed (input to this design)

- One Desktop installer; the standalone Host installer is no longer a release
  deliverable.
- Extension stays unpacked (developer mode) in α2; the wizard guides loading it.
- Web Store later; extension ID changes then; `allowed_origins` must allow a list.
- Uninstall removes Host files, the HKCU key and the placed extension folder, and
  never removes `%LOCALAPPDATA%\MAGINALIA` data, any Shelf, Workdesk, Project, or
  Chrome profile data.

## 2. Desktop installer content

### 2.1 What ships inside the Desktop NSIS installer

All Collector material ships **read-only inside the application resources**. The
installer itself writes nothing outside the normal install directory for it.

```text
<resources>/collector-host/
  MAGINALIA-Collector-Host.exe     Node SEA (unchanged build recipe)
  shelf_mutex.node                  same addon build as <resources>/shelf-mutex
  LICENSE.txt NOTICE.txt NODE-LICENSE.txt PROVENANCE.txt
<resources>/collector-extension/
  manifest.json ... (exact Collector release file list, verbatim bytes)
<resources>/collector-payload.json  payload descriptor (below)
<resources>/windows-integration/
  windows_integration.node          Desktop-only addon (§3.3)
  PROVENANCE.json
```

There is **no host manifest template file** in resources. The Desktop app
generates the manifest at runtime from compiled constants (§3.4), so no packaged
file can redirect `path` or widen `allowed_origins`.

`collector-payload.json` is generated at build time and its SHA-256 values are
also compiled into the main-process bundle as constants (the copy in resources is
informational; the compiled constants are authoritative):

```json
{
  "version": 1,
  "payloadId": "<desktop version>+<short commit>",
  "host": { "version": "<desktop version>", "files": { "MAGINALIA-Collector-Host.exe": "<sha256>", "shelf_mutex.node": "<sha256>" } },
  "extension": { "version": "<collector manifest version>", "id": "blgmoddncpknfnikdfnjelmdmphfgknf", "zipSha256": "<sha256>", "files": { "manifest.json": "<sha256>", "...": "..." } },
  "protocol": "maginalia.collector.experimental.v1"
}
```

### 2.2 Extension source and version pinning

- The Desktop repository pins **one Collector GitHub Release asset** in
  `apps/desktop/packaging/runtime-versions.json`, following the existing pandoc
  pattern:

  ```json
  "collectorExtension": {
    "version": "0.3.0",
    "asset": "maginalia-collector-0.3.0.zip",
    "url": "https://github.com/potoha/MAGINALIA-Collector/releases/download/v0.3.0/maginalia-collector-0.3.0.zip",
    "sha256": "<sha256 from the release SHA256SUMS>",
    "extensionId": "blgmoddncpknfnikdfnjelmdmphfgknf"
  }
  ```

- The staging step (WP-4) downloads the asset, verifies the SHA-256, extracts it
  with an allow-list extractor (reject absolute names, `..`, backslashes,
  duplicates, directories other than those in the ZIP, entries outside the
  release list), checks `manifest.json` is at the root, that its `version` equals
  the pin, and **derives the extension ID from `manifest.key`** (SHA-256 of the
  DER public key, first 32 hex digits mapped `0-f → a-p`) and requires it to
  equal both the pin and the Host constant `COLLECTOR_EXTENSION_ID`. Any mismatch
  fails the build.
- A developer may pass a local ZIP to the staging script for an unreleased
  Collector build. The resulting package records `unpinned` in `PROVENANCE` and
  `npm run dist:windows` refuses it; release builds use the pin only.
- **Release mapping:** each Desktop release ships exactly one Collector version.
  Collector releases independently on GitHub (for developers and as the pinned
  source); a Collector fix reaches normal users only through a Desktop release
  that bumps the pin. The Desktop release notes name the bundled Collector
  version. The Collector repository's install guide changes its primary path to
  "install MAGINALIA Desktop" (WP-1c).

### 2.3 Install, upgrade, uninstall

| Event | Behaviour |
| --- | --- |
| Fresh install | Normal Desktop install. Resources contain the payload. No registry or files outside the install directory are written by the installer. First-run offers the Collector step. |
| α1 → α2 upgrade | Unchanged identity (`appId`, `productName`, `perMachine: false`, staged manifest `name`) keeps userData, Workdesk, Shelf and the first-run journal. α1 had no Collector, so nothing is migrated. First-run does not reappear; a one-time notice offers the Collector setup (§5). |
| Desktop update (α2 → α2.x) | Installer replaces resources only. The placed Host and extension are refreshed by the app on next start if the user opted in (§6). A Host process held open by Chrome cannot block the installer, because no Host runs from the install directory. |
| Uninstall | `customUnInstall`, **only when not `${isUpdated}`**, removes the integration (§2.4). It never touches `%LOCALAPPDATA%\MAGINALIA` (binding, coordination, journal, recovery marker), Shelf, Workdesk, Projects, or Chrome profile data (including the Collector Outbox). `deleteAppDataOnUninstall` stays `false`. |

electron-builder's assisted NSIS runs the previous version's uninstaller during
an update and passes `--updated`; `customUnInstall` runs in both cases, so the
`${isUpdated}` guard is mandatory. Its update path also renames `$INSTDIR`
atomically and aborts if a file is busy (`uninstaller.nsh`), which is a second
reason not to execute the Host from the install directory.

### 2.4 Uninstall cleanup

The uninstaller removes only fixed names inside the fixed program folder
(§3.4), never with an unbounded recursive delete:

1. Read `HKCU\Software\Google\Chrome\NativeMessagingHosts\org.maginalia.collector`
   (default value). Delete the key **only if** the value equals
   `$LOCALAPPDATA\Programs\MAGINALIA Collector\org.maginalia.collector.json`
   (case-insensitive). A foreign value is left untouched and the folder cleanup
   still runs.
2. In `$LOCALAPPDATA\Programs\MAGINALIA Collector`, refuse to continue if that
   folder or any fixed child directory is a reparse point.
3. Delete fixed files: the manifest, `integration-state.json`, the two Host slots'
   fixed file names, the `licenses` files, and the extension files from
   `packaging/collector-extension-files.json` — an append-only union of every
   Collector file name ever pinned, so files from an older placed version are
   covered. `RMDir` (non-recursive) each fixed directory, then the root.
4. Unknown files are left in place; the folder then remains. That is the safe
   failure.

Limitation: if the user chose "all users" on electron-builder's install-mode page
(shown because `oneClick: false` and `perMachine: false`), the uninstaller may run
elevated as another account and can only clean that account's HKCU and
LocalAppData. The registration is per user by design; the in-app
「Collector 連携を解除…」 command (§5) is the reliable removal for such users and
the release notes must say so. Forcing per-user installs would require changing
`oneClick` (losing the custom component pages) or customizing the template, so it
is not proposed for α2.

### 2.5 What happens to the standalone Host installer

- `packaging/collector-host/installer.nsi`: **delete**. A second registrar for
  the same HKCU key would compete with the Desktop-managed registration and
  confuse support. Git history keeps it.
- `scripts/build-collector-host.mjs`: **keep, reduced to the payload builder**
  (SEA bundle, addon, licenses, NOTICE, PROVENANCE, self-test). Remove the NSIS
  step, the static manifest file, the installer artifact and its SHA256SUMS line.
  It becomes a stage step of `dist:windows` (WP-4). `smoke:collector-host` keeps
  running the built executable directly.
- Developer testing of Chrome ↔ Host uses the packaged app's own setup command in
  a disposable Windows user, or the existing test-only Host with unique test host
  names (`collector-native-host.ts`, Collector `dev/native-host-smoke`).
- A tester who installed the standalone Host is migrated by the wizard (§4.3,
  state "foreign registration").

## 3. Who writes the registry and the files

### 3.1 Options compared

| Criterion | A. Desktop installer (NSIS `customInstall`) | B. Desktop app at runtime (wizard / commands) |
| --- | --- | --- |
| UAC-free per-user | Only if the user picks "only me". With "all users" the installer is elevated and, under over-the-shoulder elevation, writes **the admin's** HKCU. | Always the interactive user, no elevation, regardless of install mode. |
| Consent / plan 30 §5.2 | Registers before the user has chosen to use Collector or Chrome has been detected ("黙ってファイルを投入しない" is violated for users without Chrome). | Registers only after the user starts the Collector step and Chrome detection. |
| Idempotency | Re-running the whole installer. | One state machine (§3.5) that converges and reports every state. |
| Repair after Chrome or profile changes | Needs reinstall. (Chrome profile resets do not remove HKCU registrations, but cleaners, the old standalone uninstaller and manual edits do.) | 「確認・修復」 command, no reinstall. |
| Update sync and locked exe | Host in `$INSTDIR` is overwritten/renamed during update; a running Host aborts the update. | A/B Host slots: the app writes the inactive slot and atomically switches the manifest; a running Host is never overwritten. |
| Uninstall | Natural place. | Still needs NSIS cleanup (§2.4). |
| Security | No new app code that writes the registry. | Main process gains a narrowly-scoped registry writer (§3.3); renderer cannot influence it. |

### 3.2 Recommendation: B, with NSIS cleanup on uninstall

The Desktop **app** (main process) places the files and writes the HKCU value,
from the wizard or the Collector commands, after explicit user action. The
installer only ships the read-only payload and removes the integration on real
uninstall. Reasons: it is the only option that is correct for both install modes
without elevation, it honours consent and browser detection, it gives one
idempotent repair path, and the slot scheme removes the locked-exe update failure.

The accepted cost is that the app can write one HKCU value. §3.3 bounds that
writer so no input can choose the key, the value or the files.

### 3.3 Pinned constants and the registry writer

All locations are compile-time constants combined with OS known folders. Nothing
is derived from environment variables, cwd, the executable location, argv,
renderer input or browser input.

| Constant | Value |
| --- | --- |
| Host name | `org.maginalia.collector` |
| Registry key (HKCU, default value) | `Software\Google\Chrome\NativeMessagingHosts\org.maginalia.collector` |
| Program folder | `<FOLDERID_UserProgramFiles>\MAGINALIA Collector` (normally `%LOCALAPPDATA%\Programs\MAGINALIA Collector`) |
| Manifest path (registry value) | `<program folder>\org.maginalia.collector.json` |
| Host slots | `<program folder>\host-a\`, `<program folder>\host-b\` |
| Extension folder (stable, given to Chrome) | `<program folder>\extension\` |
| Staging names | `extension.next\`, `extension.prev\`, `host-*.tmp-<random>` files |
| Allowed origins | `COLLECTOR_ALLOWED_ORIGINS` = `["chrome-extension://blgmoddncpknfnikdfnjelmdmphfgknf/"]` |

The program folder is deliberately **outside** `%LOCALAPPDATA%\MAGINALIA`, so
"never delete `%LOCALAPPDATA%\MAGINALIA`" and "remove Host files" never overlap.
It is also distinct from the standalone folder `MAGINALIA Collector Host`.

**Desktop-only native addon `windows_integration.node`** (WP-3), separate from
`shelf_mutex.node` so the Host binary gains no registry-writing code:

- `getKnownFolderPath(id)` for `UserProgramFiles`, `LocalAppData`,
  `ProgramFiles`, `ProgramFilesX86` (fixed enum, `SHGetKnownFolderPath`).
- `readRegistryValue(hive, subkey, name, view)` — read-only; `hive` ∈ {HKCU,
  HKLM}; used for registration status, Chrome App Paths, default-browser ProgId
  and Chrome policies. Returns UTF-16-decoded strings (avoids `reg.exe` console
  code-page corruption of Japanese profile paths).
- `registerCollectorHost()` — **no arguments.** C++ computes the manifest path
  from `FOLDERID_UserProgramFiles` + the constant suffix and writes the default
  value of the constant key under HKCU (`RegCreateKeyExW`, `REG_SZ`). Returns
  `ok | access-denied | failed`.
- `unregisterCollectorHost()` — no arguments. Deletes the constant key only when
  its default value equals the constant path; otherwise returns `foreign`.
- `replaceForeignCollectorHostRegistration()` — no arguments; same write as
  `registerCollectorHost()`, called only after the user confirms the
  foreign-registration dialog.

There is no product option, environment variable or CLI switch that changes the
key, the hive or the path. Tests that must not touch the real registry inject a
TypeScript adapter (`CollectorRegistryAdapter`) into
`createCollectorIntegrationService(deps)`; production code calls
`createProductCollectorIntegrationService()` with no parameters. A unit test
asserts that `collector-integration*.ts` and `windows-integration.ts` contain no
`process.env`, `process.cwd`, `process.argv` or `app.getPath` reads.

In a launch where `MAGINALIA_E2E_ISOLATION_ROOT` is set, the integration service
**refuses** every registry or program-folder write (「テスト用の起動では Collector
連携を設定できません。」). The variable can only disable, never redirect.

### 3.4 Generated manifest

Written by the app with exclusive-create temp + rename in the program folder:

```json
{
  "name": "org.maginalia.collector",
  "description": "MAGINALIA Collector Native Messaging Host",
  "path": "host-b\\MAGINALIA-Collector-Host.exe",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://blgmoddncpknfnikdfnjelmdmphfgknf/"]
}
```

`path` stays relative and ASCII, so non-ASCII Windows user names need no JSON
escaping. Chrome resolving a relative path **with a subdirectory** must be
confirmed by the WP-2 spike; the fallback is an absolute, JSON-escaped path
written by the same generator.

### 3.5 Integration state machine (main process)

`inspect()` is read-only and returns one of:

| State | Meaning |
| --- | --- |
| `not-set-up` | No program folder, no registration. |
| `policy-blocked` | Chrome policy forbids user-level hosts or blocklists the name (§8.4). |
| `foreign-registration` | Key exists but points elsewhere (standalone Host, other software, tampering). |
| `registration-missing` | Program folder is ours but the key is missing. |
| `outdated` | Ours, but `integration-state.json.payloadId` differs from the compiled payload. |
| `damaged` | Ours, but a hash, manifest content or slot is wrong, or a reparse point was found. |
| `ready` | Key, manifest, active slot and extension folder match the compiled payload. |

`apply(intent)` converges: `setup` (from `not-set-up`), `refresh` (from
`outdated`, automatic for opted-in users, §6), `repair` (from
`registration-missing`/`damaged`/`foreign-registration`, user-confirmed),
`remove`. Each step order keeps Chrome's view consistent:

- **Setup/refresh:** create the program folder (protected DACL: current user,
  SYSTEM, Administrators — same helper as the integration folder; an existing
  folder that fails `collector-path-security` checks is never re-permissioned and
  fails closed) → write inactive slot (§8.3) → verify → stage `extension.next` →
  swap extension folders → write manifest (temp + rename) → write registry
  (setup/repair only; a refresh keeps the same value) → write
  `integration-state.json` → self-check.
- **Remove:** delete registry key (value-matched) → delete manifest → delete
  slots (a locked file is retried at next start; Chrome can no longer launch it)
  → delete extension folders → delete state file → `RMDir`.

`integration-state.json` (program folder) holds only `{version: 1, payloadId,
activeSlot, extensionVersion, placedAt}` — no paths, no Shelf data.

**Self-check:** the app resolves the registration exactly as Chrome would
(registry value → manifest → `path`), spawns that executable with
`chrome-extension://<id>/` as its first command-line argument (as Chrome does),
sends `health` and `host_info` frames, and
requires the protocol identifier and `host.version` equal to the compiled values.
It proves the registry → manifest → exe → addon chain and reports
`writesEnabled`. It does not prove that Chrome or the extension works.

## 4. Wizard flow

### 4.1 Placement

- The Collector setup is one renderer panel, 「Collector 連携の設定」, opened by
  the command `maginalia.collector.setup`. First-run, the menu and the α1→α2
  notice dispatch the same command (Command surface principle).
- First-run: after the existing setup completes, the completion card adds a
  secondary section above 「MAGINALIAを開く」. The Collector step is **not** a
  `FirstRunJournal` stage; first-run is complete without it and 「あとで設定」
  writes nothing.
- IPC carries intents only (`inspect`, `setup`, `openChromeExtensions`,
  `copyExtensionPath`, `revealExtensionFolder`, `configureSaveDestination`,
  `startConnectionCheck`, `remove`). The renderer never sends a path. The only
  path that reaches the renderer is the extension folder string, for display and
  copy; it is never logged.

Step order: **A** intro + Chrome detection → **B** Host registration → **C** save
destination → **D** load the extension in Chrome → **E** connection check → done.
The destination is confirmed *before* loading the extension, so Collector's own
「はじめに」 page (opened by Chrome on install) already shows the Host and the
Shelf as ready.

Header on every step: 「手順 {n} / 5」 as text (not colour only).

### 4.2 Step A — intro and Chrome detection

Copy:

- Title: 「Chrome で集めた引用を本棚へ（MAGINALIA Collector）」
- Body: 「MAGINALIA Collector は、Google Chrome で読んでいる Web ページの文章を、MAGINALIA の Private Shelf（本棚）に保存する拡張機能です。設定には 5 分ほどかかります。途中で Chrome の画面を操作していただく手順があります。」
- List:
  - 「このパソコンのあなたのユーザーだけに、MAGINALIA 連携プログラムを登録します（管理者権限は不要です）。」
  - 「拡張機能のフォルダーを用意し、Chrome に読み込む手順をご案内します。」
  - 「保存先の本棚を確認していただきます。本棚のファイルは変更しません。」
- Buttons: [設定を始める] (primary) / [あとで設定]
- Note: 「あとからでも、メニューの「ファイル」→「Collector 連携を設定…」で始められます。」

Chrome detection (read-only, before any write):

1. `HKCU\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe` (default value).
2. `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe` (64-bit, then 32-bit view; readable by standard users).
3. `<LocalAppData>\Google\Chrome\Application\chrome.exe`, `<ProgramFiles>\Google\Chrome\Application\chrome.exe`, `<ProgramFilesX86>\Google\Chrome\Application\chrome.exe` (known folders).

A candidate is accepted only if it is an absolute local path whose basename is
`chrome.exe`, exists as a regular file and has no reparse point in its chain. The
default browser (`HKCU\...\UrlAssociations\https\UserChoice`, `ProgId`) is read
only to tailor the copy; it never blocks.

| Result | Copy | Actions |
| --- | --- | --- |
| Found, default is Chrome | 「Google Chrome が見つかりました。」 | [次へ] |
| Found, default is another browser | 「Google Chrome が見つかりました。Collector は Google Chrome で使います。ふだん別のブラウザーをお使いの場合も、引用を集めるときは Chrome を開いてください。」 | [次へ] |
| Not found | 「Google Chrome が見つかりませんでした。Collector は現在、Google Chrome でのみ使えます。Chrome をインストールしてから、もう一度確認してください。」 | [Chrome のダウンロードページを開く] [もう一度確認] [Chrome は入っています（このまま続ける）] [あとで設定] |
| Default is Edge/Brave/other Chromium, Chrome absent | 「Microsoft Edge など、Chrome 以外のブラウザーには現在対応していません。」 + the "Not found" text | same as Not found |

"このまま続ける" proceeds with registration but step D shows only manual
instructions (no [Chrome で開く] button). Without Chrome, nothing is written
unless the user chooses this.

### 4.3 Step B — Host registration result

Primary button: [連携プログラムを登録する]. Policy detection (§8.4) runs first.

| Result | Copy | Behaviour |
| --- | --- | --- |
| Registered | 「MAGINALIA 連携プログラムを登録しました。」 / 「このユーザーだけに登録しました。本棚や引用データには触れていません。」 / self-check ok: 「連携プログラムの動作を確認しました。」 | [次へ] |
| Already ready | 「MAGINALIA 連携プログラムは登録済みです（最新の状態です）。」 | [次へ] |
| Refreshed | 「MAGINALIA 連携プログラムを新しい版に更新しました。」 | [次へ] |
| Foreign registration | 「別の場所にある連携プログラムが登録されています。」 / 「以前に別のインストーラーで入れた「MAGINALIA Collector Host」の可能性があります。MAGINALIA に付属する連携プログラムに切り替えますか？ 本棚や引用データは変更されません。」 | [切り替える] [やめる]. Switching writes our value; if the standalone Apps entry exists **and** its `InstallLocation` equals the fixed standalone folder, the app also removes the standalone's fixed file list and its Uninstall key, so its uninstaller cannot later delete our registration. Otherwise it leaves the other software alone. |
| Policy blocked | 「組織の管理設定により、Chrome がこの種類の連携プログラムを使えないようになっています。」 / 「このパソコンでは Collector から本棚へ保存できません。設定は行っていません。管理者にお問い合わせください。」 | Nothing written. [閉じる] |
| Registry write denied | 「連携プログラムを登録できませんでした。」 / 「Windows の設定またはセキュリティソフトにより、登録が拒否された可能性があります。本棚や引用データは変更していません。」 | Files placed are left; state `registration-missing`. [もう一度試す] [あとで設定] |
| Program folder unsafe | 「連携プログラムを置くフォルダーのアクセス権を安全と確認できませんでした。」 / 「安全のため、登録を中止しました。フォルダーのアクセス権は変更していません。」 | No write. [あとで設定] |
| File locked | 「連携プログラムのファイルが使用中のため、更新できませんでした。」 / 「Chrome をいったん閉じてから［もう一度試す］を押してください。」 | Previous state unchanged. |
| Self-check failed | 「連携プログラムを起動できませんでした。」 / 「Windows のセキュリティ機能で起動が止められた可能性があります。保存しようとした引用は、ブラウザー内に保留されます。」 | Registration kept, state `damaged`; [もう一度確認] [あとで設定]. |

### 4.4 Step C — save-destination consent

This step dispatches the **existing** `maginalia.collector.configureSaveDestination`
command unchanged: it re-reads `shelf_location.yml` and the typed D068 marker,
shows the existing native confirmation dialog with the Shelf name, and writes the
binding only after 「この本棚に設定」. No silent adoption, repair or rebinding.
The IPC result carries no Shelf name, path or UUID.

- Copy: 「Collector で保存した引用を書き込む本棚を確認します。」 / 「次に表示される確認画面で本棚の名前を確かめ、［この本棚に設定］を押してください。本棚のファイルや識別マーカーは変更されません。」
- Button: [保存先を確認する]

| Command result | Copy | Behaviour |
| --- | --- | --- |
| `configured` / `already-configured`, writes enabled | 「保存先を設定しました。」 | [次へ] |
| `configured`, writes disabled (ACL) | 「保存先は記録しましたが、設定フォルダーの所有者またはアクセス権を安全と確認できないため、Collector からの保存は無効のままです。」 / 「フォルダーのアクセス権は自動では変更しません。導入ガイドの「保存できないとき」をご覧ください。」 | Fail closed: Host `writesEnabled: false`; extension keeps quotes pending. [次へ（保存は無効のまま）] [あとで設定] |
| `cancelled` | 「保存先は設定されていません。Collector で保存しようとした引用は、設定するまでブラウザー内に保留されます。」 | [もう一度確認する] [次へ] [あとで設定] |
| `error` (marker invalid/conflict/missing) | the command's own dialog, then 「本棚の識別マーカーを確認できないため、保存先を設定できませんでした。マーカーの作成や修復は自動では行いません。Shelf 画面で本棚を確認してから、もう一度お試しください。」 | No binding written. |
| `busy` | 「別の確認画面が開いています。閉じてからもう一度お試しください。」 | — |

### 4.5 Step D — place the extension and load it in Chrome

On entering the step the app places `extension\` (if not already current) and
shows the folder path in a read-only text field.

- Title: 「Chrome に Collector を読み込む」
- Intro: 「拡張機能のフォルダーを用意しました。次の手順で Chrome に読み込んでください。」
- Path field + [パスをコピー] (live region: 「パスをコピーしました」) + [フォルダーを開く]
- Numbered steps (`<ol>`):
  1. 「［Chrome で拡張機能の画面を開く］を押します。Chrome に「拡張機能」の画面が開きます。」 Button: [Chrome で拡張機能の画面を開く]. Sub-note: 「開かない場合は、Chrome のアドレスバーに chrome://extensions と入力して Enter キーを押してください。」 [アドレスをコピー]
  2. 「画面の右上にある「デベロッパー モード」をオンにします。」
  3. 「左上に表示される「パッケージ化されていない拡張機能を読み込む」を押します。」
  4. 「フォルダーを選ぶ画面が開いたら、下の「フォルダー:」欄をクリックし、Ctrl＋V でパスを貼り付けて、「フォルダーの選択」を押します。」
  5. 「一覧に「MAGINALIA Collector」が表示されれば読み込み完了です。Collector の「はじめに」画面が自動で開きます。」
- Alternative: 「ドラッグでも読み込めます。［フォルダーを開く］で表示される「extension」フォルダーを、Chrome の拡張機能の画面にドラッグしてください（デベロッパー モードがオンのとき）。」
- Cautions:
  - 「Chrome を複数のユーザー（プロフィール）で使い分けている場合は、Collector を使うプロフィールの画面で読み込んでください。」
  - 「デベロッパー モードはオンのままにしてください。Chrome の起動時に、デベロッパー モードの拡張機能についての注意が表示されることがあります。」
  - 「読み込んだ Collector を Chrome から削除しないでください。削除すると、まだ本棚に保存されていない（保留中の）引用も消えます。」
- Buttons: [読み込みました] (primary) / [戻る] / [あとで設定]

Opening Chrome: `spawn(<validated chrome.exe>, ["chrome://extensions/"], {detached: true, stdio: "ignore"})`. If Chrome is already running, the URL opens as a tab in its last-used profile. `shell.openExternal` is not used (no handler for `chrome:`). On spawn failure the step shows the manual sub-note only.

All Chrome UI strings above must be checked against real screenshots of the
current Chrome stable (Japanese) in WP-2 and corrected before release (plan 30
§5.3). Placement failures:

| Failure | Copy | Behaviour |
| --- | --- | --- |
| Extension folder locked | 「拡張機能のフォルダーを更新できませんでした。フォルダー内のファイルが使用中です。」 / 「Chrome をいったん閉じてから［もう一度試す］を押してください。」 | Old folder kept intact (swap never half-applied); [もう一度試す] |
| Unsafe folder / reparse point | as the Step B "Program folder unsafe" row | No write |

### 4.6 Step E — connection check

Desktop cannot see Chrome's extension list. Options:

1. **User confirmation only** — user reads Collector's 「はじめに」 page and
   clicks a button. Unverifiable.
2. **Desktop self-check only** (§3.5) — verifies the native chain, not the
   extension.
3. **Host contact record (recommended)** — when the Host handles the new
   `host_info` operation from the allowed origin, it atomically writes
   `%LOCALAPPDATA%\MAGINALIA\integration\collector-contact.json`:

   ```json
   { "version": 1, "protocol": "maginalia.collector.experimental.v1", "hostVersion": "0.2.0", "extensionVersion": "0.3.0", "contactedAt": "2026-11-13T09:00:00.000Z" }
   ```

   No path, Shelf UUID, Shelf name, URL or quote text. Written with the same
   private-temp + rename discipline as the recovery marker, only when the
   integration folder passes `verifyCollectorStorageSecurity`, and at most once
   per 60 s unless a value changed. The wizard polls it (every 2 s, cancellable).
   It proves that the *pinned* extension, loaded in a Chrome profile, reached the
   *registered* Host.

Use 3 as primary, 2 as a precondition, and 1 as an explicit, labelled fallback.
Option 3 adds a new Host write; it needs Product Owner approval (Q1).

`host_info` (additive to protocol v1): request
`{protocol, operation: "host_info", extensionVersion}`; response
`{protocol, ok: true, host: {version, minimumExtensionVersion}}`. It is added to
both `operations` lists in `health`. Collector 0.2.0 accepts unknown operation
names in that list and never calls `host_info`, so it keeps working; it simply
never produces a contact record.

| State | Copy | Actions |
| --- | --- | --- |
| Waiting | 「Chrome の Collector からの接続を待っています…」 / 「Collector の「はじめに」画面で［もう一度確認］を押すと、すぐに確認できます。」 | [「はじめに」画面を開く方法] (expands: 「Chrome のツールバーの Collector アイコンを押し、「はじめに」を選びます。」) [あとで設定] |
| Connected | 「Chrome の MAGINALIA Collector から接続を確認しました。」 + destination line 「保存先：設定済み」 or 「保存先：未設定（保存は保留されます）」 | [完了] |
| Extension version differs | 「Chrome に読み込まれている Collector（{loaded}）が、MAGINALIA に付属する版（{placed}）と異なります。」 / 「Chrome の拡張機能の画面で MAGINALIA Collector の［更新］（↻）を押してから、もう一度確認してください。別のフォルダーから読み込んだ Collector がある場合は、保留中の引用がないことを確かめてから、その Collector を削除し、手順 4 をやり直してください。」 | [Chrome で拡張機能の画面を開く] [もう一度確認] |
| Protocol differs | 「Collector と MAGINALIA の版が合わないため、接続できません。」 / 「MAGINALIA を最新の版に更新してください。」 | [閉じる] |
| Timed out (3 min) | 「まだ接続を確認できません。」 / checklist: 「拡張機能の一覧に MAGINALIA Collector が表示されていますか」「表示されている ID が blgmoddncpknfnikdfnjelmdmphfgknf ですか」「Collector の「はじめに」画面に何と表示されていますか」 | [もう一度待つ] [「はじめに」画面に「準備ができました」と表示されている] [あとで設定] |
| User-confirmed fallback | 「ご確認ありがとうございます。MAGINALIA からは接続を確認できていませんが、設定を終了します。保存できない場合は「Collector 連携を確認・修復…」をお使いください。」 | [完了]; stored as `user-confirmed`, never shown as verified |
| Contact record unavailable (integration folder ACL failed) | the fallback path directly, with 「設定フォルダーのアクセス権を確認できないため、接続を自動で確かめられません。」 | — |

Done: 「MAGINALIA Collector の準備ができました。」 / 「Web ページで文章を選んで右クリックし、「本棚に追加」を選ぶと、この本棚に保存されます。MAGINALIA を閉じていても保存できます。」 [閉じる]

### 4.7 Accessibility and keyboard

- The panel is a labelled `role="dialog"` region; on each step change focus moves
  to the step heading (`tabindex="-1"`), like the existing first-run title.
- Progress, waiting and results use `role="status"` / `aria-live="polite"`;
  failures use `role="alert"`. Copy confirmations are announced.
- Every action is a real `<button>` reachable with Tab and activated by Enter or
  Space. `Esc` equals 「あとで設定」 and never undoes a completed write silently.
- No automatic step advance on a timer; polling never moves focus.
- Text labels on every button (no icon-only controls); state is not conveyed by
  colour alone; `prefers-reduced-motion` disables the progress animation.
- The path is a read-only `<input>` so screen readers and keyboard selection work.
- Chrome's own pages are outside our control; the numbered text steps are the
  accessible alternative to screenshots.

### 4.8 Failure matrix (summary)

| Failure | User-facing copy (main line) | Fail-closed behaviour |
| --- | --- | --- |
| Chrome not found | 「Google Chrome が見つかりませんでした。」 | No file or registry write unless the user explicitly continues. |
| Registry write denied by policy | 「組織の管理設定により、Chrome がこの種類の連携プログラムを使えないようになっています。」 | Detected before writing; nothing written; no HKLM attempt. |
| Registry write denied (other) | 「連携プログラムを登録できませんでした。」 | State `registration-missing`; Collector keeps quotes pending (`host-not-registered`). |
| Extension folder locked | 「拡張機能のフォルダーを更新できませんでした。フォルダー内のファイルが使用中です。」 | Staged swap aborts; the previous complete folder stays. |
| Binding refused by ACL check | 「保存先は記録しましたが、…Collector からの保存は無効のままです。」 | Host `writesEnabled: false`; no re-permissioning; no save acknowledged. |
| Shelf marker invalid | 「本棚の識別マーカーを確認できないため、保存先を設定できませんでした。」 | No binding write; no marker creation or repair. |
| Program folder unsafe | 「連携プログラムを置くフォルダーのアクセス権を安全と確認できませんでした。」 | No write; no re-permissioning. |
| Host blocked from running | 「連携プログラムを起動できませんでした。」 | State `damaged`; nothing reported as saved. |

## 5. Existing users and re-entry

Commands (stable, namespaced; one implementation each; menu, palette, wizard
buttons and notices dispatch them):

| Command ID | Menu label (ファイル) | Behaviour |
| --- | --- | --- |
| `maginalia.collector.setup` | 「Collector 連携を設定…」 | Opens the panel; steps already satisfied show as done and can be skipped. |
| `maginalia.collector.repair` | 「Collector 連携を確認・修復…」 | Opens the panel in diagnosis mode: shows each check (Chrome, registration, Host files, self-check, extension folder, destination, last contact) and offers the matching fix, each behind a button. Never repairs the binding or a marker. |
| `maginalia.collector.removeIntegration` | 「Collector 連携を解除…」 | Confirmation, then `remove` (§3.5). Optional checkbox 「保存先の設定も解除する」 dispatches `maginalia.collector.clearSaveDestination`. |
| `maginalia.collector.configureSaveDestination` | 「Collector の保存先を設定…」 | Unchanged. |
| `maginalia.collector.clearSaveDestination` | 「Collector の保存先を解除…」 | Unchanged. |

Removal confirmation copy: title 「Collector 連携を解除しますか？」 / detail
「この MAGINALIA の連携プログラムの登録と、拡張機能のフォルダーを削除します。本棚・引用データ・Workdesk・書き込み記録は削除されません。Chrome に保留中の引用がある場合は、先に Collector で内容を確認してください。Chrome の拡張機能一覧に残る MAGINALIA Collector は、Chrome の画面から削除できます（削除すると保留中の引用も消えます）。」 / button 「解除する」.

Recovery note: Chrome keeps the extension's storage (including the Outbox) as
long as the user does not remove the extension in Chrome. Running setup again
re-places the folder at the same path and the same extension resumes.

α1 → α2 upgraders: on the first α2 launch, when `inspect()` returns
`not-set-up` and the notice was not dismissed, show a one-time, non-blocking
notice (existing notification surface): 「Chrome で読んでいる Web ページの引用を、本棚に保存できるようになりました（MAGINALIA Collector）。」 [設定する] (dispatches `maginalia.collector.setup`) [今はしない]. Dismissal is stored in Desktop userData; nothing else is written.

Testers who loaded Collector from their own extracted ZIP folder: Chrome cannot
change the folder of a loaded unpacked extension without removing it, and removal
deletes its Outbox. The Step E "version differs" copy covers this; the install
guide gets an explicit "empty your pending list first" section.

## 6. Update path

1. Desktop update installs new resources. Nothing outside `$INSTDIR` changes; the
   old Host and old extension stay a consistent pair until Desktop starts.
2. On start, if the program folder is ours (`integration-state.json` present and
   valid) and `payloadId` differs, the app runs `refresh` automatically (the user
   already opted in; this keeps the pair matched to Desktop). If the state is
   `foreign-registration`, `registration-missing` or `damaged`, it does **not**
   repair silently; it shows a notice that dispatches `maginalia.collector.repair`.
   Startup cost is a string compare; hashes are computed only when writing or
   repairing.
3. Host refresh writes the inactive slot, verifies, then swaps the manifest. A
   running Host keeps its old image; the next Chrome call starts the new one. The
   previous slot is overwritten only on the following refresh (retried later if
   locked).
4. Extension refresh writes `extension.next`, renames `extension` →
   `extension.prev` and `extension.next` → `extension`, then removes
   `extension.prev` by the fixed list. If a rename fails the original folder is
   restored. Chrome keeps running the loaded version until reload.
5. Notice after a refresh: 「MAGINALIA Collector を新しい版（{version}）に更新しました。」 / 「Chrome の拡張機能の画面で MAGINALIA Collector の［更新］（↻）を押すか、Chrome を再起動すると反映されます。」 [Chrome で拡張機能の画面を開く] [閉じる]. The notice clears itself once a contact record reports the new `extensionVersion`.
6. Recommended Collector change (WP-1b, gated by the WP-2 spike): on service-worker
   start and on the onboarding page, compare `chrome.runtime.getManifest().version`
   with the on-disk `manifest.json` (`fetch(chrome.runtime.getURL("manifest.json"))`)
   and, when they differ and no save is in flight, call `chrome.runtime.reload()`.
   The user step in 5 then becomes a fallback.

Compatibility checks:

| Pair | Check | On mismatch |
| --- | --- | --- |
| Desktop ↔ Host | Self-check: protocol and `host.version` equal the compiled values. | State `damaged` / `outdated` → refresh or repair. |
| Host ↔ extension | Exact protocol identifier (existing). `host_info.minimumExtensionVersion` vs the extension's own version. | Extension: 「MAGINALIA Collector を更新してください（MAGINALIA の「Collector 連携を確認・修復…」から更新できます）。」; quotes stay pending. |
| Extension ↔ Host (old Host) | `host_info` missing from `operations`. | Extension: 「MAGINALIA を最新の版に更新してください。」; existing save path still works if the protocol matches. |
| Desktop ↔ extension | Contact record `extensionVersion` vs placed version. | Step E / notice "version differs". |

The protocol identifier stays `maginalia.collector.experimental.v1`. Any
incompatible change requires a new identifier; additive operations do not.

Rollback (installing an older Desktop): its `payloadId` differs, so it refreshes
to its own pair. Collector must keep its storage readable by the previous
version, or refuse with a clear message (Collector-side requirement, WP-1a).

## 7. Web Store future

What changes when Collector is published, without redoing this design:

- **Allowed origins:** `COLLECTOR_ALLOWED_ORIGINS` becomes
  `[unpacked-origin, store-origin]` in one constant, used by both the Host's
  `isAllowedCollectorOrigin` (exact membership, no normalization) and the
  manifest generator. Implement the list form now (WP-6) with one entry.
- **Build pin:** `runtime-versions.json` gains `collectorExtension.distribution:
  "unpacked" | "web-store"` and, for the store, the listing URL and store ID; the
  extension folder is no longer placed (or placed only for developers).
- **Manifest key:** the unpacked build keeps `key`; the store build omits it (the
  store assigns its own ID). The private key for the unpacked ID stays offline.
  If the store still accepts the existing key at first upload, the ID could stay
  the same; nothing here depends on that.
- **Wizard copy:** Step D becomes 「Chrome ウェブストアで「Chrome に追加」を押してください。」 with [Chrome ウェブストアを開く] (spawns the validated `chrome.exe` with the listing URL); developer-mode steps disappear. Step E is unchanged.
- **Migration:** plan 30 §5.4 and §6 items 18–19. The wizard detects
  `extensionVersion` reports from both IDs (add `extensionId` to the contact record
  then) and guides: empty the unpacked Collector's pending list first, then remove
  it in Chrome. Host dedupe by request ID does not cover two separate Outboxes.

## 8. Security review

### 8.1 Trust boundaries

1. **Renderer → main:** intent-only IPC, sender checked against the main window,
   no path or registry input. The renderer can at most start an action the user
   could start from the menu.
2. **Main → HKCU:** one constant key, value computed natively from a known
   folder (§3.3). Deletion is value-matched.
3. **Main → program folder:** fixed known-folder path, protected DACL on creation,
   ownership/ACL/reparse checks on every use (`collector-path-security.ts`),
   fixed names only.
4. **Chrome → Host:** Chrome enforces `allowed_origins`; the Host compares the
   origin argument exactly. The origin argument is not a credential (ADR 0019).
5. **Host → binding/Shelf:** unchanged (read-only binding, D071/D072 writer).
6. **Host → contact record:** one fixed file, fixed schema, no user data
   (requires Q1).
7. **Build supply chain:** Collector ZIP pinned by SHA-256 and extension ID
   derivation; Host SEA provenance and self-test; separate addon provenance.

### 8.2 Same-user malicious process (accepted limitations, stated honestly)

A process running as the same Windows user **can**: rewrite the HKCU value to its
own Host (Chrome would then send quotes to it, and it could return fake receipts
that make Collector clear its Outbox — data loss and disclosure); replace the
Host exe, the extension files or the app resources (in a per-user install the
whole tree is user-writable); start the Host with the allowed origin argument and
save quotes into the bound Shelf; forge the contact record; edit the binding.
Same-user code execution is outside the α threat model, as in the α profile. The
design **detects** registry/manifest/hash drift on Desktop start and in
「確認・修復」 and never repairs it silently, but it does not prevent it.

Such a process **cannot** (by this design): get another Windows user's
registration or files changed; reach the Host from a web page or another
extension (Chrome origin enforcement); make Desktop write a path of its choosing
into the registry (no input path exists); make the uninstaller follow a junction
out of the program folder. Low-integrity / sandboxed processes cannot write the
Medium-integrity HKCU key or the protected folder.

### 8.3 TOCTOU when copying the Host

- Expected SHA-256 values are compiled into the main bundle; the copy in
  resources is not trusted.
- Write each file to an exclusive-create temp name inside the slot, hashing the
  bytes **as written** (not a re-read of the source); flush; rename to the fixed
  name; re-open the final file (no reparse, regular file) and verify the hash
  again; only then write the manifest that points at the slot.
- The slot directory is recreated empty by the app; a pre-existing reparse point
  aborts.
- Remaining window (after verification, before Chrome starts the exe) is
  same-user only (DACL excludes other principals) — accepted per §8.2.

### 8.4 Chrome policy-blocked registration

Read before writing (HKLM and HKCU `SOFTWARE\Policies\Google\Chrome`):

- `NativeMessagingUserLevelHosts` = 0 → user-level hosts ignored → `policy-blocked`.
- `NativeMessagingBlocklist` contains `*` or `org.maginalia.collector` and
  `NativeMessagingAllowlist` does not contain the name → `policy-blocked`.
- `DeveloperToolsAvailability` = 2 or `ExtensionInstallBlocklist` contains `*`
  without an allow entry for the ID → Step D shows 「組織の管理設定により、拡張機能を読み込めない可能性があります。」 (warning; Chrome is the authority).

Never fall back to HKLM or another browser's key. Whether Chrome prefers an HKLM
registration of the same name over HKCU must be confirmed in WP-2; an HKLM entry
is then reported as `foreign-registration` and not modified.

### 8.5 Uninstall correctness

`${isUpdated}` guard; value-matched key deletion; fixed names; reparse refusal;
non-recursive `RMDir`; never `%LOCALAPPDATA%\MAGINALIA`, Shelf, Workdesk,
Projects, Chrome profile. Acceptance includes a planted junction inside
`extension\` pointing at a canary folder (canary unchanged after uninstall) and an
update run (registration and folder still present after update).

### 8.6 Privacy

- Logs (console, main-process errors, NSIS details) contain no absolute paths,
  Shelf UUIDs, Shelf names, URLs or quote text; error codes only.
- `integration-state.json` and the contact record contain versions, hashes,
  timestamps and slot names only.
- The extension folder path is shown in the UI and copied to the clipboard only on
  explicit user action; it is not persisted outside the program folder layout.
- Evidence documents and PR text use placeholders such as
  `%LOCALAPPDATA%\Programs\MAGINALIA Collector`, never a real user path or UUID.

## 9. Work packages

Repositories: **D** = Desktop (this repo), **C** = MAGINALIA-Collector,
**I** = MAGINALIA_IDE docs.

| ID | Repo | Size | Depends on | Summary |
| --- | --- | --- | --- | --- |
| WP-0 | I | S | PO answers (§10) | Decision Log entry (PO decision 2026-11-13, D023 α2 exception); α profile §2/§4 update (Desktop-bundled Host, runtime registration, slots, allowed-origin list, `host_info`, contact record); plan 22 §3 registry list; plan 30 §5.2/§8 pointer. No DONE marks. |
| WP-1a | C | M | WP-0 | `host_info` client (sends `extensionVersion`), compatibility messages, onboarding copy for the Desktop-bundled path (no standalone installer link), storage backward-readability rule; publish release `v0.3.0` ZIP + `SHA256SUMS`. |
| WP-1b | C | S | WP-2, WP-1a | Self-reload when the on-disk manifest version differs and no save is in flight. |
| WP-1c | C | S | WP-9 screenshots | Rewrite `docs/install-guide-ja.md`: primary path "install MAGINALIA Desktop"; developer path keeps the ZIP. |
| WP-2 | D | S | — | Owner-observed spike in a disposable Windows user: relative subdirectory `path`; HKCU vs HKLM precedence; `chrome.exe chrome://extensions/`; folder swap while loaded; disk `manifest.json` fetch and `runtime.reload()`; drag-and-drop load; Japanese UI labels and developer-mode warnings (screenshots); behaviour when developer mode is turned off. Output: evidence section appended to this doc. |
| WP-3 | D | M | — | `native/windows-integration` addon + `src/windows-integration.ts` wrapper and `CollectorRegistryAdapter` interface; stage checks like `shelf-mutex-addon.mjs` (N-API 8, `/MT`, PE32+, no VC++ imports); extraResources entry. |
| WP-4 | D | M | WP-1a release | Packaging: reduce `build-collector-host.mjs` to the payload builder; delete `packaging/collector-host/installer.nsi`; fetch/verify/extract the pinned Collector ZIP with ID derivation; generate `collector-payload.json` and compiled constants; extraResources; `verify-packaged-collector-payload.mjs`; notices. |
| WP-5a | D | M | WP-3 | `collector-integration.ts`: read-only `inspect()` (states §3.5), Chrome locator, default-browser read, policy detection. |
| WP-5b | D | M | WP-3, WP-4, WP-2 | `apply()` setup/repair/remove: folder creation with DACL, slot writes with TOCTOU rules, extension staged swap, manifest generator, registry calls, standalone migration, self-check, E2E-isolation refusal. |
| WP-5c | D | S | WP-5b | Startup refresh for opted-in users, update and repair notices, α1→α2 one-time notice. |
| WP-6 | D | M | WP-0 (Q1) | Host: `COLLECTOR_ALLOWED_ORIGINS` list, `host_info` operation, contact-record writer, unit and child-process tests; payload version constant injected at SEA build. |
| WP-7 | D | L (split UI / commands if needed) | WP-5a/b, WP-6, WP-1a | Renderer panel (§4), IPC channels, commands `maginalia.collector.setup` / `.repair` / `.removeIntegration`, menu contract entries, first-run completion hook, accessibility. |
| WP-8 | D | S | WP-4, WP-5b | NSIS `customUnInstall` (§2.4) in `installer-shortcut.nsh` (or a new include), plus a static check of the generated script. |
| WP-9 | D (+owner) | M | all above | Phase 4b E2E and evidence; Japanese manual chapter 「Chrome 拡張機能 Collector」 with screenshots. |
| WP-10 | I | S | WP-9 | Write-back of actual results (PASS/FAIL/NOT VERIFIED) to the α profile and plan 30 §6. |

Per-package acceptance and test plan:

- **WP-3** — Accept: functions exist with the exact signatures in §3.3; register/unregister take no arguments; no generic registry write is exported; build fails on CRT import. Tests: wrapper unit tests with a fake addon; native read tests on harmless keys only (no write to real HKCU in CI).
- **WP-4** — Accept: `dist:windows` produces resources per §2.1; a tampered ZIP, wrong version or wrong derived ID fails the build; no NSIS Host installer is produced; `verify-packaged-collector-payload` passes on `win-unpacked`. Tests: unit tests for the extractor (traversal, duplicates, extra entries), ID derivation against the known key, payload descriptor schema.
- **WP-5a** — Accept: every state of §3.5 reachable with a fake adapter and a temp root; no writes; no env/cwd/argv reads (source-scan test). Tests: table-driven state tests, Chrome locator candidates, policy combinations.
- **WP-5b** — Accept: idempotent setup (second run = no-op); interrupted swap leaves the previous complete folder; locked file leaves state unchanged; value-matched removal; refusal under `MAGINALIA_E2E_ISOLATION_ROOT`. Tests: temp-root integration tests with injected adapter (fault injection at each step), junction/reparse refusal, hash-mismatch refusal.
- **WP-5c** — Accept: refresh only from `outdated` and only when ours; never from foreign/missing/damaged; notice clears after a matching contact. Tests: unit tests with fake clock and state.
- **WP-6** — Accept: Collector 0.2.0 health parsing still passes (operation list ≤16, pattern-valid); `host_info` rejected for wrong origin; contact record written only when ACL checks pass, contains exactly the five fields, rate-limited, atomic. Tests: existing product-host tests extended; child-process test with a disposable profile via the existing test seams (product entry unchanged: no env reads).
- **WP-7** — Accept: every copy string in §4–§5 present; keyboard-only completion; focus and live-region behaviour; commands appear in the palette and menu with the stable IDs. Tests: renderer unit tests, command-coverage test update, `first-run-smoke` unchanged (Collector step optional).
- **WP-8** — Accept: guard present; deletes only fixed names; key deletion value-matched. Tests: static scan of the compiled script; owner E2E (WP-9).

### 9.1 Phase 4b E2E plan

Recommended environment: a **fresh local standard Windows user** created for the
test (non-ASCII user name to cover Japanese profile paths), Chrome stable
installed per-user and per-machine in two runs. Using the owner's main account is
allowed only with written consent, a backup of the single HKCU key (export to the
evidence folder) and a metadata-only `audit` of `%LOCALAPPDATA%\MAGINALIA`, the
Shelf and the program folder before and after; cleanup is the in-app removal
command, then manual verification.

| # | Scenario | Automated | Owner-observed |
| --- | --- | --- | --- |
| 1 | Unit/integration tests of WP-3…WP-8 with injected adapters and temp roots | yes (CI) | — |
| 2 | Packaged tree verification (`verify-packaged-*`) | yes (local build) | — |
| 3 | Fresh install → first-run → Collector step A–E → contact record → Desktop closed → save quote → Shelf +1/+1 via `collector-shelf-e2e-verify` | verifier yes | install, Chrome UI steps, screenshots |
| 4 | α1 tag install with data → α2 upgrade → no first-run, notice shown, data and userData intact → setup via command | audit yes | yes |
| 5 | α2 → α2+1 update with a bumped payload: refresh, slot switch, reload notice, contact shows new version; Host running during update does not block the installer | partially (state file diff) | yes |
| 6 | Foreign registration (standalone Host installed first) → switch → standalone Apps entry gone → registration survives | — | yes |
| 7 | Policy `NativeMessagingUserLevelHosts=0` set by an admin in the test user → `policy-blocked`, nothing written → policy removed | — | yes |
| 8 | Locked extension file / locked slot → copy and state unchanged | helper process | yes |
| 9 | Uninstall: key removed, program folder removed, junction canary intact, `%LOCALAPPDATA%\MAGINALIA`, Shelf, Workdesk, Chrome profile and Outbox intact | audit yes | yes |
| 10 | All-users install mode: registration per user; uninstall limitation reproduced and documented | — | yes |
| 11 | Real-Chrome OS-process-kill during save | DEFERRED (D072) | — |

Report each item as PASS / FAIL / NOT VERIFIED; mock results never substitute for
3–10.

## 10. Open questions for the Product Owner

1. **Host contact record (new Host write).** Allow the Host to write the fixed,
   data-free `collector-contact.json` so the wizard can verify the connection?
   *Recommended: yes.* Alternative: user confirmation only (unverifiable).
2. **D023 exception for α2.** Record that loading the unpacked extension through
   Chrome developer mode is accepted for α2 only, with the Web Store release a β1
   prerequisite? *Recommended: yes* (matches the 2026-11-13 decision and plan 12
   §17).
3. **Automatic refresh on Desktop update.** For users who completed setup, may the
   app refresh the Host and the extension folder on first start after an update
   without asking (it then shows the reload notice)? *Recommended: yes*; repairs
   of foreign/missing/damaged states stay user-confirmed.
4. **Extension folder location.** `%LOCALAPPDATA%\Programs\MAGINALIA Collector\extension`
   (hidden AppData; reached by paste or drag) rather than a Documents folder
   (visible, but OneDrive-synced on many PCs and easy to delete)?
   *Recommended: LocalAppData.*
