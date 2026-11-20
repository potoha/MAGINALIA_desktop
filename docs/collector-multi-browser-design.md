# Collector 連携の複数ブラウザー対応（Chrome・Edge・Vivaldi）設計追補

- **Status:** design proposal for review. No product code is changed by this
  document. Nothing here is DONE; every acceptance item is NOT VERIFIED until the
  slices in §9 and the spike in §10 produce evidence.
- **Spike (2026-11-20):** measured results are in
  [`collector-multi-browser-spike-results.md`](collector-multi-browser-spike-results.md).
  Where this document says `[未検証]` for an item the spike measured, the 2026-11-20 write-back
  blocks (§3.2, §3.4–§3.6, §7.2, §12.3) give the measured outcome. Rows below the table in §1 are
  not rewritten; the write-back blocks win.
- **Base:** `codex/alpha2-rc3` at `a7fc509` (RC2 + WP-5c + WP-8). WP-7 slice A
  (`codex/wp7a-main-wiring` at `f81fd8b`, on top of RC3) was read as well.
- **Parent design:** [`collector-wizard-integration-design.md`](collector-wizard-integration-design.md)
  (以下「親設計」)。本書は親設計の §2/§3/§4/§5/§6/§8 を複数ブラウザーへ拡張する追補であり、
  親設計の不変条件（renderer に絶対パスを渡さない、レジストリ書込みは固定キーのみ、値一致で
  のみ削除、Host 信頼境界不変、Shelf/binding 不変）はすべて維持する。

## 0. 前提と根拠

### 0.1 Product Owner 決定（2026-11-17、本書では変更しない）

1. 正式対応は **Google Chrome、Microsoft Edge、Vivaldi**。Chromium 単体・Brave・Opera 等は
   「未検証」＝正式対応外。ただしブラウザー表に行を追加するだけで対応を増やせる構造にする。
2. 拡張機能は **既定のブラウザー** に入れるよう案内する。既定が対応ブラウザーならそれを勧める。
   既定が Chromium 系でない（Firefox 等）か未対応のときは **Edge** を勧める（Windows 標準）。
   Chrome はインストール済みなら選べる。
3. Native Messaging Host の登録は **Chrome と Edge の両方** に行う。Vivaldi の登録先は
   **未検証**。spike で確定するまで決め打ちしない。
4. ウィザード UI に Figma は使わない。UI 文言は日本語。
5. テスト機の実測事実（オーナー提供）:
   - 既定ブラウザー = Vivaldi（UserChoice ProgId `VivaldiHTM`）。
   - Chrome 157: HKLM App Paths `C:\Program Files\Google\Chrome\Application\chrome.exe`。
   - Edge 157: HKLM App Paths `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`。
   - Vivaldi 8.3: ユーザー単位（`%LOCALAPPDATA%\Vivaldi\Application`、HKCU App Paths）と
     PC 全体（`C:\Program Files\Vivaldi\Application`、HKLM App Paths）の両方。
   - `HKCU\Software\Vivaldi\NativeMessagingHosts` は空のキーとして存在する。

### 0.2 読んだ正本・コード

| Source | 本書に効く内容 |
| --- | --- |
| MAGINALIA_IDE `plan/30_MAGINALIA_COLLECTOR_REQUIREMENTS.md` L16, L194, L259, L282, L313 | 対象は「Chrome / Chromium 系」(L16)。既定ブラウザーが Chrome/互換 Chromium 系か判定し、非対応なら黙って投入しない (L194)。第一ターゲットは Chrome、他 Chromium は個別に動作・配布・Native Messaging 登録先を検証してから対応表へ (L259)。非対応ブラウザー・複数プロファイル・未導入・拒否時に誤って「完了」としない (L282)。未決事項「Chrome 先行か他 Chromium を含めるか」(L313 item 1)。 |
| MAGINALIA_IDE `plan/09_DECISION_LOG.md` D070, D071 | Native Messaging 採用、Host は設定済み単一 Private Shelf のみ、exact origin。**D072/D073 は Decision Log に存在しない**（`D07[23]` を IDE 全体で Grep して 0 件）。親設計が D072 を引用している理由は確認していない（[推測] ADR 0019 本文側の番号）。本書は D072/D073 に依存しない。 |
| 親設計 §2〜§9 | 単一 HKCU キー、A/B slot、`integration-state.json`、7 状態、apply 順序、NSIS cleanup、脅威モデル。 |
| `apps/desktop/native/windows-integration/src/windows_integration.cc` | 書込み可能なキーは compile-time 定数 `kHostKeyPath`（Chrome キー）1 本。`register/unregister/replaceForeign` は引数を読まない。所有判定 `InspectExisting` は addon 内の 1 箇所。 |
| `windows-integration.ts`, `collector-registry-adapter.ts` | adapter に `readCollectorHostRegistration()` 等（単一キー）、`readChromePolicies()`、`readChromeAppPaths()`、`readDefaultBrowserProgId()`（`UserChoice` のみ）。 |
| `collector-integration.ts`, `-types.ts` (WP-5a) | `inspect` の状態優先順位、`locateChromeExecutable`（App Paths → known folders、basename `chrome.exe`、reparse 拒否）、`classifyDefaultBrowser`（Vivaldi は `other-chromium`）、`evaluateChromePolicies`、`expectedHostManifest`、state file v1（5 フィールド厳密）。 |
| `collector-integration-apply*.ts` (WP-5b) | apply 順序（slot → extension swap → manifest → registry → state → self-check）、不変条件「registration ours かつ manifest 有効 ⇒ 指す slot は完全」、`guard` が登録 verdict の一致を要求、remove は unregister 先行・失敗時はファイル不変、フォールト注入テスト。 |
| `collector-startup-refresh*.ts`, `collector-integration-notices.ts` (WP-5c) | refresh は `outdated` かつ自分のもののときだけ。foreign/missing/damaged は repair 通知。通知文言に「Chrome」が直書き。 |
| `collector-integration-service.ts`, `-ipc.ts`, `renderer/collector-integration-commands.ts`, `main.ts` (WP-7a) | `chrome-required`、`openChromeExtensions`（`chrome://extensions/` 固定引数で検証済み exe を detached spawn）、`proceedWithoutChrome`、`checkConnection`、コマンド `maginalia.collector.openChromeExtensions`。renderer への応答にパスなし。 |
| `apps/desktop/packaging/collector-uninstall.nsh` (WP-8) | Chrome キー 1 本を値一致で削除、state v1 を PowerShell で厳密検証、`installMode == CurrentUser` のみ。 |
| `collector-payload.ts`, `collector-native-host-product.ts` | `COLLECTOR_ALLOWED_ORIGINS = ["chrome-extension://blgmoddncpknfnikdfnjelmdmphfgknf/"]`（**2 箇所に重複定義**。本書の範囲外だが報告）。 |
| Collector `codex/collector-host-info` (`0a5b6ee`) | `manifest.json` に固定 `key`、`nativeMessaging` 権限、`chrome.*` API のみ使用。README・install guide・onboarding・popup に「Chrome」表記。install guide は「Chrome 以外（Edge など）は対象外」と明記。service worker の sender 検査が `senderUrl.protocol === "chrome-extension:"` を要求。 |

### 0.3 外部文書（2026-11-17 取得）

- Microsoft Edge Native messaging（learn.microsoft.com, updated 2026-09-02）:
  - Edge は `HKCU\SOFTWARE\Microsoft\Edge\NativeMessagingHosts\` →
    `HKCU\SOFTWARE\Chromium\NativeMessagingHosts\` → `HKCU\SOFTWARE\Google\Chrome\NativeMessagingHosts\`
    → HKLM（WOW6432Node、次に 64-bit）の順で探し、**最初に見つかった登録だけを読む**。
    Edge 用キーが無ければ Chromium・Chrome のキーが fallback として使われる。
  - Windows では manifest の `path` は manifest のあるフォルダーからの相対パスでよい。
  - `allowed_origins` は `chrome-extension://<id>/` 形式。Host の第 1 引数は caller origin
    （通常 `chrome-extension://<id>`）。
  - Edge Add-ons で公開すると拡張機能 ID が sideload 時と変わり得る。Edge Add-ons と
    Chrome Web Store の両方で公開するなら両方の ID を `allowed_origins` に入れる必要がある。
- Microsoft Edge policy `NativeMessagingUserLevelHosts`: `SOFTWARE\Policies\Microsoft\Edge`、
  REG_DWORD、Disabled（0）でユーザー単位 Host を使わない。
- Chrome Native messaging（developer.chrome.com）: `SOFTWARE\Google\Chrome\NativeMessagingHosts\`
  を HKCU または HKLM に作る。32-bit → 64-bit の順で照会。Windows では相対 `path` 可。
  `allowed_origins` に wildcard 不可。**HKCU と HKLM のどちらを先に見るかは記載なし。**
- Vivaldi: 公式文書は見つからなかった。Web 検索で、別製品のログに Vivaldi 向けに
  `SOFTWARE\<vendor>\NativeMessagingHosts\...` を書く例が 1 件あったのみ（vendor 名不明）。
- 既定ブラウザー: Windows 11 の新しい版では `UrlAssociations\https\UserChoiceLatest` が
  実際の既定を持ち、`UserChoice` が更新されない例があるという非公式報告がある（公式文書なし）。

### 0.4 根拠の表記

本書では各事実に次の印を付ける。印のない設計判断は本書の提案である。

- **[実測]** オーナーがテスト機で測った事実（§0.1-5）。
- **[コード]** このリポジトリまたは Collector リポジトリの現物。
- **[文書]** §0.3 のベンダー文書。
- **[未検証]** spike（§10）で確定するまで仮置き。実装は表のフィールドを空のままにするか、
  release gate で止める。
- **[推測]** 根拠の弱い見込み。設計はこれに依存しない。

### 0.5 正本との整合

- 本書はオーナー決定 1〜3 により plan 30 §8 item 1（「Chrome 先行か他 Chromium を含めるか」）を
  解決し、L259 の「個別に動作・配布・Native Messaging の登録先を検証してから対応表へ加える」を
  **そのまま採用**する: 表の行は `verification: "verified"` になるまで正式対応として表示しない。
  よって plan 30 と矛盾しない。plan 30 の文言は「Chrome」前提なので §12 で差し替え案を出す。
- L194「非対応なら黙ってファイルを投入しない」: Firefox 等が既定でも、ウィザードは Edge を
  **提案するだけ**で、利用者が［設定を始める］を押すまで何も書かない（親設計の同意モデルを維持）。
- L282「誤って『完了』としない」: §2.3 の全分岐で、接続確認（contact record）なしに「完了」を
  出さない規則を維持する。
- 親設計 §1 Non-goals の「Browsers other than Google Chrome」はオーナー決定で置き換わる（§12.2）。
- 既知の未修正事項（親設計 §0.1-5 と同じ）: plan 30 の L8–L15 に merge conflict marker が
  残っている。本書では直さない。

---

## 1. ブラウザー表（data-driven）

### 1.1 方針

- **1 つの純粋データ module** `apps/desktop/src/collector-browser-table.ts` を新設する。
  import なし・副作用なし（`collector-integration-ipc.ts` と同じく main/preload/renderer の
  どれからでも読める）。renderer はここから表示名と UI ラベルだけを使う。
- **書込み先のレジストリキーの正本は addon の compile-time 表** とする（§3.2）。TS 表の
  レジストリ文字列は「読む側・照合用」の写しであり、TS 表を書き換えても書込み先は変わらない。
  TS 表・C++ 表・NSIS 定義の一致は unit test が検査する（§6.2）。
- 実行時に読み込む設定ファイルは作らない（親設計 §3.3「no packaged file can redirect」を維持）。
- 行を足すだけで対応ブラウザーを増やせる。行の `verification` が `"unverified"` の間は、
  検出・既定判定には使うが、**勧めない・登録しない・正式対応と表示しない**。

### 1.2 スキーマ

```ts
/** Registry targets: one HKCU key each. Writable ones are mirrored in the addon table. */
export const COLLECTOR_REGISTRY_TARGET_IDS = ["chrome", "edge", "vivaldi", "chromium"] as const;
export type CollectorRegistryTargetId = (typeof COLLECTOR_REGISTRY_TARGET_IDS)[number];

export interface CollectorRegistryTargetSpec {
  readonly id: CollectorRegistryTargetId;
  /** Always HKCU, 64-bit view (HKCU is not redirected). */
  readonly subkey: string; // e.g. "Software\\Microsoft\\Edge\\NativeMessagingHosts\\org.maginalia.collector"
  /** true: the addon may register/unregister it. false: inspected only (never written). */
  readonly writable: boolean;
}

export const COLLECTOR_BROWSER_IDS = ["edge", "chrome", "vivaldi"] as const; // order = fallback recommendation order
export type CollectorBrowserId = (typeof COLLECTOR_BROWSER_IDS)[number];

