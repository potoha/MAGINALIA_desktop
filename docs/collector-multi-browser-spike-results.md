# Collector multi-browser spike results (Chrome / Edge / Vivaldi)

Status: measured 2026-11-20 on one Windows 11 test machine (Product Owner machine, disposable browser profiles).
Companion to `collector-multi-browser-design.md` §10 (spike protocol). Everything below was observed; anything not listed is NOT VERIFIED.

Method: a probe extension (same fixed ID as the key-pinned extension scheme) calls `chrome.runtime.sendNativeMessage` against a throw-away host name `org.maginalia.spikemb.probe`. Registry keys were created and removed under HKCU only; product host names were never touched. The Product Owner operated the browser UI; scripts and log monitoring ran from the agent session.

Versions: Chrome 157.0.8103.x, Edge 157.0.4341.60, Vivaldi 8.3.4191.35 (per-machine) and 8.3.4191.44/.45 (per-user).

## 1. Native Messaging registry lookup (V-KEY)

"from" is the manifest label that answered. HKCU keys only.

| Scenario | Registered keys | Chrome | Edge | Vivaldi (per-machine and per-user) |
| --- | --- | --- | --- | --- |
| K1 | Chrome | chrome | chrome (fallback) | chrome |
| K2 | Edge | not found | edge | (not run) |
| K3 | Chromium | (not run) | (not run) | chromium |
| K4 | Vivaldi | (not run) | (not run) | **not found** |
| K5 | Chrome + Edge | chrome | edge | (not run) |
| K6 | Chrome + Vivaldi | (not run) | (not run) | chrome (Vivaldi key ignored) |
| K7 | Chrome + Chromium | chrome | **chromium** | **chromium** |

Findings:
1. Chrome reads only `Software\Google\Chrome\NativeMessagingHosts`.
2. Edge reads its own key first, then falls back to the Chromium key, then the Chrome key (K7: Chromium wins over Chrome).
3. Vivaldi never reads `Software\Vivaldi\NativeMessagingHosts`. It reads the Chromium key, then the Chrome key. Result is identical for the per-machine and per-user installs. Registering a Vivaldi-specific key is unnecessary and has no effect.
4. Consequence for the design (decision (d)): a foreign `Software\Chromium\NativeMessagingHosts\<our host name>` shadows our Chrome-key registration for Edge and Vivaldi.

## 2. Manifest path form (V-REL)

`subdir` (relative), `flat` and `abs` (absolute path containing Japanese folder names) all resolved in Chrome and Edge (K5, own-key answers). Not measured: Vivaldi with `flat` / `abs`.

## 3. Extension identity and origin (V-ID / V-ORIGIN)

- The probe loaded with the same ID in Chrome, Edge and Vivaldi.
- The real key-pinned Collector 0.3.0 loaded in Chrome with its pinned ID; the other browsers were not run with the real Collector.
- The host receives `chrome-extension://<id>/` as argv[0] plus `--parent-window=<n>` in all three browsers.

## 4. UI facts (V-UI), Japanese UI

| Item | Chrome | Edge | Vivaldi |
| --- | --- | --- | --- |
| Developer mode toggle | top right, 「デベロッパー モード」 | bottom of left menu, 「開発者モード」 | same as Chrome |
| Load unpacked | 「パッケージ化されていない拡張機能を読み込む」 | leftmost icon under 「開発者向けオプション」, tooltip 「展開して読み込み」 | same as Chrome |
| Developer mode switched off | extension disabled, safety-check suggestion, no warning after restart | toast 「アンパックされた拡張機能が無効になりました」; **startup popup 「開発者モードをオフにしますか？」 on every restart** (「今は実行しない」) | not recorded |
| "Managed by organization" notice | shown (non-native-messaging policy) | shown | not recorded |

Vivaldi's extensions page looked the same as Chrome's except for the Vivaldi icon.

## 5. Opening the extensions page (V-LAUNCH)

| Case | Chrome | Edge | Vivaldi |
| --- | --- | --- | --- |
| Disposable profile (`--user-data-dir`), browser not running | opens | opens | opens |
| Disposable profile, browser running | new window, new tab | new window, new tab | (not run) |
| Real profile, browser running or not | **new window; the extensions page is NOT opened** | **new window; the extensions page is NOT opened** | existing window; extensions page opened |

Consequence: launching `chrome.exe` / `msedge.exe` with a `chrome://` or `edge://` URL is not a reliable way to open the extensions page in the user's real profile. `openBrowserExtensions` needs a fallback that tells the user which address to type (or another verified mechanism). Vivaldi works with the URL argument.

## 6. Default browser detection (V-DEFAULT)

Measured `HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\{http,https}`:

| Default browser | `UserChoiceLatest\ProgId` (subkey with `ProgId` value) | `UserChoice\ProgId` |
| --- | --- | --- |
| Vivaldi (per-machine install) | `VivaldiHTM` | `VivaldiHTM` |
| Edge (after switching the default) | `MSEdgeHTM` | stale `VivaldiHTM` |
| Vivaldi (per-user install, re-selected) | `VivaldiHTM.<hash suffix>` | stale `VivaldiHTM` |

- `UserChoice` can be stale; `UserChoiceLatest` must be read first (current adapter order is correct).
- Edge ProgId `MSEdgeHTM` is now measured. Chrome's ProgId (`ChromeHTML` expected) was NOT measured; it still needs a run with Chrome as the default browser.
- Vivaldi ProgId carries a hash suffix for the per-user install, matching the anchored `VivaldiHTM(.x)?` pattern.
- The Edge HKLM open command is `...\Microsoft\Edge\Application\msedge.exe --single-argument %1`; there was no HKCU ProgId command.

## 7. Updating an unpacked extension in place (Vivaldi only)

| Check | Result |
| --- | --- |
| V-PROFILE: same registration, profiles A and B | both connect (`chrome` key) |
| V-SWAP: rename `ext` → `ext.old`, `ext.next` → `ext` while the browser runs | rename succeeds; 「再読み込み」 picks up the new version |
| V-RELOAD: `chrome.runtime.reload()` from the popup | new version loaded; **popup froze and a removed extension card lingered until the browser was restarted** (not reproduced; single observation) |
| V-DROP: drag the folder onto the extensions page | loads |

Edge V-SWAP / V-DROP / V-RELOAD were not run.

## 8. NOT VERIFIED

- Chrome's default-browser ProgId (Chrome was never set as the default in this session).
- Vivaldi V-LAUNCH in a disposable profile with the browser running; Vivaldi `flat` / `abs` path forms.
- Real Collector (not the probe) in Edge and Vivaldi.
- Edge swap/reload behavior; reproducibility of the Vivaldi popup freeze after `runtime.reload()`.
- HKLM registration and enterprise policy behavior (intentionally not tested on this machine).
- Brave, Opera and other Chromium browsers (unofficial; not tested).

## 9. Effect on the design

1. §3.4 outcome for Vivaldi: it reads the Chrome key (and a Chromium key first if present). No Vivaldi key row is needed; remove Vivaldi's own registration target.
2. Decision (d) is confirmed as a real risk for Edge and Vivaldi (Chromium key precedence); the foreign-Chromium-key branch is required, not optional.
3. `openBrowserExtensions` must not rely on passing the URL to the executable for Chrome and Edge; wizard copy must instruct the user to open the page manually or use a verified alternative.
4. Wizard copy for Edge must mention the startup popup 「開発者モードをオフにしますか？」 (choose 「今は実行しない」).
5. Self-update of the unpacked folder (WP-1b) must account for the single observed freeze after `runtime.reload()`.