export interface CollectorBrowserSpec {
  readonly id: CollectorBrowserId;
  readonly displayName: string;                    // 「Microsoft Edge」
  readonly verification: "verified" | "unverified";
  /** Default-browser match on the https handler ProgId (anchored, case-insensitive). */
  readonly progIdPattern: string;                  // RegExp source
  readonly executable: {
    readonly fileName: string;                     // "msedge.exe" (basename check, case-insensitive)
    readonly appPathsName: string;                 // App Paths subkey name, usually = fileName
    readonly knownFolderCandidates: readonly { readonly folder: "LocalAppData" | "ProgramFiles" | "ProgramFilesX86"; readonly relative: readonly string[] }[];
  };
  readonly nativeMessaging: {
    /** HKCU targets in the order this browser searches them; the first present one wins. */
    readonly lookupOrder: readonly CollectorRegistryTargetId[];
    /** Writable targets MAGINALIA owns for this browser (subset of lookupOrder). */
    readonly ownTargets: readonly CollectorRegistryTargetId[];
    /** "always": registered for every user (owner decision 3). "when-present": only when the browser is detected or already registered. */
    readonly registration: "always" | "when-present";
  };
  /** Policy root under HKLM/HKCU `SOFTWARE\Policies\`, or null when unknown (never blocks). */
  readonly policyRoot: "Google\\Chrome" | "Microsoft\\Edge" | null;
  readonly extensionsPage: {
    readonly displayUrl: string;                   // shown and copied: "edge://extensions"
    readonly launchArguments: readonly string[];   // fixed argv for the validated exe
  };
  readonly ui: {
    readonly developerModeLabel: string;
    readonly developerModeLocation: string;        // 「画面の右上」
    readonly loadUnpackedLabel: string;
    readonly reloadLabel: string;
  };
  readonly store: "chrome-web-store" | "edge-add-ons"; // future distribution (§8)
  /** https only; opened with shell.openExternal from a main-process constant. null: no download button. */
  readonly downloadUrl: string | null;
  /** Evidence per field (documentation for reviewers; a test requires "verified" rows to carry no "unverified" field). */
  readonly evidence: Readonly<Record<string, "measured" | "vendor-doc" | "code" | "unverified">>;
}
```

`Object.freeze` した `COLLECTOR_REGISTRY_TARGETS` と `COLLECTOR_BROWSERS` を export する。
`verification: "verified"` の行は `evidence` に `"unverified"` を含んではならない（unit test）。
これが release gate になる。

### 1.3 初期のレジストリ target

| id | subkey（HKCU） | writable | 根拠 |
| --- | --- | --- | --- |
| `chrome` | `Software\Google\Chrome\NativeMessagingHosts\org.maginalia.collector` | true | [コード] 現行の唯一のキー。[文書] Chrome。 |
| `edge` | `Software\Microsoft\Edge\NativeMessagingHosts\org.maginalia.collector` | true | [文書] Edge。オーナー決定 3。 |
| `chromium` | `Software\Chromium\NativeMessagingHosts\org.maginalia.collector` | **false** | [文書] Edge の fallback 2 番目。読むだけ。Edge が Edge キーを持たないときに他者の Chromium キーが割り込むかを判定するため。 |
| `vivaldi` | `Software\Vivaldi\NativeMessagingHosts\org.maginalia.collector` | **false（spike 後に決定）** | [未検証] Vivaldi が読むか不明。テスト機に親キーが空で存在するのは [実測]。誰が作ったかは不明（[推測] 他製品が複数ブラウザー向けに登録した名残）。spike の結果、Vivaldi がこのキーを読むなら `writable: true` にして addon にも追加する。Chrome キーしか読まないなら行ごと削除する。 |

### 1.4 初期のブラウザー行

| フィールド | Chrome | Edge | Vivaldi |
| --- | --- | --- | --- |
| `verification` | `verified`（ただし UI ラベルは spike で再確認） | `verified` 予定（spike Phase 1 後） | `unverified`（spike で `lookupOrder` が埋まるまで） |
| `progIdPattern` | `^ChromeHTML(\.[A-Za-z0-9]+)?$`。[コード] 現行は `^ChromeHTML(\.|$)`。ユーザー単位 install の suffix 付き ProgId は [推測]。Beta/Dev/Canary（`ChromeBHTML` 等）は一致させない。 | `^MSEdgeHTM$`。[推測] stable の ProgId。Beta/Dev/Canary（`MSEdgeBHTML` 等）は一致させない。spike で確認。 | `^VivaldiHTM(\.[A-Za-z0-9]+)?$`。`VivaldiHTM` は [実測]（両 install が入った状態で suffix なし）。suffix 付きは [推測]。 |
| `executable.fileName` | `chrome.exe` [コード][実測] | `msedge.exe` [実測] | `vivaldi.exe` [実測] |
| App Paths | HKCU → HKLM 64 → HKLM 32 [コード]。テスト機は HKLM [実測]。 | 同順。テスト機は HKLM [実測]。 | 同順。テスト機は HKCU と HKLM の両方 [実測]。 |
| known folders | `LocalAppData\Google\Chrome\Application`, `ProgramFiles\...`, `ProgramFilesX86\...` [コード] | `ProgramFilesX86\Microsoft\Edge\Application`（[実測]）, `ProgramFiles\Microsoft\Edge\Application`（[推測] 将来移る可能性に備える） | `LocalAppData\Vivaldi\Application`, `ProgramFiles\Vivaldi\Application` [実測] |
| `lookupOrder` | `["chrome"]`（HKCU のみ。HKLM との優先は [未検証]、親設計 WP-2 と同じ項目） | `["edge", "chromium", "chrome"]` [文書] | [未検証]。候補: `["vivaldi"]`、`["vivaldi", "chrome"]`、`["chrome"]` |
| `ownTargets` | `["chrome"]` | `["edge"]` | [未検証]（`["vivaldi"]` か `[]`＝Chrome キーを共用） |
| `registration` | `always`（オーナー決定 3） | `always`（オーナー決定 3） | `when-present`（推奨、§3.4、オーナー判断 Q1） |
| `policyRoot` | `Google\Chrome` [コード] | `Microsoft\Edge` [文書]（`NativeMessagingUserLevelHosts`。他の 5 policy 名も同名と見込むが [未検証]: 文書で 1 件ずつ確認する） | `null`（[未検証]。わかるまで policy では止めない） |
| 拡張機能ページ | `chrome://extensions` / argv `["chrome://extensions/"]`（親設計 WP-2 で起動確認 [未検証]） | `edge://extensions` / `["edge://extensions/"]` [文書の手順にある URL]。exe 引数での起動は [未検証] | `vivaldi://extensions` / `["vivaldi://extensions/"]` [未検証]（`chrome://extensions/` で開くかも併せて確認） |
| デベロッパー モードのラベル・位置 | 「デベロッパー モード」・画面の右上（親設計の想定、[未検証]） | 「開発者モード」・画面の左側（[推測]） | Chrome と同じ（[推測]） |
| 読み込みボタン | 「パッケージ化されていない拡張機能を読み込む」（[未検証]） | 「展開して読み込み」（[推測]） | Chrome と同じ（[推測]） |
| 再読み込みのラベル | ↻（親設計の［更新］表記を再確認、[未検証]） | [未検証] | [未検証] |
| `store` | `chrome-web-store` | `edge-add-ons`（Edge は Chrome Web Store からの追加も可能、[推測]） | `chrome-web-store`（[推測]） |
| `downloadUrl` | `https://www.google.com/chrome/`（[推測] URL。実装前に確認） | `https://www.microsoft.com/edge/download`（[推測] URL。実装前に確認） | `null`（案内しない） |

`ui.*` の文字列は spike のスクリーンショットで確定するまで、実装では表から読むだけにし、
release gate（§9 S10）で `evidence` が `"measured"` になっていることを要求する。

### 1.5 複数インストールの優先規則（exe の選び方）

対象は「拡張機能ページを開く exe」の選択だけである。Native Messaging の登録は HKCU の
ユーザー単位キーなので、どの install から起動されたブラウザーにも同じように効く
（[推測]。Vivaldi は spike で確認）。

1. そのブラウザーが既定ブラウザーなら、既定の ProgId の open command から exe を求め、
   それが **検証済み候補のどれかと一致したとき** だけ、その候補を使う（利用者がふだん
   起動している install を選ぶため）。
   - ProgId は `^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$` を満たすときだけ subkey に使う（`..\` 等の注入防止。
     実装 S2、`PROG_ID_PATTERN`。先頭が英数字なので `.` 始まりは通らない）。
   - 読む値: `HKCU\Software\Classes\<ProgId>\shell\open\command`（既定値）、無ければ
     `HKLM\SOFTWARE\Classes\<ProgId>\shell\open\command`。
   - 先頭が `"` ならその次の `"` まで、そうでなければ最初の空白までを exe とする。
     **この文字列を直接起動しない。** 候補（下の 2・3 で検証済み）との大文字小文字を
     無視した完全一致の照合にだけ使う。
2. それ以外は親設計の順: App Paths HKCU → HKLM 64-bit → HKLM 32-bit → known folders
   （LocalAppData → ProgramFiles → ProgramFilesX86）。HKCU が先なのは Windows の App Paths
   と同じ「ユーザー単位が PC 全体より優先」に合わせるため（[推測]: Windows の挙動として
   一般に知られているが本書では未確認）。
3. 候補の検証は現行 `validateChromeCandidate` を一般化する: ローカル絶対パス、未展開の
   `%` なし、basename が行の `fileName`、全要素が存在し reparse point でない、末尾が通常
   ファイル。

テスト機の Vivaldi（両 install、既定）では規則 1 で決まる。どちらになるかは spike で記録する。

---

## 2. 既定ブラウザー検出と分岐

### 2.1 読み取り

- ProgId: `HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\` 配下を読む。
  先に **`UserChoiceLatest\ProgId` サブキーの値 `ProgId`**、無ければ **`UserChoice` の値 `ProgId`**
  （`UserChoice` は ProgId を直接持つ）。どちらも読み取りのみ。実測（S2 実装時、Windows 11）:
  `UserChoiceLatest` は `Hash` 値と `ProgId` サブキーを持ち、答えはそのサブキーの `ProgId` 値。
  `UserChoiceLatest` の意味は非公式情報（§0.3）なので、spike でテスト機の両方の値を記録する
  （実ブラウザーでの値の食い違いは UNVERIFIED）。テスト機の `UserChoice` は
  `VivaldiHTM` [実測]。
- 分類（`classifyDefaultBrowser` を表駆動に置き換え）:
  - 表の行の `progIdPattern` に一致 → `{ kind: "table", id }`（`verification` は別に見る）。
  - 既知の未検証 Chromium（Brave、Opera、Arc、Yandex、Chromium、Chrome Beta/Dev/Canary、
    Edge Beta/Dev/Canary）→ `other-chromium`。
  - それ以外 → `other`。読めない・空 → `unknown`。
- 型: `DefaultBrowserKind = CollectorBrowserId | "other-chromium" | "other" | "unknown"`。
  現行の `"chrome" | "edge" | ...` からは `"vivaldi"` の追加と Vivaldi の `other-chromium`
  からの除外だけで済む。

### 2.2 おすすめの決め方（純粋関数 `recommendCollectorBrowser`）

入力: 既定の分類、各行の検出結果（`found | not-found | unknown`）、各行の `verification`、
各行の policy 判定。出力: `recommended: CollectorBrowserId | null` と `reason`。

1. 既定が表の行で、`verified`、`found`、policy でブロックされていない → その行。
2. それ以外は `COLLECTOR_BROWSER_IDS` の順（Edge → Chrome → Vivaldi）で、`verified`・
   `found`・非ブロックの最初の行（オーナー決定 2: Edge を勧める）。
3. どれも無い → `null`。

`reason` は `default-supported | default-unsupported | default-unverified | default-not-installed |
default-unknown | none-installed | detection-failed` の列挙。文言はこれで選ぶ。

### 2.3 Step A の分岐と文言案

Step A の見出しと本文（親設計 §4.2 を置き換え）:

- Title: 「ブラウザーで集めた引用を本棚へ（MAGINALIA Collector）」
- Body: 「MAGINALIA Collector は、Web ページの文章を MAGINALIA の Private Shelf（本棚）に保存する
  ブラウザーの拡張機能です。{対応ブラウザー一覧} で使えます。設定には 5 分ほどかかります。
  途中でブラウザーの画面を操作していただく手順があります。」
  - `{対応ブラウザー一覧}` は `verified` 行の表示名を「、」でつないだもの。例:「Microsoft Edge、
    Google Chrome」（Vivaldi は spike 後に自動で加わる）。
- List 1 行目を変更: 「このパソコンのあなたのユーザーだけに、MAGINALIA 連携プログラムを登録します
  （管理者権限は不要です）。Microsoft Edge と Google Chrome のどちらでも使えるように登録します。」
- ブラウザーの選択は `role="radiogroup"` の一覧（見つかった `verified` 行のみ。おすすめを
  初期選択し「（おすすめ）」を付ける）。選択は UI 上の選択であり、**登録対象は選択に
  依存しない**（Chrome と Edge は常に登録、§3.4）。選択は Step D の画面と通知の文言に使う。

| `reason` | 文言 | 操作 |
| --- | --- | --- |
| `default-supported` | 「ふだんお使いのブラウザー（{name}）で使えます。{name} に Collector を入れることをおすすめします。」 | 一覧（{name} 初期選択）、[次へ] |
| `default-unsupported`（Firefox 等） | 「ふだんお使いのブラウザーには、Collector を入れられません。」 / 「Windows に入っている Microsoft Edge をおすすめします。引用を集めるときは、Edge で Web ページを開いてください。」 | 一覧（Edge 初期選択、Chrome・Vivaldi は入っていれば選べる）、[次へ] |
| `default-unverified`（Brave 等、または表にあるが `unverified` の行） | 「ふだんお使いのブラウザーでは、Collector の動作をまだ確認していません。」 / 「確認済みの {recommendedName} をおすすめします。引用を集めるときは、{recommendedName} で Web ページを開いてください。」 | 同上 |
| `default-not-installed`（ProgId は対応ブラウザーだが exe が見つからない） | 「既定のブラウザーとして {name} が設定されていますが、プログラムが見つかりませんでした。」 / 「{recommendedName} をおすすめします。」 | 同上 |
| `default-unknown` | 「ふだんお使いのブラウザーを確認できませんでした。」 / 「{recommendedName} をおすすめします。」 | 同上 |
| `none-installed` | 「対応しているブラウザー（{対応ブラウザー一覧}）が見つかりませんでした。」 / 「いずれかをインストールしてから、もう一度確認してください。」 | [Microsoft Edge のダウンロードページを開く] [Google Chrome のダウンロードページを開く] [もう一度確認] [ブラウザーは入っています（このまま続ける）] [あとで設定] |
| `detection-failed`（全行 `unknown`） | 「ブラウザーの確認中に問題が起きました。」 / 「お使いのブラウザーを下から選んでください。」 | 全 `verified` 行を「確認できませんでした」付きで表示、[このブラウザーで続ける] [あとで設定] |

規則:

- 何も書き込まないのは［設定を始める］→ Step B の［連携プログラムを登録する］を押すまで
  （親設計と同じ）。`none-installed` / `detection-failed` で続けるときは
  `proceedWithoutSupportedBrowser: true` を明示的に送る（現行 `proceedWithoutChrome` の改名）。
  このとき Step D は手動手順のみ（［{name} で拡張機能の画面を開く］ボタンは出さない）。
- policy でブロックされた行は一覧に「組織の管理設定により使えません」と表示し選べない。
- 「完了」は Step E の接続確認（または親設計の「user-confirmed」fallback、明示ラベル付き）
  以外では出さない（plan 30 L282）。複数プロファイルの注意は Step D に残す。

### 2.4 Step D のブラウザー依存部分

親設計 §4.5 の文言のうち次をブラウザー行から差し込む。

- Title: 「{name} に Collector を読み込む」
- 手順 1: 「［{name} で拡張機能の画面を開く］を押します。{name} に「拡張機能」の画面が開きます。」
  補足: 「開かない場合は、{name} のアドレスバーに {displayUrl} と入力して Enter キーを押してください。」 [アドレスをコピー]
- 手順 2: 「{developerModeLocation}にある「{developerModeLabel}」をオンにします。」
- 手順 3: 「「{loadUnpackedLabel}」を押します。」
- ドラッグ: 「…{name} の拡張機能の画面にドラッグしてください（{developerModeLabel}がオンのとき）。」
- 注意: 「{name} を複数のユーザー（プロフィール）で使い分けている場合は、Collector を使う
  プロフィールの画面で読み込んでください。」「{developerModeLabel}はオンのままにしてください。」
  「読み込んだ Collector を {name} から削除しないでください。削除すると、まだ本棚に保存されていない
  （保留中の）引用も消えます。」
- 別のブラウザーにも入れたい利用者向けの注記（折りたたみ）: 「Collector は 1 つのブラウザーで
  使うことをおすすめします。2 つのブラウザーに入れると、保留中の引用はブラウザーごとに別々に
  保存されます。」（Outbox はプロファイルごと。重複保存の抑止は Host の request ID の範囲外: 親設計 §7）

Step E: 「Chrome の Collector からの接続を待っています…」→「ブラウザーの Collector からの
接続を待っています…」、成功は「MAGINALIA Collector から接続を確認しました。」。contact record は
どのブラウザーから来たかを記録しないので、ブラウザー名を断定しない。タイムアウトの
チェックリストの ID は全ブラウザー共通（§3.6）。

---

## 3. 登録モデル

### 3.1 何をどこに書くか

- **manifest ファイルは 1 つ**（`<program folder>\org.maginalia.collector.json`、内容は現行と同一）。
  全 target の既定値は同じ manifest パスを指す。理由: Host slot・`allowed_origins`・
  self-check を 1 つに保つことで、親設計の不変条件（§5.1）を target 数に関係なく 1 本で
  証明できる。target ごとに manifest を分ける案は、slot 切替を N 回の rename にし、
  クラッシュ時に target 間で指す slot がずれるので採らない。
- 書く target の集合（expected set、`E`）:
  - `registration: "always"` かつ `verified` の行の `ownTargets`（= `chrome`, `edge`）。
  - `registration: "when-present"` かつ `verified` の行の `ownTargets` で、その行が
    `found` であるか、state file の `registeredTargets` に含まれるもの（§4.3）。
  - ただし行が policy でブロックされているとき、その行の `ownTargets` は `E` から除く
    （書いても使われないため。親設計「policy-blocked では何も書かない」を行単位にしたもの）。
- read-only target（`chromium`）は書かない・消さない。

### 3.2 addon（WP-3 改修）

現行は書込み関数が引数を持たないことで「呼び出し側がキーを選べない」を保証している。
複数キーでは次の 2 案を比べた。

| 案 | 内容 | 評価 |
| --- | --- | --- |
| A. target ごとに引数なし関数を export（`registerChromeHost`, `registerEdgeHost`, …） | 現行の性質をそのまま保つ | export が target × 4 に増え、行追加のたびに addon の API 形が変わる。wrapper・adapter・fake も増える。 |
| **B. 1 つの列挙引数**（`register(target)`） | C++ の compile-time 表 `{id, subkey, writable}` に対し、引数文字列を表の `id` と ordinal 完全一致で照合して index に変換する。表に無い・writable でない → `invalid-argument`。**引数の文字列がレジストリ API に渡ることはない。** 値（manifest パス）は今と同じく C++ が known folder から計算する。 | 呼び出し側が選べるのは「表にある固定キーのどれか」だけで、任意のキー・値・hive は選べない。性質は保たれる。 |

**B を採る。** addon API を `apiVersion: 2` にする。

```text
inspectCollectorHostRegistration(target: "chrome"|"edge"|"vivaldi"|"chromium") -> {status: absent|ours|foreign|access-denied|failed}
registerCollectorHost(target: writable id)                 -> {status: ok|foreign|access-denied|failed}
replaceForeignCollectorHostRegistration(target: writable id) -> same
unregisterCollectorHost(target: writable id)               -> {status: ok|not-registered|foreign|access-denied|failed}
listCollectorHostTargets()                                 -> [{id, subkey, writable}]  // read-only, for the consistency test
```

- `InspectExisting` は target の subkey を受ける形にするだけで、判定規則（空値は absent、
  REG_SZ の ordinal 大文字小文字無視一致で ours、REG_LINK・型違い・超過は foreign）は不変。
- `vivaldi` は spike で Vivaldi が独自キーを読むと確定するまで **C++ 表に入れない**
  （`listCollectorHostTargets` にも出ない）。TS 表の `vivaldi` target は `writable: false` のまま
  とし、unit test は「TS 表の writable target 集合 == addon 表の writable 集合」を要求する。
  > **spike 結果（2026-11-20）:** Vivaldi は独自キーを読まないと実測された（§3.4）。したがって
  > `vivaldi` は C++ 表に入らない。TS 表の `vivaldi` target も削除する（読まれないキーに
  > 誤って書く経路を作らないため）。
- test seam（`MAGINALIA_WI_TEST_SEAM`）は target ごとに `HKCU\Software\MAGINALIA-Tests\<root>\<id>\NativeMessagingHosts\org.maginalia.collector`
  へ写す。product target にはこのコードが無いことを現行の export/strings test で確認する。
- wrapper（`windows-integration.ts`）は引数を `COLLECTOR_REGISTRY_TARGET_IDS` で検証し、
  writable 系は addon が返す writable 集合でも検証する。`apiVersion !== 2` の addon は
  `windows-integration-unavailable`。

### 3.3 所有判定と他者の登録

- target ごとに独立に `absent | ours | foreign | unknown` を判定する（値一致、addon の 1 箇所）。
- **foreign は上書きしない**（現行と同じ）。setup/repair の precondition で、`E` の中に
  foreign があれば `foreign-confirmation-required` で拒否する。利用者が確認ダイアログで
  ［切り替える］を選んだら `confirmReplaceForeign: true` で再実行し、**そのとき foreign だった
  `E` の target をすべて** `replaceForeign(target)` で置き換える。
  - IPC は boolean のままにする（最小変更）。どのブラウザーが foreign かは status の
    ブラウザー別情報（§7.3）でダイアログに列挙する:
    「次のブラウザーでは、別の場所にある連携プログラムが登録されています：{names}。
    MAGINALIA に付属する連携プログラムに切り替えますか？ 本棚や引用データは変更されません。」
  - TOCTOU: `guard` は「precondition 時の target 別 verdict の snapshot」と現在値を比べ、
    1 つでも違えば `registration-changed` で止める（現行の単一比較を target 別にしたもの）。
    これにより、確認後に foreign 化した別 target を勝手に置き換えることはない。
  - 案として「foreign の target だけ残して他を進める」（ブラウザー単位 skip）も考えたが、
    foreign の発生源は旧スタンドアロン Host（Chrome キーのみ）くらいで稀なので、確認の
    UI と状態を増やさない「全部切り替え／やめる」を推奨する（オーナー判断 Q5）。
- 旧スタンドアロン Host の移行（親設計 §4.3）は Chrome target が foreign のときだけ従来どおり。
- `E` の外の target（例: policy ブロック中の Chrome、未検出の Vivaldi）の foreign は無視する
  （状態に影響させない。ブラウザー別表示には出す）。

### 3.4 Vivaldi の登録（spike 後）

spike の結果で 3 通りに分かれる。どの場合も行の `lookupOrder` と `ownTargets` を埋め、
`verification` を `verified` にするだけで、他のコードは変えない。

| spike 結果 | 行の値 | addon |
| --- | --- | --- |
| Vivaldi は Chrome キーだけを読む | `lookupOrder: ["chrome"]`, `ownTargets: []` | 変更なし。`vivaldi` target を TS 表から削除。 |
| Vivaldi は自キーだけを読む | `lookupOrder: ["vivaldi"]`, `ownTargets: ["vivaldi"]`, `registration: "when-present"` | C++ 表に `vivaldi` を追加。NSIS も。 |
| 自キー → Chrome キーの順（Edge と同型） | `lookupOrder: ["vivaldi", "chrome"]`, `ownTargets: ["vivaldi"]`（推奨: 他者の自キー登録に割り込まれないよう自分で持つ） | 同上 |

> **spike 結果（2026-11-20）— 上の表の 1 行目に確定。** テスト機（Windows 11、Vivaldi 8.3、
> PC 全体版と個人用版の両方）で K1/K3/K4/K6/K7 を実測した。
>
> | 登録したキー | Vivaldi が読んだもの |
> | --- | --- |
> | Vivaldi のみ（K4） | **読まない**（host not found） |
> | Chrome のみ（K1） | Chrome キー |
> | Chrome + Vivaldi（K6） | Chrome キー（Vivaldi キーは無視） |
> | Chromium のみ（K3） | Chromium キー |
> | Chrome + Chromium（K7） | **Chromium キー**（Chromium が優先） |
>
> 結論:
> - 行の値は `lookupOrder: ["chromium", "chrome"]`, `ownTargets: []`。Vivaldi 専用の登録は
>   **しない**（`registration: "when-present"` の議論は不要になる）。C++ 表・NSIS・TS 表の
>   `vivaldi` target は追加しない。
> - Vivaldi は Chrome キーの登録で動く。つまり Chrome target を常に登録する現行方針で
>   カバーされる。ただし **Edge と同じく、他者の `Software\Chromium\NativeMessagingHosts\org.maginalia.collector` が
>   あると Chrome キーより優先される**（決定 (d) の foreign-Chromium-key 分岐が Vivaldi にも必要）。
> - Vivaldi を `verified` にするには、この結果に加えて S8（wizard）の文言と実 Collector の動作確認が
>   要る（本 spike は probe 拡張）。

`when-present` を推奨する理由（オーナー判断 Q1）: Vivaldi を入れていない利用者の HKCU に
`Software\Vivaldi\...` という他社の名前空間を作らないため。NSIS は葉のキーしか消さないので、
作ると親キーが残る。Chrome と Edge はオーナー決定で常に登録する（Edge は Windows 標準）。

### 3.5 HKLM と他の場所

- HKLM には書かない・消さない（親設計 §8.4）。HKLM の同名登録は read-only で検出し、
  ブラウザー別表示に「PC 全体の登録あり」と出すだけ（Edge は HKCU を先に見る [文書]。
  Chrome の順は [未検証]）。
- `HKCU\Software\Chromium\...` は Edge の 2 番目の探索先 [文書]。MAGINALIA は Edge キーを
  自分で持つので、Chromium キーが Edge に効くのは Edge キーが無いときだけ。ブラウザー別の
  「有効な登録」（§4.2）を正しく出すために読むだけにする。

> **spike 結果（2026-11-20）— §3.5 の Edge の探索順を実測で確認:** Edge は Edge キー → Chromium キー →
> Chrome キーの順（K1: Chrome キーに fallback、K2: Edge キーで応答、K5: Edge キーが優先、K7:
> Chromium キーが Chrome キーより優先）。Chrome は Chrome キーだけを読む（K2: Edge キーのみでは
> host not found、K7: Chromium キーは無視）。Chrome の HKCU と HKLM の優先は未検証のまま。

### 3.6 拡張機能 ID と `allowed_origins`

> **spike 結果（2026-11-20）:** probe 拡張（固定 `key`）の ID は Chrome・Edge・Vivaldi で同一
> （V-ID）。Host 第 1 引数は 3 ブラウザーとも `chrome-extension://<id>/` と `--parent-window=<n>`
> （V-ORIGIN）。実 Collector 0.3.0 の ID（`blgmoddncpknfnikdfnjelmdmphfgknf`）は Chrome でのみ確認。
> Edge・Vivaldi では実 Collector の確認が未実施。manifest の `path` は `subdir`（相対）・`flat`・
> `abs`（日本語フォルダー）とも Chrome と Edge で解決した（V-REL。Vivaldi の `flat`/`abs` は未実施）。

- unpacked の拡張機能 ID は manifest の `key` から決まる（SHA-256 → a–p）[コード]。同じ
  Chromium のアルゴリズムなので 3 ブラウザーで同じ ID になる見込みだが [未検証]（spike 項目
  V-ID）。Edge は sideload の ID を `allowed_origins` に使う手順を文書化している [文書]。
- `allowed_origins` は現行どおり `["chrome-extension://blgmoddncpknfnikdfnjelmdmphfgknf/"]` の
  1 要素。Edge の Host 第 1 引数も `chrome-extension://` 形式 [文書]。Vivaldi は [未検証]。
- **検証方法:** spike で各ブラウザーの拡張機能ページの ID 表示と、テスト Host が受け取った
  第 1 引数を記録する。製品では Host の `isAllowedCollectorOrigin`（完全一致）がそのまま
  検査になる。ID が一致しないブラウザーが出たら、そのブラウザーは `verified` にしない
  （`allowed_origins` に別 ID を足すのは別の product decision）。
- ストア公開時（親設計 §7）は Chrome Web Store と Edge Add-ons で ID が別になり得る [文書]。
  `COLLECTOR_ALLOWED_ORIGINS` に両方を入れる。Edge は最初に見つかった manifest しか読まない
  [文書] ので、1 つの manifest に全 ID が入っている現行方式（manifest 1 つ）がそのまま合う。

---

## 4. 状態モデル

### 4.1 方針

- 集約状態 `CollectorIntegrationState`（7 状態）と、その意味・優先順位・WP-5c の refresh/repair
  規則は **変えない**。変えるのは「登録」の入力が 1 値から target 別になることだけ。
- 追加するのは (a) target 別の所有判定、(b) ブラウザー別の詳細、(c) state file の
  `registeredTargets`、(d) reason 2 つ。

### 4.2 型の変更（`collector-integration-types.ts`）

```ts
export type CollectorTargetOwnership = HostRegistrationOwnership | "unknown";

export interface CollectorBrowserStatus {
  readonly id: CollectorBrowserId;
  readonly verification: "verified" | "unverified";
  readonly installed: "found" | "not-found" | "unknown";
  readonly source: BrowserExecutableSource | null;      // ChromeSource generalized; never a path
  /** First present target in lookupOrder: what this browser will actually use. */
  readonly effective: { readonly target: CollectorRegistryTargetId; readonly ownership: "ours" | "foreign" } | { readonly target: null; readonly ownership: "absent" | "unknown" };
  readonly policy: ChromePolicyEvaluation & { readonly status: "read" | "unavailable" | "not-applicable" };
}

export interface CollectorIntegrationInspection {
  // ... unchanged fields ...
  /** Aggregate over the expected set (kept for the state machine and existing callers). */
  readonly registration: HostRegistrationOwnership | "unknown";
  /** NEW: per registry target, including read-only ones. */
  readonly registrations: Readonly<Record<CollectorRegistryTargetId, CollectorTargetOwnership>>;
  /** NEW: the expected set E of 3.1, in table order. */
  readonly expectedTargets: readonly CollectorRegistryTargetId[];
  /** REPLACES `chrome`: per browser, in table order, plus default and recommendation. */
  readonly browsers: {
    readonly defaultBrowser: DefaultBrowserKind;
    readonly recommended: CollectorBrowserId | null;
    readonly recommendationReason: CollectorRecommendationReason;
    readonly entries: readonly CollectorBrowserStatus[];
  };
  /** Aggregate policy: `blocked` only when every verified browser is blocked (4.4). */
  readonly policy: ChromePolicyEvaluation & { readonly status: "read" | "unavailable" };
}
```

`ChromeLocation`/`locateChromeExecutable` は `locateBrowserExecutable(id, deps)` に一般化し、
戻り値の `executablePath` は従来どおり main process 内だけで使う。

集約 `registration`（`E` に対して）:

- `E` のどれかが `unknown` → `unknown`（inspection incomplete、`damaged` に fail closed: 現行どおり）。
- どれかが `foreign` → `foreign`。
- どれかが `ours` → `ours`（一部 `absent` を含む「混在」もここ）。
- 全部 `absent`（`E` が空のときも）→ `absent`。
- **policy-blocked のときの集計（実装 S3）:** 全ブラウザーが policy でブロックされると `E` は空になるが、
  こちらの登録が残っていることがある。このとき `registration` の集計と「読めない target」による
  `inspectionComplete` の判定は、`E` ではなく **`E_all`**（`verified` 行の `ownTargets` ∪
  state の `registeredTargets`、policy・検出を無視）で行う。`E` の定義（§3.1）は変えない。

### 4.3 state file v2

`integration-state.json`:

```json
{ "version": 2, "payloadId": "...", "activeSlot": "a", "extensionVersion": "0.3.0",
  "placedAt": "...", "registeredTargets": ["chrome", "edge"] }
```

- `registeredTargets`: 直近の apply が書く writable target（表順、重複なし、既知の id のみ）。
  - **実装（S4）との差:** 当初案は「read-back で `ours` を確認した target」だが、実装は
    **「apply が責任を持った `E`（書込みが拒否・失敗した target も含む）∪ 直前の `registeredTargets`」**
    を書く（試行した expected set。増える方向にのみ変わる。`ours` の確認とは別）。理由は、拒否された
    書込みが次回 `outdated(registration-target-added)` になって、通知なしに起動のたびに自動 refresh を
    繰り返すのを避け、`registration-missing`（repair 通知）に留めるため。
  - **残る課題（M2、S10 前に解決）:** `when-present` 行の `E` への算入は `registeredTargets` を
    見る（§3.1）ので、「試行した」が「登録済み」と混ざり、検出されなくなったブラウザーの行が `E` に
    残り続ける恐れがある。S10 で `when-present` 行を有効にする前に、attempted（試行した `E`）と
    confirmed（read-back で `ours`）を分ける必要がある。分け方は本書では決めない。
- v1（5 フィールド）は読める: `registeredTargets = ["chrome"]` とみなす。書くのは常に v2。
- パスも Shelf 情報も含まない（親設計 §8.6 を維持）。NSIS の検証も v1/v2 の両方を受ける（§6）。

### 4.4 集約の規則（`inspectCollectorIntegration` の変更点だけ）

優先順位は現行のまま。各段の条件を次のように読み替える。

1. **policy-blocked:** `verified` 行がすべて policy でブロック → `policy-blocked`。
   一部だけなら集約には出さず、その行を `E` から外し、ブラウザー別に `policy.blocked` を出す。
2. **incomplete → damaged:** 現行どおり（`E` の target 読取り失敗を含む）。
3. **foreign-registration:** `E` に foreign がある。
4. フォルダー・構造の検査（現行）で、「registration ours」を「`E` のどれかが ours」、
   「registration absent」を「`E` が全部 absent」と読む。
5. 構造が健全（現行なら `ready`/`outdated` に進む位置）で、`E` に `absent` の target が残るとき:
   - その target が `registeredTargets` に **含まれる** → reason `registration-absent`、状態
     `registration-missing`（誰かが消した。黙って直さない: 親設計 §6.2）。
   - **含まれない** → reason `registration-target-added`、状態 `outdated`（新しい版で登録先が
     増えた、または `when-present` のブラウザーが新しく入った）。WP-5c の自動 refresh が
     追加登録する（オーナー判断 Q2）。
   - 両方あれば `registration-missing` を優先（user-confirmed repair が両方を直す）。
   - **foreign-registration 分岐（実装 S3/S4 判断 d）:** 追加される target（`registeredTargets` に無い
     absent）を登録すると、あるブラウザーが現在使っている **foreign の登録を覆う** 場合
     （Edge キーが absent で、foreign の Chromium フォールバックキー
     `HKCU\Software\Chromium\...` がある。Edge の探索順は Edge → Chromium → Chrome）、
     状態は `outdated` ではなく `foreign-registration`（reason `registration-foreign`）にする。
     自動 refresh（Q2）はこの場合 payload も更新しない。repair 通知が出て、利用者が確認ダイアログで
     切り替えるまで自動更新は止まる。判定は `registrationWouldShadowForeign`。探索順で最初に
     present の鍵だけを見る。読めない鍵は foreign 扱い（fail closed、`damaged` にはしない）。
   - **オーナー向け注記:** 現状 Edge 行は `unverified` なので `E` は Chrome のみで、この分岐は
     働かない。**スパイク待ち**で Edge が `verified` になった時点で、Chromium キーに foreign を持つ
     環境の更新は、repair 通知 → 確認が 1 回出るまで止まる。Edge を verified に切り替えるときに、
     この挙動をオーナーに伝える。
6. `ready` は「構造健全・payload 一致・ハッシュ一致・`E` が全部 ours」。

reason の追加: `registration-target-added`（outdated 系）。`registration-absent` は既存。

### 4.5 ブラウザー別の表示（ウィザード・確認画面）

確認・修復パネル（親設計 §5 `maginalia.collector.repair`）のチェック一覧で、
「Chrome の検出」「登録」を次に置き換える。

| 行 | 表示例 |
| --- | --- |
| ブラウザー | 「Microsoft Edge：見つかりました」「Google Chrome：見つかりました」「Vivaldi：見つかりました（動作確認中のため未対応）」 |
| 登録（ブラウザー別、`effective`） | 「Microsoft Edge：登録済み」「Google Chrome：登録されていません」「Microsoft Edge：別の連携プログラムが登録されています」「Microsoft Edge：Chrome 用の登録を使っています」（Edge キー absent・Chrome キー ours の fallback 状態） |
| 組織の管理設定 | 「Google Chrome：組織の管理設定により使えません」 |

### 4.6 WP-5c（通知・起動時 refresh）への影響

- 状態集合と refresh/repair の分岐規則は不変。新しい `outdated(registration-target-added)` は
  既存の「`outdated` かつ自分のもの → 自動 refresh」に乗る。
- **「更新しました」通知の誤表示を防ぐ:** 現行は refresh `applied` で updated 通知を出す。
  登録だけを足す refresh（§5.4）では Host も拡張機能も変わっていないので、updated 通知を
  出してはいけない。orchestrator は「apply 前後で `installed.payloadId` が変わったか」で
  updated 通知を決める（refresh 結果に `filesChanged: boolean` を足す案でもよい。前者を推奨:
  型を増やさない）。
  - **実装（S6）:** `payloadId` の前後比較を採用。updated 通知は `payloadId` が変わったときだけ。
    registration-only refresh（同じ payload）では出ず、保留中の updated 通知もそのまま残る。
    apply 結果の `filesChanged`（S4 で追加）は S6 では使っていない。
- 通知文言の「Chrome」をブラウザー名に置き換える（§7.5）。どのブラウザーかは Desktop が
  覚えている「最後に選んだブラウザー」（§7.4）を使い、無ければ「ブラウザー」と書く。
- α1 通知: 「Chrome で読んでいる Web ページの引用を…」→「{対応ブラウザー一覧} で読んでいる
  Web ページの引用を、本棚に保存できるようになりました（MAGINALIA Collector）。」
- repair 通知 detail: 「Chrome から本棚へ引用を保存する連携が…」→「ブラウザーから本棚へ…」。
- 既存の穴（本件で少し起きやすくなる）: remove が target を順に消している途中で落ちると、
  次回起動で `registration-missing` になり repair 通知が出る。`removeRequested` は apply 結果の
  記録時にしか永続化されないため。**推奨:** service が remove の apply を始める前に
  `removeRequested: true` を書き、`applied`/`partial` 以外（`refused`）で戻す
  （WP-7a の小改修、§9 S6）。単一キーの現行にも同じ穴があるので、本書の範囲では
  「推奨」として明記し、実施はオーナー判断 Q9。
- **S6 の未実装分（S7 と連動する後続）:** 通知文言のブラウザー名化（現状の通知は「Chrome」のまま）、
  通知状態 v2（`browser`）と v1→v2 の読み込み、Q9 の `removeRequested` 先行記録。
  いずれも「最後に選んだブラウザー」（§7.4）が S7 で入ってから行う。

---

## 5. apply（setup / repair / refresh / remove）

### 5.1 不変条件

現行（WP-5b, design 6.3）:

> **I:** registration ours かつ manifest 有効 ⇒ manifest が指す slot はハッシュ完全。

複数 target での形:

> **I′:** すべての target t について、`ownership(t) = ours` かつ manifest 有効 ⇒ manifest が
> 指す slot はハッシュ完全。
>
> **J:** `ours` の target の値は、すべて同一の manifest パス（この利用者の program folder の
> manifest）である。

- J は addon が保証する: 値は C++ が known folder から計算する 1 つの文字列で、`ours` はその
  文字列との一致でしか判定されない。
- J により I′ は I と同値になる（どの ours target も同じ manifest → 同じ slot を指す）。
  したがって **target 数が増えても、slot・manifest の書込み順（現行）を変えなければ I′ は
  すべてのクラッシュ点で保たれる**。
- 追加の不変条件:
  > **K（当初案）:** `registeredTargets` ⊆ state file を書いた時点で ours だった target。
  >
  > **K（実装 S4）:** `registeredTargets` = 試行した `E` ∪ 直前の値。`ours` の部分集合では**ない**
  > （書込みが拒否された target も入る。§4.3 の M2 を参照）。I′/J には影響しない
  > （I′/J は registry の `ours` だけを見る）。
  state file は registry 書込みと read-back の後に書く。registry 書込みの後・
  state file の前に落ちると「ours だが `registeredTargets` に無い」target ができるが、
  §4.4 の規則は absent の target にしか `registeredTargets` を見ないので無害。

### 5.2 setup / repair の順序（変更点は step 8 と 9）

1〜7 は現行のまま（precondition、program folder、integration folder、swap 回復、inactive slot、
extension、manifest 切替）。

8. **registry（target 別、表順 `chrome → edge → vivaldi`）:** `E` の各 t について
   - `ours` → 何もしない。
   - `absent` → `register(t)`。
   - `foreign`（precondition で確認済みのもの）→ `replaceForeign(t)`。
   - 書けたら直後に `inspect(t)` で read-back し `ours` を要求（違えば
     `registry-readback-mismatch` で abort: 現行と同じ扱い）。
   - **途中の失敗で止めない:** `access-denied`/`failed` はその t の結果として記録し、残りの
     target へ進む（キーは互いに独立で、1 つの拒否が他ブラウザーを止める理由がない）。
     `foreign` が返った（＝確認後に誰かが書いた）場合だけは `registration-changed` で abort
     （現行どおり）。
9. **state file v2:** `registeredTargets` = step 8 の後に `ours` だった `E` の target。
   失敗した target は含めない（§4.4 により次回 `outdated(registration-target-added)` →
   自動 refresh で 1 回ずつ再試行される。再試行が拒否され続ける場合は、その refresh の
   `failed` が WP-5c で repair 通知になる）。
   - **実装（S4）は上記と異なる:** `registeredTargets` = `E` 全体（拒否・失敗した target を含む）∪
     直前の `registeredTargets`。拒否された target は次回 `registration-missing`（repair 通知、
     自動 refresh しない）になり、「毎起動の無通知 refresh」を避ける。§4.3 / §5.1 K の注記を参照。
     §5.3 の表で「一部の target を書いた後」の `outdated` 列も、拒否された target については
     `registration-missing` と読み替える。
10. self-check（現行どおり。1 回だけ）。

結果（`CollectorApplyResult`）に追加:

```ts
readonly targets: readonly { readonly target: CollectorRegistryTargetId; readonly result: "ours-already" | "registered" | "replaced" | "denied" | "failed" | "skipped-policy" | "not-expected" }[];
```

- `outcome`: どれか denied/failed なら `failed`、`reason` は denied があれば
  `registry-write-denied`、なければ `registry-write-failed`（現行の reason を流用）。
- ウィザード Step B は「選んだブラウザーの `effective` が ours か」で判断する:
  - ours（自キー、または Edge が Chrome キーへ fallback して ours）→ 成功扱いで [次へ]。他の
    target の失敗は警告行で出す: 「{name} 用の登録はできませんでした。{selectedName} では
    使えます。」
  - ours でない → 親設計の「Registry write denied」行（「連携プログラムを登録できませんでした。」）。

### 5.3 クラッシュ・途中失敗の扱い（ロールバックではなく前進回復）

| どこで止まったか | 残る状態 | 次の inspect | 回復 |
| --- | --- | --- | --- |
| step 8 の前 | 現行と同じ | 現行と同じ | 現行と同じ |
| 初回 setup、`chrome` を書いた直後 | Chrome キー ours、Edge absent、state file なし | `damaged`（`state-file-missing`: ours だが state なし。現行の単一キーと同じ） | repair が Edge を足し state を書く |
| refresh/repair、一部の target を書いた後 | 一部 ours、state file は旧（v1 か旧 `registeredTargets`） | 足りない target が `registeredTargets` に無い → `outdated(registration-target-added)`。ある → `registration-missing` | refresh か repair（どちらも target を足す） |
| step 9 の後、self-check 前 | 完全 | `ready` | なし |

- **ロールバックしない理由:** I′ により、どの時点でも ours の target は完全な slot を指して
  いる。書けた target を消し戻すと、既に動いているブラウザーを壊すだけで安全性は上がらない。
  これは現行の「manifest 切替後は戻さない」（design 6.3）と同じ方針の延長である。

### 5.4 refresh（登録だけを足す場合）

- precondition: 状態 `outdated` で、reasons が `registration-target-added` **だけ**、かつ
  `installed.payloadId === descriptor.payloadId` のとき、step 5〜7（slot・extension・manifest）を
  省き、step 8〜10 だけを行う（「registration-only refresh」）。
  - 理由: 不要な slot 書込み・extension swap を避け、updated 通知の誤表示を避ける（§4.6）。
  - 実装（S4/S6）: 結果は `filesChanged: false`。updated 通知は `payloadId` の変化だけで決まるので、
    registration-only refresh では出ない。
  - `activeSlot`・`extensionVersion` は現行 state file の値を引き継ぎ、`placedAt` は更新しない
    （ファイルを置いていないため）。
- payload も変わっているときは通常の refresh（step 1〜10）で、step 8 で同時に target を足す。
- 現行の「refresh は registry を書かない（読み戻しだけ）」を「refresh は `E` の absent かつ
  `registeredTargets` に無い target だけを `register` する。foreign は書かない・
  `registeredTargets` にある absent は書かない（それは repair の仕事）」に変える。

### 5.5 remove

1. 全 writable target（`E` に限らない。`chrome`, `edge`, 将来 `vivaldi`）について、表の
   **逆順** に、`ours` なら `unregister(t)`（値一致、addon）。foreign は残し
   `foreign-registration-left` 警告。read-only target は触らない。
2. **1 つでも unregister が失敗したら、ファイルには触らずに `failed` /
   `unregister-failed` で返す**（現行と同じ規則を target 別に）。既に消せた target は消えたまま
   （再登録で戻さない）。結果の `targets` にどれが残ったかを出す。
   - 理由: I′ を remove 中も保つため。ours の target が残っている間に manifest/slot を消すと、
     そのブラウザーから「Host が見つからない」状態になる（安全側の失敗ではあるが、
     「ours ⇒ 完全」が崩れる）。
3. 全部 absent/foreign になってから、現行どおりファイルを固定名で消す。
4. 途中で落ちた場合: 一部の target が absent、state file は有効 → `registration-missing`。
   §4.6 の `removeRequested` 先行記録があれば repair 通知は出ない。利用者が remove をもう一度
   実行すれば収束する（残り target を消し、ファイルを消す）。
5. **実装（S4）の確認と既知の未解決（記録のみ）:** remove が触るのは **writable target だけ**
   （`chrome`, `edge`。表の `writable: true` から導出）。read-only target（`chromium` 等）は読みもしない。
   read-only 側に `ours` があっても消さず、**警告も出さない**（コードに警告は無い）。
   unregister が 1 つ失敗しても残りの target は試し、失敗が 1 つでもあればファイルは触らず
   `failed`/`unregister-failed`。

### 5.6 guard と precondition

- `guard` は (a) E2E isolation、(b) 行別 policy（`E` の構成が変わったら `policy-blocked` ではなく
  `registration-changed` 相当の `expected-targets-changed` で止める。reason を 1 つ追加）、
  (c) 全 target の verdict snapshot 一致、(d) program folder の安全性、を検査する。
- precondition の `foreign-confirmation-required` は「`E` に foreign があり、確認なし」。
- **既知の未解決（記録のみ、S4）:** `guard` が比べるのは policy のブロック集合と、precondition で
  読めた target ごとの verdict snapshot である。**検出（detection）由来の `E` の変化**（`when-present`
  行のブラウザーが precondition の後に入った、等）は再確認しない。`when-present` 行が writable に
  なるまで休眠しており（現状の writable な verified 行は `always` だけ）、S10 で足すときに再検討する。

### 5.7 フォールト注入テストの拡張（`collector-integration-apply-fault.test.ts`）

テスト基盤の変更:

- fake registry（`collector-registry-adapter.test-helper.ts`）を target 別の状態に拡張し、
  `register/replace/unregister` 呼び出しを **file system と同じ mutation カウンター** に
  数える（crash 後は registry 呼び出しも失敗、failure は N 番目の 1 回だけ失敗）。
- `assertPointedSlotComplete` を「ours の target が 1 つでもあれば」に一般化し、さらに
  「ours の target の値はすべて同じ manifest パス」（J）を検査する。
- 「registry は ours か無しだけ」の検査を target 別にし、fixture が最初から置いた foreign
  target は例外にする。

追加シナリオ:

1. 初回 setup（Chrome+Edge）: 全 mutation 点で crash → 1 手で回復（`recover` の対応表に
   `outdated → refresh` は既にある）。
2. 単一 failure: `chrome` だけ denied / `edge` だけ denied → `failed`、`targets` の内容、
   `registeredTargets`、選んだブラウザーの `effective`、次回 refresh で収束。
3. 移行: v1 state + Chrome キーだけ ours（RC3 のインストール）→ `outdated(registration-target-added)`
   → registration-only refresh で `ready`。この refresh の全 crash 点。slot と extension の
   mutation が 0 であること。
4. payload 更新と target 追加が同時の refresh: 全 crash 点。
5. remove: target 間で crash、`edge` unregister denied → ファイル不変・Chrome は absent のまま・
   もう一度 remove で収束。
6. foreign: Edge だけ foreign → 確認なしは refuse・何も書かない、確認ありは Edge を置換。
   precondition と guard の間に Chrome が foreign 化 → `registration-changed`。
7. policy: Chrome だけ policy ブロック → Chrome キーを書かない・`E` から外れる・Edge は ready。
   全 verified 行ブロック → `policy-blocked` で refuse。
8. `when-present`（Vivaldi が writable になった後、または fake の行で先に試す）: 未検出なら書かない、
   検出されたら refresh で足す、`registeredTargets` にあって消えたら `registration-missing`。
9. `chromium` read-only: どのシナリオでも書かれない・消されない。Edge キー absent・Chromium キー
   foreign のとき Edge の `effective` が foreign と出る。

---

## 6. アンインストール（NSIS、WP-8 改修）

### 6.1 方式

- writable target ごとに、現行の Chrome キーと同じブロックを並べる:
  `ReadRegStr` → 値が `$LOCALAPPDATA\Programs\MAGINALIA Collector\org.maginalia.collector.json`
  と等しい（NSIS の `==` は大文字小文字無視）ときだけ `DeleteRegValue` → `DeleteRegKey /ifempty`
  （葉のキーのみ。`Software\Microsoft\Edge\NativeMessagingHosts` 等の親は残す）。
- 定義名: `MAGINALIA_COLLECTOR_HOST_KEY_CHROME`、`MAGINALIA_COLLECTOR_HOST_KEY_EDGE`
  （Vivaldi を足すときは `_VIVALDI`）。`chromium` は書かない target なので NSIS に無い。
- キーの削除は state file の有無に依存しない（現行どおり、値一致だけで判断）。
- `un.MAGINALIA_HasValidState` の PowerShell 検証を v1（5 フィールド）と v2（6 フィールド、
  `registeredTargets` は既知 id の重複なし配列、長さ ≤ writable 数）の両方を受けるように変える。
- `${isUpdated}` ガードと `installMode == "CurrentUser"` だけで実行する規則は維持
  （all-users では何もしない）。
- **実装（S5、`codex/mb-s5-nsis` ce75ffe）:** `apps/desktop/packaging/collector-uninstall.nsh`
  （WP-8 の行の場所）に `MAGINALIA_COLLECTOR_HOST_KEY_CHROME` と `..._EDGE` を直書きし、Chrome と Edge の
  両方を値一致で解除する。`un.MAGINALIA_HasValidState` は state v1（5 フィールド）と v2（+
  `registeredTargets`）を受理する。整合テストは `collector-uninstall.test.ts`（§6.2）。

### 6.2 表を NSIS にどう持つか

| 案 | 内容 | 評価 |
| --- | --- | --- |
| ビルド時生成 | TS 表から `collector-uninstall-targets.nsh` を生成して `!include` | 生成物のレビューが別になり、electron-builder の include 解決とビルド順に依存が増える。 |
| **直書き＋整合テスト** | `.nsh` に定義を直書きし、`collector-uninstall.test.ts` が「`.nsh` の `MAGINALIA_COLLECTOR_HOST_KEY_*` の集合 == TS 表の writable target の subkey 集合 == addon（`.cc`）の表」を文字列抽出で検査 | 現行の WP-8 テストと同じ型。表が 2〜3 行なので重複のコストより読みやすさが勝る。 |

**直書き＋整合テストを推奨。** 同じテストで C++ 表（`windows_integration.cc` の target 表を
正規表現で抽出）も照合し、3 言語の一致を 1 箇所で保証する。

---

## 7. IPC / サービス / UI 契約の変更（WP-7a 改修）

### 7.1 intents とリクエスト

```ts
export const COLLECTOR_INTEGRATION_INTENTS = [
  "inspect", "setup", "repair", "remove",
  "openBrowserExtensions",     // was openChromeExtensions
  "openBrowserDownloadPage",   // new: replaces the Chrome download link
  "copyExtensionPath", "revealExtensionFolder", "checkConnection",
] as const;

export interface CollectorIntegrationRequest {
  readonly intent: CollectorIntegrationIntent;
  readonly confirmReplaceForeign?: boolean;            // setup / repair (unchanged)
  readonly proceedWithoutSupportedBrowser?: boolean;   // setup (was proceedWithoutChrome)
  /** setup / openBrowserExtensions / openBrowserDownloadPage. An enum value only. */
  readonly browser?: CollectorBrowserId;
}
```

- `isCollectorIntegrationRequest` は `browser` を `COLLECTOR_BROWSER_IDS` で検証し、許される
  intent 以外では拒否する。**renderer は列挙値しか送らない。URL・パス・コマンドラインは送らない**
  （現行の原則を維持）。
- `openBrowserDownloadPage` は `downloadUrl !== null` の行だけ受け付ける。

> 実装状況（S7、§9 参照）: `openBrowserDownloadPage` と、`browser` を `setup` / `openBrowserDownloadPage`
> で受けることは未実装（現状 `browser` は `openBrowserExtensions` のみ）。

### 7.2 サービスの振る舞い

- `setup`: `proceedWithoutSupportedBrowser !== true` なら、`verified` かつ `found` かつ非ブロックの
  行が 1 つも無いとき `browser-required` を返す（何も書かない）。`browser` があれば「最後に
  選んだブラウザー」として保存（§7.4）。
- `openBrowserExtensions`: 対象 = `request.browser` ?? 保存済みの選択 ?? `recommended`。
  `locateBrowserExecutable(id)` が `found` なら、検証済み exe を **行の固定
  `launchArguments`** で detached spawn（現行 `launchDetachedProcess` を流用）。成功したら
  その id を保存。`shell.openExternal` は `chrome:`/`edge:` 等のスキームには使わない
  （ハンドラーが無い・利用者が差し替え可能なため）。`microsoft-edge:` プロトコルも使わない。
> **spike 結果（2026-11-20、V-LAUNCH）— 上の `openBrowserExtensions` は修正が要る。**
> - 使い捨てプロファイル（`--user-data-dir` 付き）では、Chrome・Edge とも exe に
>   `chrome://extensions/` / `edge://extensions/` を渡すと拡張機能ページが開く。
> - **利用者の通常プロファイルでは、Chrome・Edge とも新しいウィンドウが開くだけで、拡張機能ページは
>   開かない**（Chrome は未起動、Edge は起動中で確認）。Vivaldi は通常プロファイル・起動中で、既存
>   ウィンドウに `vivaldi://extensions/` が開く。
> - したがって Chrome・Edge では「exe に URL を渡す」だけを成功の前提にしない。wizard は
>   ブラウザーを前面に出した上で、アドレスバーに入力するアドレス（`chrome://extensions` /
>   `edge://extensions`）を **文言で案内し、コピーボタンを置く**（アドレス文字列はブラウザー表の
>   定数。絶対パスではないので renderer へ渡してよい）。Vivaldi は従来どおり引数で開く。
> - 起動後に拡張機能ページが開いたかを Desktop は検知できない。完了判定は接続確認（§4.6）だけに置く。

- `openBrowserDownloadPage`: main の定数 `downloadUrl`（https）を `shell.openExternal` で開く
  （既定ブラウザーで開いてよい）。
- 依存の改名: `locateChrome` → `locateBrowser(id)`、`launchChrome` → `launchBrowser`。

> 実装状況（S7）: `openBrowserExtensions` の対象は現状 `request.browser` ?? `recommended`
> （保存済み選択の段は §7.4 と一体で未実装）。`setup` の選択の保存も未実装。

### 7.3 応答

> 実装状況（S7）: `browser-required`、`browser-extensions` と `status.browsers`
> （`preferred` を除く）は実装済み。`browser-download` と `preferred` は未実装。

```ts
| { readonly kind: "browser-required"; readonly status: CollectorIntegrationStatus }        // was chrome-required
| { readonly kind: "browser-extensions"; readonly browser: CollectorBrowserId | null; readonly result: "opened" | "browser-not-found" | "failed" } // was chrome-extensions
| { readonly kind: "browser-download"; readonly result: "opened" | "failed" | "not-offered" }
```

`CollectorIntegrationStatus` の `chrome` を置き換える:

```ts
readonly browsers: {
  readonly defaultBrowser: DefaultBrowserKind;
  readonly recommended: CollectorBrowserId | null;
  readonly recommendationReason: CollectorRecommendationReason;
  readonly preferred: CollectorBrowserId | null;   // remembered selection (7.4)
  readonly entries: readonly {
    readonly id: CollectorBrowserId;
    readonly verification: "verified" | "unverified";
    readonly installed: "found" | "not-found" | "unknown";
    readonly registration: "ours" | "foreign" | "absent" | "unknown";
    readonly registrationVia: CollectorRegistryTargetId | null;  // e.g. Edge using the Chrome key
    readonly policyBlocked: boolean;
    readonly extensionLoadMayBeBlocked: boolean;
  }[];
};
```

パス・exe の場所・ProgId 文字列は含めない（`defaultBrowser` は分類値のみ）。`policy` の集約は残す。

### 7.4 「最後に選んだブラウザー」の保存

- Desktop userData の通知状態ファイル（`CollectorNoticeState`）を v2 にし、`browser:
  CollectorBrowserId | null` を足す（v1 は `browser: null` として読む）。インストールの事実では
  なく UI の好みなので program folder の state file には入れない。
- 用途: 通知文言、`openBrowserExtensions` の既定、Step A の初期選択（おすすめより優先は
  しない。おすすめと違うときは「前回は {name} を選びました」と添えるだけ）。

### 7.5 コマンドと文言

| 現行 | 変更後 | 備考 |
| --- | --- | --- |
| `maginalia.collector.openChromeExtensions`「Chrome で拡張機能の画面を開く」 | `maginalia.collector.openBrowserExtensions`「ブラウザーで拡張機能の画面を開く」（保存済み選択があれば「{name} で拡張機能の画面を開く」をパレットの説明に） | RC 未リリースなので alias なしで改名を推奨（オーナー判断 Q3）。テスターにキー割り当てがあるなら alias を 1 版残す。 |
| `maginalia.collector.setup` の description「…for Google Chrome.」 | 「…for a supported browser (Edge, Chrome).」 | keywords に `edge`, `vivaldi`, `browser`, `ブラウザー` を追加。 |
| updated 通知 detail | 「{name} の拡張機能の画面で MAGINALIA Collector の［{reloadLabel}］を押すか、{name} を再起動すると反映されます。」（name 不明時は「ブラウザー」） | action label 「{name} で拡張機能の画面を開く」 |
| remove 確認 detail の「Chrome に保留中」「Chrome の拡張機能一覧」「Chrome の画面から」 | 「ブラウザーに保留中」「ブラウザーの拡張機能一覧」「そのブラウザーの画面から」 | main.ts `confirmCollectorRemoval` |
| `collectorResponseProblem` の `chrome-required` | `browser-required`: 「対応しているブラウザー（{一覧}）が見つからないため、Collector 連携を設定していません。」 | |
| 同 `chrome-extensions` 失敗 | 「{name} の拡張機能の画面を開けませんでした。{name} のアドレスバーに {displayUrl} と入力してください。」 | |

### 7.6 ウィザード各ステップのブラウザー依存（親設計 §4）

| Step | 依存 | 変更 |
| --- | --- | --- |
| A | 強い | §2.3（検出・おすすめ・選択）。 |
| B | 中 | 登録結果を target 別に、成否判定は選んだブラウザーの `effective`（§5.2）。policy ブロックの文言をブラウザー名入りに: 「組織の管理設定により、{name} はこの種類の連携プログラムを使えないようになっています。」。全ブロック時は現行文言。foreign ダイアログはブラウザー列挙（§3.3）。 |
| C | なし | 変更なし（保存先確認）。 |
| D | 強い | §2.4。policy 警告「組織の管理設定により、{name} で拡張機能を読み込めない可能性があります。」 |
| E | 弱い | ブラウザー名を断定しない文言（§2.4）。ID のチェックリストは共通。 |

### 7.7 不変条件の再確認

- renderer に絶対パスを渡さない: 変更なし（exe・program folder は main のみ。extension folder は
  現行どおりクリップボードと shell で main が扱う）。
- renderer から受け取るのは列挙値と boolean だけ。

---

## 8. Collector 拡張側への影響（C リポジトリ）

| 箇所 | 現状 [コード] | 必要な変更 |
| --- | --- | --- |
| `chrome.*` API（contextMenus, scripting, storage.session, tabs, runtime.sendNativeMessage, runtime.reload） | Chromium 共通 API。Edge は同じ API を文書で説明している [文書]。 | コード変更は不要の見込み。spike で Edge・Vivaldi の実動作を確認。 |
| service worker の sender 検査 `senderUrl.protocol === "chrome-extension:"` | Edge のアドレスバーは `extension://` と表示されるという記憶がある [推測]。内部の origin は `chrome-extension://` のはず（Host 第 1 引数がそうである [文書]）。 | **spike 項目 V-ORIGIN**: Edge・Vivaldi の拡張機能ページで `location.origin` と `chrome.runtime.getURL("")` を記録。`chrome-extension:` でなければ、比較を `new URL(chrome.runtime.getURL("")).protocol` との一致に変える（定数を使わない）。この修正は小さいので、どちらにせよ入れてよい。 |
| README L5 「Chrome / Chromium 系ブラウザ向け」 | | 「Microsoft Edge・Google Chrome（・Vivaldi）で動作を確認した Manifest V3 拡張機能。その他の Chromium 系は未検証」。 |
| README・popup.js・onboarding.html の「Chromeの拡張機能の画面で［更新］（↻）」 | | 「ブラウザーの拡張機能の画面で MAGINALIA Collector の再読み込み（↻）」。拡張機能側はどのブラウザーかを `navigator.userAgentData.brands` で推定できるが [推測]、文言の分岐はしない（生成コストに見合わない）。 |
| `docs/install-guide-ja.md`「Chrome 以外（Edgeなど）は対象外」 | | 3 ブラウザー版に改訂（主経路は「MAGINALIA Desktop をインストール」、親設計 WP-1c）。ブラウザー別の手順 4〜5 とスクリーンショット（spike で撮影）。 |
| manifest `description` | ブラウザー名なし | 変更不要。 |
| ストア | 未公開 | 将来: Chrome Web Store と Edge Add-ons で ID が分かれる [文書] → Desktop の `COLLECTOR_ALLOWED_ORIGINS` に追加（親設計 §7 に追記）。Vivaldi は Chrome Web Store を使う [推測]。 |
| storage | プロファイルごと | 2 ブラウザーに入れると Outbox が 2 つ。install guide に注意を書く（§2.4 の注記と同文）。 |

---

## 9. 実装スライス計画

各スライスは implementer 1 回分。`D` = Desktop、`C` = Collector、`I` = IDE（書き戻し）、
`O` = オーナー立ち会い／computer-use。

| ID | Repo | 依存 | 内容 | 受け入れ条件・テスト | 改修する既存 WP |
| --- | --- | --- | --- | --- | --- |
| **S0** | O | — | spike Phase 1（§10）: Edge と Chrome の確認、Vivaldi の探索順、UI ラベル撮影、既定ブラウザー値。 | §10.6 の記録が埋まる。PASS/FAIL/NOT VERIFIED。 | WP-2 の延長 |
| **S1** | D | — | `collector-browser-table.ts`（純粋データ、§1.2〜1.4。Vivaldi は `unverified`）、`classifyDefaultBrowser` の表駆動化、`recommendCollectorBrowser`、`effectiveRegistration(lookupOrder, ownerships)` の純粋関数。配線はしない。 | 表の型・freeze・`verified` 行に `unverified` evidence が無いこと、ProgId 分類（`VivaldiHTM`, `MSEdgeHTM`, `ChromeHTML.X`, `MSEdgeBHTML`, `FirefoxURL-…`）、おすすめの全 `reason`、Edge の fallback 計算。import が無いことの source-scan。 | WP-5a（一部） |
| **S2** | D | S1 | addon apiVersion 2（§3.2、target 表 `chrome`/`edge` writable、`chromium` read-only）、wrapper、adapter（`readCollectorHostRegistration(target)` 等、`readBrowserPolicies(root)`、`readBrowserAppPaths(appPathsName)`、`readDefaultBrowserProgId()` を `UserChoiceLatest\ProgId` サブキー → `UserChoice` 値に、`readProgIdOpenCommand(progId)`）、fake adapter の target 化、TS↔C++ 整合テスト。 | 書込み関数は列挙外・read-only target を `invalid-argument`。product addon に test seam が無い（既存 test）。test seam target で register/inspect/unregister の値一致（現行 native test を target 別に）。CRT import 検査は現行どおり。 | WP-3 |
| **S3** | D | S2 | `inspect` 改修（§4）: target 別所有、`E` の計算、集約規則、ブラウザー別検出（`locateBrowserExecutable`、§1.5 の優先規則）、行別 policy、state file v2 parse（v1 互換）、新 reason。`CollectorIntegrationInspection` の型変更。 | 7 状態すべてに到達する表駆動テストを target 別に拡張。§4.4 の 1〜6 の各分岐、v1 state + Chrome のみ → `outdated(registration-target-added)`、`registeredTargets` 内の absent → `registration-missing`、Edge の fallback 表示、Vivaldi 両 install で ProgId command が候補と一致するときその候補、一致しないとき HKCU App Paths。no env/cwd/argv の source-scan 維持。 | WP-5a |
| **S4** | D | S3 | apply 改修（§5）: step 8/9、registration-only refresh、remove の target 別、guard snapshot、`targets` 結果、新 reason `expected-targets-changed`、state v2 書込み。フォールト注入の拡張（§5.7）。 | §5.7 のシナリオ 1〜9 が PASS。既存 apply テストが型変更以外で無変更に通る。 | WP-5b |
| **S5** | D | S2, S4 | NSIS（§6）: Edge キーの値一致削除、state v1/v2 検証、3 言語整合テスト。 | `collector-uninstall.test.ts` に Edge ブロック・v2 受理・不正 v2（未知 id、重複、7 フィールド）拒否・整合テスト。`isUpdated`/`CurrentUser` ガードの既存検査を維持。 | WP-8 |
| **S6** | D | S4 | WP-5c: updated 通知を `payloadId` 変化時のみ、通知文言のブラウザー名化、通知状態 v2（`browser`）、（Q9 承認なら）`removeRequested` の先行記録。 | 既存 startup-refresh テスト＋registration-only refresh で updated 通知が出ないこと、v1→v2 読み込み、文言の snapshot。 | WP-5c |
| **S7** | D | S3, S6 | WP-7a: IPC（§7.1〜7.3）、service（§7.2）、renderer commands と文言（§7.5）、preload 型、main の依存改名、確認ダイアログ文言。 | ipc guard テスト（`browser` の検証、不正 intent 組合せ）、service テスト（`browser-required`、選択の保存、固定引数で spawn・URL を renderer から受けない、download URL は定数のみ）、command-coverage 更新、応答にパスが無いことのテスト維持。 | WP-7a |
| **S8** | D | S7, S0（ラベル） | WP-7 slice B（ウィザード panel）を本書 §2.3/§2.4/§7.6 に沿って実装（slice B 未着手なら最初からこの形で）。 | 親設計 WP-7 の受け入れ＋全 `reason` の文言、ラジオの keyboard 操作、`role="radiogroup"`、ブラウザー名の差し込み。 | WP-7（slice B） |
| **S9** | C | S0 | Collector の文言（§8）、sender 検査の一般化、install guide 3 ブラウザー版（スクリーンショットは S0/S11）。 | 既存 C テスト＋origin 比較の単体テスト。 | WP-1a/1c |
| **S10** | D (+C) | S0 Phase 2 | Vivaldi 有効化: 行の確定（§3.4 の 3 通りのどれか）、必要なら addon・NSIS に `vivaldi` target 追加、`ui.*` 確定、`verified` へ。全行の `ui.*` evidence を `measured` に。 | 表の release gate テストが通る。S2/S5 の整合テストが新 target を含めて通る。 | WP-3/5a/8 |
| **S11** | D+O | S1〜S10 | E2E（親設計 §9.1 を 3 ブラウザーへ）: 各ブラウザーで setup→読み込み→接続確認→Desktop 停止中の保存、RC3 からの更新で Edge キー自動追加、remove、uninstall。 | PASS/FAIL/NOT VERIFIED を記録。モックで代替しない。 | WP-9 |
| **S12** | I | S11 | plan 30・α profile・親設計への書き戻し（§12）。 | 実際の結果だけを DONE にする。 | WP-0/WP-10 |

**S3〜S6 の実装状況（write-back。実装は各ブランチ。実ブラウザーでの確認はスパイク前なので UNVERIFIED）:**

- S3 `codex/mb-s3-inspect` 1c3171a、S4 `codex/mb-s4-apply` 0eda4e1、S5 `codex/mb-s5-nsis` ce75ffe、
  S6 `codex/mb-s6-notices` df3c66a（積み上げ式）。
- S3/S4 で確定: `registeredTargets` は試行した `E`（§4.3。M2: S10 前に attempted と confirmed を分ける）、
  foreign の Chromium フォールバックキーがあるときの `foreign-registration` 分岐（§4.4、判断 d）、
  policy-blocked 時の `E_all` 集計（§4.2）。
- S5: NSIS は Chrome・Edge の値一致解除、state v1/v2 受理（§6.1）。
- S6 完了分: updated 通知は `payloadId` 変化時のみ（§4.6）。**未実装分**（通知文言のブラウザー名化、
  通知状態 v2 `browser` と v1→v2 読み込み、Q9 の `removeRequested` 先行記録）は S7 と連動する後続。
- Edge 行は `unverified` のまま（スパイク待ち）。Vivaldi の結論もスパイク待ち。
- 既知の未解決: §5.5（read-only target の ours は消さず警告も無い）、§5.6（検出由来の `E` 変化の再確認なし）。

**S7 の実装状況（write-back。`codex/mb-s7-service` e3a5115、S6 df3c66a の上。単体テストのみで、
実ブラウザー・Electron での確認は NOT VERIFIED）:**

- 削除した旧 API と移行先（別名・互換 shim は残していない。コマンド改名は Q3 のとおり alias なし）:

  | 旧 | 新 |
  | --- | --- |
  | `inspection.chrome`（`ChromeDetection`）と `ChromeSource`/`ChromeLocation`/`ChromeRejectedCandidate` の deprecated 別名 | `inspection.browsers`、`BrowserExecutableSource`/`BrowserLocation`/`BrowserRejectedCandidate` |
  | `locateChromeExecutable` / runtime `locateChrome` / service 依存 `locateChrome` | `locateBrowserExecutable(id, …)` / `locateBrowser(id)` |
  | service 依存 `launchChrome`、定数 `COLLECTOR_CHROME_EXTENSIONS_ARGUMENTS` | `launchBrowser`、表の行の `extensionsPage.launchArguments` |
  | intent `openChromeExtensions`、コマンド `maginalia.collector.openChromeExtensions` | `openBrowserExtensions`、`maginalia.collector.openBrowserExtensions` |
  | request `proceedWithoutChrome` | `proceedWithoutSupportedBrowser` |
  | 応答 `chrome-required` | `browser-required` |
  | 応答 `chrome-extensions`（`chrome-not-found`） | `browser-extensions`（`browser: id \| null`、結果 `browser-not-found`） |
  | `status.chrome` | `status.browsers { defaultBrowser, recommended, recommendationReason, entries[] }`（パス・source・ProgId なし。entry は §7.3 から `preferred` を除いた形） |

- request の `browser` は `openBrowserExtensions` のときだけ受け付ける（enum 検証）。preload は
  検証済みフィールドだけをコピーして渡す。
- `setup` の `browser-required` 判定は §7.2 どおり（`verified` かつ `found` かつ非ブロックの行が
  無いとき）。renderer 文言の一覧は verified 行を表順に並べる（現状は Chrome のみ）。
- remove 確認ダイアログ（main.ts）と `maginalia.collector.openBrowserExtensions` のタイトル・説明・
  keywords、`maginalia.collector.setup` の keywords（`browser`、`ブラウザー` を追加）は §7.5 に更新済み。
- `openBrowserExtensions` の対象決定は現状 `request.browser` → `recommended` の 2 段。**§7.2 の
  「保存済み選択」の段は未実装**（最後に選んだブラウザーの保存・通知状態 v2 `browser`・成功時の保存・
  `status.browsers.preferred` と一体で、S6 の未実装分と同じ後続）。`setup` の `browser` 受理と選択の保存も同様に後続。
- **未実装**: intent `openBrowserDownloadPage` と応答 `browser-download`（§7.1/7.3。S8 と一緒）。
  updated 通知の文言（「Chrome で拡張機能の画面を開く」固定。§7.5）。`maginalia.collector.setup` の
  description は Edge が `unverified` の間「for a supported browser.」で、Edge が `verified` に
  なったら §7.5 の「(Edge, Chrome)」へ追従する。
- Edge を `verified` にするときは、`browser-required` の一覧文言（`supportedBrowserNames`）の
  テストを更新する必要がある。

順序の提案: **S0 と S1 を並行** → S2 → S3 → S4 → S5 と S6（並行可）→ S7 → S8・S9（並行）→
S10 → S11 → S12。Chrome+Edge は Edge が文書で裏付けられているので S0 を待たずに S2〜S7 を
進められる。Vivaldi に関わるのは S10 だけ。

ブランチ: WP-7a（`codex/wp7a-main-wiring`）は RC3 の上にあり未 merge。S7 が WP-7a を改修するので、
**先に WP-7a を RC3 に merge してから** 本スライス群を RC3 の上に積むことを推奨する
（または S1〜S6 を RC3 上で進め、S7 だけ WP-7a の上で行う）。どちらにするかはオーナー判断 Q10。

---

## 10. spike 手順書

### 10.1 目的

本書の [未検証] を、実ブラウザーの観察で確定する。結果は本書の末尾に「Spike evidence」節として
追記し、ブラウザー表の `evidence` を更新する。

### 10.2 安全上の注意（必ず守る）

- **製品の Host 名 `org.maginalia.collector` と、その名前を含む既存キー（`org.maginalia.collector*` の残骸）
  には一切触れない。** spike 専用の Host 名を使う:
  `org.maginalia.spikemb.chrome`、`org.maginalia.spikemb.edge`、`org.maginalia.spikemb.vivaldi`、
  `org.maginalia.spikemb.chromium`、`org.maginalia.spikemb.probe`（Native Messaging の名前規則:
  小文字英数字・`_`・`.`、先頭末尾にドットなし [文書]）。
- 書くのは HKCU のみ。HKLM の実験（V-HKLM）は使い捨て Windows ユーザーまたは VM で、
  オーナーの同意を得た場合だけ。
- 開始前に、触るキーの存在を `reg query` で記録し、作ったキーは終了時に `reg delete` で
  **名前を指定して** 1 本ずつ消す（`/f` で親を消さない）。親キー（`Software\Vivaldi\NativeMessagingHosts` 等）は
  元から無かった場合だけ消す。開始前の有無を記録しておく。
- ブラウザーは spike 用の使い捨てプロファイルで起動する:
  `"<exe>" --user-data-dir="<spike>\profile-<browser>" --no-first-run`。オーナーの普段の
  プロファイル・拡張機能・Outbox に触れない。Native Messaging の登録はユーザー単位なので
  使い捨てプロファイルでも同じキーが効く [推測。V-PROFILE で確認]。
- 拡張機能は spike 専用のプローブ拡張（下記）を使う。実 Collector は V-ID / V-ORIGIN の確認で
  読み込むだけで、本棚への保存は行わない。
- 実データ（本棚、binding、`%LOCALAPPDATA%\MAGINALIA`）には書かない。spike フォルダーは
  `%USERPROFILE%\maginalia-spike-mb\`（日本語を含むパスの検証用に `…\日本語フォルダー\` も作る）。
- 記録・スクリーンショットにユーザー名入りの絶対パスが写る場合は、PR やチャットに貼る前に
  `%USERPROFILE%` などのプレースホルダーに置き換える（親設計 §8.6）。

### 10.3 用意するもの（spike フォルダー内、使い捨て）

1. **プローブ拡張** `probe-ext\`: MV3、`permissions: ["nativeMessaging"]`、spike 用に新しく
   生成した `key`（製品の key は使わない）。popup に Host 名を選ぶボタン 5 つ
   （`org.maginalia.spikemb.*`）。押すと `chrome.runtime.sendNativeMessage(name, {ping: 1})` の
   応答か `chrome.runtime.lastError.message` を画面に表示する。`location.origin` と
   `chrome.runtime.getURL("")` と `chrome.runtime.id` も表示する。
2. **echo Host** を 4 つ: 受け取ったら `{"from": "<label>", "argv": [...]}` を Native Messaging 形式
   （4 バイト長＋JSON）で返し、`argv` を `<spike>\log-<label>.txt` に追記する。label は
   `chrome-key`、`edge-key`、`vivaldi-key`、`chromium-key`。開発機の Node で書いてよい
   （spike 専用。製品は SEA）。Windows で `.bat`/`.cmd` 経由の起動でもよい。
3. **manifest** を label ごとに 1 つ（`name` は対応する Host 名、`path` は相対
   `hosts\echo-<label>.cmd`、`allowed_origins` はプローブ拡張の ID）。
4. 記録用の表（§10.6）。

### 10.4 実験

各実験の前に「どのキーに何を書いたか」を記録し、プローブ拡張のボタンを押して結果を記録する。
ブラウザーはキー変更のたびに再起動する（Host の探索結果のキャッシュの影響を避けるため。
キャッシュの有無自体は観察しない）。

**V-KEY（キー別の切り分け）:** 同じ Host 名 `org.maginalia.spikemb.probe` を次のキーの組合せで
登録し、それぞれ別の echo Host（label）を指す manifest を値にする。`from` で、どのキーが
使われたかが分かる。

| # | Chrome キー | Edge キー | Chromium キー | Vivaldi キー | 観察（Chrome / Edge / Vivaldi で各 1 回） |
| --- | --- | --- | --- | --- | --- |
| K1 | あり | — | — | — | どのブラウザーが接続できるか、`from` |
| K2 | — | あり | — | — | 同上 |
| K3 | — | — | あり | — | 同上 |
| K4 | — | — | — | あり | 同上 |
| K5 | あり | あり | — | — | `from` で優先を確認（Edge は edge-key のはず [文書]） |
| K6 | あり | — | — | あり | Vivaldi の優先 |
| K7 | あり | — | あり | — | Edge の fallback 順（chromium-key のはず [文書]） |
| K8 | すべて | すべて | すべて | すべて | 各ブラウザーが選ぶキー |

→ ブラウザー表の `lookupOrder` を確定。Vivaldi の結果で §3.4 の 3 通りのどれかを決める。
エラー時は `lastError.message` の文言をそのまま記録（「Specified native messaging host not found.」等）。

**V-REL（相対パス）:** manifest の `path` を `hosts\echo-<label>.cmd`（サブフォルダー付き相対）、
`echo-<label>.cmd`（同階層）、絶対パス（日本語フォルダー配下）の 3 通りで、3 ブラウザーとも接続
できるか。→ 親設計 `COLLECTOR_MANIFEST_PATH_FORM` の確定（Chrome は WP-2 の残項目）。

**V-HKLM（任意、使い捨てユーザーのみ）:** 同名を HKCU と HKLM に別 label で登録し、各ブラウザーが
どちらを使うか。→ 親設計 §8.4 の「HKLM の同名登録の扱い」。

**V-ORIGIN / V-ID:** プローブ拡張と実 Collector（`codex/collector-host-info` の 0.3.0 配布フォルダー）
を各ブラウザーに「展開して読み込み」し、(a) 拡張機能ページに表示される ID、(b) プローブの
`location.origin`・`chrome.runtime.getURL("")`、(c) echo Host のログの第 1 引数、を記録。
実 Collector の ID が 3 ブラウザーで `blgmoddncpknfnikdfnjelmdmphfgknf` か。実 Collector の
popup を開き、「MAGINALIAとの接続」は押さない（製品 Host 名に接続しにいくため）。

**V-LAUNCH:** ブラウザー未起動／起動中のそれぞれで、
`"<exe>" chrome://extensions/`、`"<exe>" edge://extensions/`、`"<exe>" vivaldi://extensions/` が
拡張機能ページを開くか（Vivaldi は `chrome://extensions/` も試す）。起動中のときどのウィンドウ・
プロファイルに開くか。使い捨てプロファイルを使う都合で、この実験だけは `--user-data-dir` を付けた
場合と付けない場合の両方を試す（付けない場合はオーナーの普段のプロファイルに開くので、
ページを開くだけで操作はしない）。

**V-DEFAULT:** `reg query` で `UrlAssociations\https\UserChoiceLatest` と `...\UserChoice` の
`ProgId`、`HKCU\Software\Classes\<ProgId>\shell\open\command` と HKLM 側を記録（読み取りのみ）。
テスト機の Vivaldi の open command がユーザー単位とPC全体のどちらの `vivaldi.exe` を指すか。
Edge・Chrome の stable の ProgId は、オーナーが既定を切り替えて試すかどうかを決める
（既定の変更は利用者の設定変更なので、するならオーナー自身が Windows の設定で行う）。

**V-POLICY:** `reg query` で `HKLM\SOFTWARE\Policies\Vivaldi`、`...\Policies\Google\Chrome`、
`...\Policies\Microsoft\Edge` の有無だけを記録（読み取りのみ）。Vivaldi が policy を読むかの
実験は使い捨て VM でのみ（任意）。

**V-SWAP / V-DROP / V-RELOAD（Edge と Vivaldi で。Chrome は親設計 WP-2）:**
読み込み済みの unpacked フォルダーを、ブラウザー起動中に「`extension.next` → rename で入れ替え」
の手順で差し替え、拡張機能ページの［再読み込み］と `chrome.runtime.reload()`（プローブの
ボタンで呼ぶ）で新しい版が読まれるか。フォルダーのドラッグで読み込めるか（デベロッパー モード
オン時）。

**V-PROFILE:** 使い捨てプロファイル A・B で同じプローブを読み込み、どちらからも同じ Host に
接続できるか（登録がユーザー単位であることの確認）。

**V-UI（スクリーンショット、日本語 UI）:** 各ブラウザーで次を撮る。撮る位置:
1. 拡張機能ページ全体（デベロッパー モード **オフ**）: トグルの位置とラベル。
2. 同ページ（**オン**）: 「パッケージ化されていない拡張機能を読み込む」相当のボタン。
3. フォルダー選択ダイアログ（「フォルダー:」欄）。
4. 読み込み後のカード: 名前・ID・再読み込みボタン（ツールチップも）。
5. ブラウザー再起動時のデベロッパー モード関連の警告（出れば）とその文言。
6. manifest の無いフォルダーを選んだときのエラー表示。
7. デベロッパー モードをオフにしたときの unpacked 拡張機能の扱い（無効化されるか）。
ファイル名は `vui-<browser>-<番号>.png`。文言はスクリーンショットから書き起こして
ブラウザー表 `ui.*` に入れる。

### 10.5 フェーズ

- **Phase 1（S0、Chrome+Edge の実装と並行）:** V-KEY（K1, K2, K5, K7）、V-REL、V-ORIGIN/V-ID
  （Chrome・Edge）、V-LAUNCH（Chrome・Edge）、V-DEFAULT、V-UI（Chrome・Edge）。
- **Phase 2（S10 の前提）:** V-KEY の Vivaldi 列すべて、V-ORIGIN/V-ID・V-LAUNCH・V-SWAP/DROP/RELOAD・
  V-UI（Vivaldi）、V-PROFILE。
- 任意: V-HKLM、V-POLICY の実験部分（使い捨て VM）。

### 10.6 記録フォーマット

本書末尾に追記する。1 実験 1 行。

```markdown
### Spike evidence (YYYY-MM-DD, operator: owner | computer-use)

Environment: Windows build ..., Chrome x.y, Edge x.y, Vivaldi x.y; profile: disposable (--user-data-dir);
keys present before start: (list, values redacted to placeholders)

| ID | Browser (version) | Setup (keys / manifest path form / args) | Expected | Observed (from=..., lastError=..., ID, origin) | Screenshot | Result |
| --- | --- | --- | --- | --- | --- | --- |
| K1-edge | Edge 157.x | chrome-key only, relative subdir path | from=chrome-key (vendor doc fallback) | from=chrome-key | — | PASS |
| ... | | | | | | PASS / FAIL / NOT VERIFIED |

Cleanup: keys deleted (list), parents removed only where absent before (list), profiles deleted.
Table fields updated: (browser.field: old -> new, evidence -> measured)
```

判定は PASS / FAIL / NOT VERIFIED のみ。観察できなかったものは NOT VERIFIED。

---

## 11. 脅威モデルの追加分と未解決事項

### 11.1 追加の脅威と対策

| 脅威 | 対策 | 残る制限 |
| --- | --- | --- |
| **ブラウザー表の改ざん** | 表は main bundle の compile-time 定数で、実行時の設定ファイルは無い。書込み先キーの正本は addon の C++ 表で、TS 表を変えても書込み先は変わらない。3 言語の整合は unit test。 | 同じユーザーの権限で asar・addon を書き換えられるのは親設計 §8.2 と同じ（範囲外として明記）。 |
| **別ブラウザーへの登録の混同** | target ごとに独立した値一致判定。全 target が同じ manifest パスを値に持つ（J）。read-only target（Chromium）は書かない。remove・uninstall は target ごとの値一致。foreign は上書きせず、置換は利用者の確認後、確認時の snapshot と一致する target だけ。 | Edge は Edge キーが無いと Chromium/Chrome キーを使う [文書]。MAGINALIA が Edge キーを持つことで、他者の Chromium キーが Edge に割り込む余地を閉じる。他者が Edge キーに同名を書いた場合は foreign として検出・報告する。 |
| **PATH / exe の乗っ取り** | PATH を探さない。`start`・プロトコルハンドラー（`microsoft-edge:` 等）・`shell.openExternal` でブラウザーを起動しない。候補は App Paths と known folders だけで、basename を行ごとに固定、全要素の reparse 検査、通常ファイル。ProgId の open command は候補の選択にしか使わず、直接起動しない。ProgId は文字種検査してから subkey に使う。起動引数は行の固定配列。 | HKCU の App Paths・ProgId・known folder 配下は同じユーザーが書き換えられる（§8.2 と同じ）。 |
| **複数インストール** | §1.5 の決定的な優先規則。登録はユーザー単位の HKCU なので、どの install にも同じく効く。 | ポータブル版（standalone）はレジストリに出ないので検出しない。登録が効くかは [未検証]。 |
| **他社の名前空間への書込み** | Vivaldi は `when-present` かつ `verified` のときだけ（推奨）。消すのは葉のキーだけ。 | 親キーは残る（他社のキーなので消さない）。 |
| **ストア ID の分岐** | `allowed_origins` は完全一致の列挙（wildcard 不可 [文書]）。ストア公開時に ID を追加するのは別の product decision。 | — |
| **policy の読み違い** | Edge は `Microsoft\Edge`、Chrome は `Google\Chrome` を別々に評価。わからないブラウザーは `unavailable` で、policy では止めない（親設計 §8.4「ブラウザーが最終判断」）。 | Vivaldi の policy は未確認。 |

### 11.2 オーナー判断が要る点

| # | 問い | 推奨 |
| --- | --- | --- |
| Q1 | Vivaldi が独自キーを読む場合、登録は「Vivaldi が入っているときだけ」(`when-present`) か「常に」か。 | `when-present`（他社名前空間を作らない）。 |
| Q2 | 新しい版で登録先が増えたとき（RC3→本件、Vivaldi を後から入れたとき）、自動 refresh で黙って追加登録してよいか。 | はい（利用者は連携を有効にしている。foreign は書かない。消された登録は repair 通知のまま）。 |
| Q3 | コマンド `maginalia.collector.openChromeExtensions` を alias なしで `openBrowserExtensions` に改名してよいか。 | はい（未リリース）。テスターに配布済みなら 1 版 alias。 |
| Q4 | 「最後に選んだブラウザー」を Desktop userData に保存してよいか。 | はい（UI の好み。パスなし）。 |
| Q5 | foreign のブラウザーがあるとき「全部切り替える／やめる」だけにするか、ブラウザー単位で残せるようにするか。 | 全部切り替える／やめる（稀なケースで UI を増やさない）。 |
| Q6 | 一部のブラウザーだけ policy でブロックされているとき、他のブラウザーで設定を続けてよいか。 | はい（全部ブロックのときだけ `policy-blocked`）。 |
| Q7 | D023 の α2 例外（親設計 Q2）を Chrome だけでなく Edge・Vivaldi の開発者モードにも適用するか。 | はい（同じ理由）。Decision Log の文言を「対応ブラウザーの開発者モード」に。 |
| Q8 | Edge の配布 URL・Chrome の配布 URL を Desktop に定数で持ち、「ダウンロードページを開く」ボタンを出してよいか。 | はい（https 定数、既定ブラウザーで開く）。 |
| Q9 | remove の開始前に `removeRequested` を記録する（既存の穴の修正）を本件に含めるか。 | 含める（S6、小さい）。 |
| Q10 | WP-7a を先に RC3 へ merge してから本件を積むか。 | はい。 |
| Q11 | spike をオーナーのメインアカウントで行うか、使い捨て Windows ユーザーで行うか。 | Phase 1・2 はメインアカウント＋使い捨てプロファイル＋spike 専用 Host 名で可（HKCU の spike キーだけを作って消す）。V-HKLM は使い捨てユーザーのみ。 |

### 11.3 未解決の技術的な問い（spike で確定）

一覧は §12.3 の最後にまとめる。

---

## 12. 計画への write-back 案

IDE リポジトリは本作業では編集しない。以下は S12 で適用する差し替え文案。DONE は付けない。

### 12.1 `plan/30_MAGINALIA_COLLECTOR_REQUIREMENTS.md`

- **L16（対象）:**
  > - **対象:** Microsoft Edge・Google Chrome・Vivaldi（Windows、stable）用 Manifest V3 拡張機能 `MAGINALIA Collector`。その他の Chromium 系（Chromium 単体、Brave、Opera 等）は未検証で正式対応外。対応表への追加は §5.5 の検証を経る。

- **L194（§5.2 対応ブラウザー検出）:**
  > - 対応ブラウザーを検出し、既定のブラウザーが対応ブラウザー（検証済みの行）かを判定する。既定が対応ブラウザーならそれを勧める。既定が Chromium 系でない、または未検証のときは Microsoft Edge を勧め、インストール済みの他の対応ブラウザーも選べるようにする。非対応ブラウザーへは黙ってファイルを投入しない。

- **L195（§5.2 拡張機能画面）:**
  > - 選ばれた対応ブラウザーの拡張機能管理画面を開き、所定の拡張機能フォルダを利用者に示す。**ブラウザーが求める操作は利用者が行う**。

- **L196 に追記:**
  > Native Messaging Host は Desktop がユーザー単位（HKCU）で Chrome と Edge の両方のキーに登録する（Product Owner 2026-11-17）。Vivaldi の登録先は実機検証で確定してから対応表に記録する。設計: Desktop `docs/collector-multi-browser-design.md`。

- **§5.3 見出し:** 「インストール操作フローシート（α〜α2、Chrome を例に）」→「（α〜α2、対応ブラウザーごと）」。本文の `chrome://extensions` は「各ブラウザーの拡張機能画面（`edge://extensions`、`chrome://extensions` 等）」に。

- **L201:** 「OS/Chrome の制約」→「OS/ブラウザーの制約」、「一般ユーザーの Chrome への」→「一般ユーザーのブラウザーへの」。

- **L259（§5.5 ブラウザ範囲）:**
  > 正式対応は Microsoft Edge・Google Chrome・Vivaldi（Product Owner 2026-11-17）。各ブラウザーは、Native Messaging の登録先・拡張機能 ID・unpacked 読み込み・UI 表記を実機で検証してから対応表で「検証済み」とし、それまでは勧めない・登録しない。ほかの Chromium 系は同じ検証を経て対応表へ加える。Firefox 等を「既定ブラウザだから」という理由だけで Chromium 用パッケージの対応対象にしない。

- **L281（受入 14）:** 「利用者による Chrome の明示的操作後」→「利用者による対応ブラウザーでの明示的操作後」。
- **L282（受入 15）:** 文言は維持し、末尾に「既定ブラウザーが非対応・未検証のときに Edge 等を勧める分岐を含む」を追加。
- **L283（受入 16）:** 「Chrome を初めて扱う利用者が」→「対応ブラウザーを初めて扱う利用者が」。
- **L294（エビデンス）:** 「Chrome 実体で」→「各対応ブラウザーの実体で」。L296 の「Chrome Web Store に依存しない新規プロファイルへ手動導入」は「各対応ブラウザーの新規プロファイルへ」に。
- **L313（§8 item 1）:**
  > 1. **extension identity と対象 browser:** 対象 browser は Edge・Chrome・Vivaldi に決定（Product Owner 2026-11-17）。固定 ID（manifest `key`）は維持し、各ブラウザーで同一 ID になることを実機で確認する。Vivaldi の Native Messaging 登録先、ストア公開時の ID（Chrome Web Store / Edge Add-ons）と allowed origin、permission 追加時期は未決定または未検証。
- **§9 参照:** Microsoft Edge の Native messaging と `NativeMessagingUserLevelHosts` policy の文書リンクを追加。
- **§2.1 L40:** 「Chrome のコンテキストメニュー」→「ブラウザーのコンテキストメニュー」。§4 見出し「Chrome 拡張機能としての制約」→「Chromium 系拡張機能としての制約」。

### 12.2 親設計 `collector-wizard-integration-design.md` への追記点

| 節 | 追記・変更 |
| --- | --- |
| 冒頭 / §1 Non-goals | 「Browsers other than Google Chrome」を削除し「Chromium 系のうち未検証のもの、Beta/Dev/Canary チャンネル」に。本書へのリンク。 |
| §2.4 | Edge キー（と将来の Vivaldi キー）の値一致削除、state v2。 |
| §3.3 | constants 表の Registry key を target 表に。addon の 4 関数を「列挙引数 1 つ、compile-time 表」に。`listCollectorHostTargets`。 |
| §3.4 | manifest は 1 つのまま、全 target が同じパスを値に持つ（J）。 |
| §3.5 | 状態は同じ 7 つ、登録の読み替え（本書 §4.4）、state v2、apply step 8/9、registration-only refresh、remove の target 別順序。 |
| §4.1〜4.6 | Step A/B/D/E の差し替え（本書 §2.3、§2.4、§7.6）。IPC intents の改名。 |
| §5 | コマンド `openBrowserExtensions`、文言のブラウザー名化。 |
| §6 | updated 通知は payloadId 変化時のみ。通知文言。 |
| §7 | ストア ID は Chrome Web Store と Edge Add-ons で分かれ得る、両方を `allowed_origins` に。 |
| §8.1/8.4 | trust boundary 2 を「固定 target 表のキー」に。policy は行別（`Google\Chrome`、`Microsoft\Edge`、Vivaldi は未確認で止めない）。Edge の fallback 探索（本書 §3.5、§11.1）。 |
| §9 / §9.1 | 本書の S0〜S12。E2E を 3 ブラウザーへ。 |
| §10 | 本書 Q1〜Q11 を追加。 |

### 12.3 spike で確定すべき未検証項目（一覧）

> **2026-11-20 の spike 結果（詳細は [spike results](collector-multi-browser-spike-results.md)）:**
> 1 = Vivaldi は独自キーを読まず Chromium → Chrome の順（§3.4）。3 = Edge は実測で一致（§3.5）。
> 4 = Chrome・Edge で解決（Vivaldi 未実施）。5 = probe では同一、実 Collector は Chrome のみ。
> 6 = `chrome-extension://`（3 ブラウザー）。7 = 使い捨てプロファイルでは開くが、**通常プロファイルの
> Chrome・Edge では開かない**（§7.2）。8 = Edge `MSEdgeHTM`、Vivaldi（個人用）`VivaldiHTM.<hash>`、
> `UserChoiceLatest\ProgId` が正で `UserChoice` は古い値が残る。**Chrome の ProgId は未実測**。
> 9 = PC 全体版が既定の open command の指し先だった（その後、旧い PC 全体版はアンインストール済み）。
> 10 = Chrome・Edge は §1 の UI 実測（Edge は起動時に 「開発者モードをオフにしますか？」→
> 「今は実行しない」）、Vivaldi は Chrome と同じ。11 = Vivaldi で OK（`runtime.reload()` 後に popup が
> 固まった観察が 1 回あり、再現未確認）。Edge は未実施。13 = Vivaldi のプロファイル A/B で同じ登録に
> 接続できた。2・12・14 は未実施。

1. Vivaldi の Native Messaging 探索順（自キー・Chrome キー・Chromium キーのどれを、どの順で読むか）。
2. Chrome の HKCU と HKLM の優先（親設計 WP-2 の残り）。
3. Edge が文書どおり Edge → Chromium → Chrome の順で、最初の 1 つだけを読むこと（実機確認）。
4. manifest の相対 `path`（サブフォルダー付き）が 3 ブラウザーで効くか。
5. 固定 `key` の拡張機能 ID が 3 ブラウザーで同一か。
6. Edge・Vivaldi の拡張機能ページの origin が `chrome-extension://` か（Collector の sender 検査に影響）。Host 第 1 引数の形式。
7. 各ブラウザーで exe に `<scheme>://extensions/` を渡して拡張機能ページが開くか（Vivaldi の scheme）。
8. stable の ProgId（Edge `MSEdgeHTM`、Chrome のユーザー単位 suffix、Vivaldi の suffix）と、`UserChoiceLatest` の有無・値。
9. テスト機の Vivaldi（両 install）で既定の open command がどちらの exe を指すか。
10. 各ブラウザーの日本語 UI ラベル（デベロッパー／開発者モード、読み込みボタン、再読み込み）とトグルの位置、起動時の警告文。
11. Edge・Vivaldi での unpacked フォルダー入れ替え後の再読み込み、`runtime.reload()`、ドラッグ読み込み。
12. Edge の他の policy 名（`NativeMessagingBlocklist`/`Allowlist`、`DeveloperToolsAvailability`、`ExtensionInstallBlocklist`/`Allowlist`）が Chrome と同名・同型か（文書確認）。Vivaldi の policy root。
13. 登録がユーザー単位でプロファイルに依存しないこと（使い捨てプロファイル間）。
14. Edge・Chrome の配布ページ URL（`downloadUrl`）。
