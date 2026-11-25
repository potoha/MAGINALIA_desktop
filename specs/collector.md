# Collector 連携（Native Messaging Host の登録・修復・更新・解除）

- 機能の略称：COL（要件 ID の接頭辞）
- 追加バージョン：v0.2.0
- 状態：**下書き**。ユーザー確認前。「検証済み」は最終チェック後のみ付ける。
- 基準：ブランチ `codex/mb-s8-b4-wiring`（`d52feb9`）の `apps/desktop/`。関連コード・テストのパスは、特記がなければここからの相対パス。

## 実装方針
- 根拠文書：`docs/collector-wizard-integration-design.md`（設計案）、`docs/desktop-alpha2-packaging.md`、引継ぎ `docs/handoff-collector-wizard-s8-2026-11-23-v4.md`（`D:\python\MAGINALIA_ALPHA` 側。この worktree には無い）。
- Desktop アプリ本体（main プロセス）が、ユーザー操作の後に Host ファイルと HKCU のレジストリ値を書く。インストーラは読み取り専用のペイロードを配るだけ（設計 3.2）。
- 描画側（renderer）は「意図（intent）」だけを送り、パスは送らない（設計 4.1）。
- **対応ブラウザー（PO 確認 2026-11-25）：Chrome・Edge・Vivaldi の 3 つ。** 登録先のレジストリキーは Chrome と Edge の 2 つで、Vivaldi は Chrome のキーを借りて動く（独自のキーは書かない）。Vivaldi は実機（旧インストーラー、2026-11-25）で登録→確認まで確認済み。設計書の「Chrome のみ」は古く、コードと本書を正とする。
- 設計書は Chrome のみ・状態ファイル v1 の記述。実装は Chrome と Edge の 2 つの書込み先・状態ファイル v2 に進んでいる。差は「要確認」に列挙した。
- 「実機」欄：パッケージ版の実機確認（インストール、レジストリ、ブラウザー操作）は、引継ぎ v4 の時点で未実施。実機確認の記録があるのは、引継ぎ v4 §2・§4 の Edge の ProgId・拡張機能 ID・origin など（2026-11-22）だけ。

## 要件

### COL-01 Host manifest と登録先の固定値
- 受け入れ条件：
  - Host の名前が `org.maginalia.collector` のとき、生成される manifest は `name`=`org.maginalia.collector`、`type`=`stdio`、`path`=`host-<a|b>\MAGINALIA-Collector-Host.exe`（相対）、`allowed_origins`=`["chrome-extension://blgmoddncpknfnikdfnjelmdmphfgknf/"]` の 1 件だけになる。
  - 書込み対象のレジストリは HKCU の `Software\Google\Chrome\NativeMessagingHosts\org.maginalia.collector` と `Software\Microsoft\Edge\NativeMessagingHosts\org.maginalia.collector` の既定値で、値は `%LOCALAPPDATA%\Programs\MAGINALIA Collector\org.maginalia.collector.json`。`Software\Chromium\...` は読むだけで書かない。Vivaldi は専用のキーを持たず、読みも書きもしない（Chrome のキーを借りる）。
  - 実機: 未確認
- 関連コード：
  - src/collector-payload.ts:12-16（プロトコル、拡張機能 ID、許可 origin、Host 実行ファイル名）
  - src/collector-integration-apply.ts:176-189（`buildCollectorHostManifest`）
  - src/collector-integration.ts:640（`expectedHostManifest`）
  - src/collector-browser-table.ts:27-38（登録先の表。writable は chrome と edge）
  - native/windows-integration/src/windows_integration.cc（書込み先の表 `kTargets`）
- テスト：src/collector-integration.test.ts:809（expected manifest）、src/collector-integration-apply.test.ts:111（setup from nothing）、src/collector-payload.test.ts:10、src/windows-integration.test.ts:150
- 状態：実装済み
- 備考：設計 3.3 は Chrome の 1 キーだけ。Edge のキーを書くのは複数ブラウザー対応（コード）。要確認 #1。

### COL-02 登録（setup）
- 受け入れ条件：
  - 状態が `not-set-up` のとき `setup` を実行すると、結果が `applied`、状態が `ready` になり、書込み対象の各キーに manifest のパスが入り、`integration-state.json` が書かれる。
  - 状態が `ready` のとき `setup` を実行すると `noop` になり、何も書き換えない。
  - 状態が `foreign-registration` のとき、確認なしの `setup` は理由 `foreign-confirmation-required` で拒否され、何も書かない。`confirmReplaceForeign` つきのときだけ他者の値を置き換える。
  - 本棚・引用データ・Workdesk には触れない。
  - 実機: 未確認
- 関連コード：
  - src/collector-integration-apply.ts:1401（`applyCollectorIntegration`）、:998-1021（実行できる状態の表と foreign 確認）、:811-870（レジストリ書込み）
  - src/collector-integration-service.ts:361-369（`setup`。対応ブラウザーが無いと `browser-required`）
- テスト：src/collector-integration-apply.test.ts:111、:274、:1043；src/collector-integration-apply-fault.test.ts:133；src/collector-integration-service.test.ts:210
- 状態：実装済み
- 備考：書込み順序（フォルダー → 空きスロット → 拡張機能 → manifest → レジストリ → 状態ファイル → 自己確認）は src/collector-integration-apply.ts:35-56 のコメントと設計 3.5 に沿う。

### COL-03 修復（repair）
- 受け入れ条件：
  - 状態が `registration-missing` または `damaged` のとき `repair` を実行すると `ready` になる。
  - 状態が `foreign-registration` のとき `repair` は `confirmReplaceForeign` がなければ拒否される。
  - 状態が `ready` のとき `repair` は `noop` になる。
  - 保存先の設定（binding）とマーカーは、どの場合も作らない・直さない。
  - 実機: 未確認
- 関連コード：src/collector-integration-apply.ts:998-1000、:1020-1021；src/collector-integration-service.ts:370-371
- テスト：src/collector-integration-apply.test.ts:1183（repair）、src/collector-integration-apply-fault.test.ts:232
- 状態：実装済み
- 備考：「binding は修復しない」は設計 5 の記述。専用のテストは未確認（要確認 #9）。

### COL-04 更新（起動時の自動更新）
- 受け入れ条件：
  - `integration-state.json` が有効で（設定済み）、状態が `outdated` のとき、起動時に `refresh` が走り、成功なら「更新しました」通知が出る。
  - 状態ファイルが無いとき（未設定）は、更新も通知も何もしない。ただし α1 からの移行通知は 1 回だけ出る（COL-11）。
  - 状態が `foreign-registration`・`registration-missing`・`damaged` のときは、自動では直さず、修復通知（`maginalia.collector.repair` を呼ぶ）だけ出す。
  - 解除を依頼済み（`removeRequested`）の間は、更新も修復通知も止まる。
  - `failed`・`refused`・`noop`・`partial` のときは通知を出さず、次の起動で再検査する。
  - 起動時の検査はハッシュを計算しない（`payloadId` の文字列比較）。
  - 実機: 未確認
- 関連コード：src/collector-startup-refresh.ts:1-48（規則）、:125（`createCollectorStartupRefresh`）；src/collector-startup-refresh-composition.ts:116
- テスト：src/collector-startup-refresh.test.ts:104、:119、:226、:260、:426
- 状態：実装済み
- 備考：稼働中の Host を上書きしないよう、A/B の 2 スロットを使う（設計 6.3。src/collector-integration-apply.ts:35-56）。

### COL-05 解除（remove）
- 受け入れ条件：
  - メニュー「Collector 連携を解除…」を実行すると、確認ダイアログ「Collector 連携を解除しますか？」が出る。ボタンは「解除する」「キャンセル」で、既定はキャンセル。チェックボックス「保存先の設定も解除する」は初期オフ。
  - 「キャンセル」のとき何も削除せず、「Collector 連携の解除は行いませんでした。」を報告する。
  - 「解除する」のとき、書込み対象のレジストリ値を、自分の manifest パスと一致する場合だけ削除し、次に manifest、スロット内の固定名ファイル、拡張機能フォルダー、状態ファイルを削除し、空のフォルダーを再帰なしで削除する。
  - 他者の値が入ったキーは残す（`foreign-left`）。名前を知らないファイルは残し、結果は `partial` になる。
  - 本棚・引用データ・Workdesk・書き込み記録・ブラウザー内の拡張機能は削除しない。
  - リンク／ジャンクション（reparse point）は辿らず、削除しない。
  - 実機: 未確認
- 関連コード：
  - src/main.ts:442-456（確認ダイアログ `confirmCollectorRemoval`）
  - src/collector-integration-apply.ts:1296-1352（remove の本体）
  - src/collector-integration-service.ts:372-373
  - src/renderer/collector-integration-commands.ts:80-93（結果の一行報告）
- テスト：src/collector-integration-apply-remove.test.ts:43、:352（junction canary）、:419；src/collector-integration-apply-fault.test.ts:551、:597；src/collector-startup-refresh.test.ts:473、:544、:751
- 状態：実装済み
- 備考：確認ダイアログの文言は設計 5 と異なる（「Chrome」→「ブラウザー」。要確認 #6）。

### COL-06 解除の取り消し（cancelRemove）
- 受け入れ条件：
  - 解除を依頼済みで未完了（`removeRequested` が立っている）のとき、`maginalia.collector.cancelRemove` を実行すると結果 `cleared` になり、フラグと「解除失敗」通知が消え、次回起動から自動更新と修復通知が通常どおり働く。
  - 状態が `ready` または `outdated` のとき、「解除を取りやめました。Collector 連携は、次回の起動時から自動更新を含めて通常どおり扱われます。」と報告する。それ以外の状態のときは、「解除を取りやめました。すでに削除されたファイルは戻りません。「Collector 連携を確認・修復…」で状態を確認してください。」と報告する。
  - `removeRequested` が立っていないとき、結果は `not-requested` で「取りやめる解除はありません。」と報告する。
  - 状態が `not-set-up` のとき、結果は `nothing-to-cancel` で「Collector 連携はすでに解除されています。もう一度使うときは「Collector 連携を設定」を行ってください。」と報告する。
  - 他の apply が実行中のとき `busy` を返す。
  - 何も削除せず、ファイルも書き換えない。書くのは通知の状態だけ。
  - 実機: 未確認
- 関連コード：src/collector-integration-service.ts:374-387；src/collector-startup-refresh.ts:110-115、:427-445；src/renderer/collector-integration-commands.ts:25、:80-112、:180-186
- テスト：src/collector-startup-refresh.test.ts:766（cancelRemove and removeRequested）；src/collector-integration-service.test.ts:210；src/renderer/collector-integration-commands.test.ts；src/renderer/collector-wizard-model.test.ts:1032、:1050
- 状態：実装済み
- 備考：判断 B-2 に由来（引継ぎ v4 §7）。設計書 5 のコマンド表には無い。「解除の取り消し手段」の判断は未回答（要確認 #7）。

### COL-07 状態の判定（inspect）
- 受け入れ条件：
  - 検査は書き込まない。結果は `not-set-up`、`policy-blocked`、`foreign-registration`、`registration-missing`、`outdated`、`damaged`、`ready` のいずれか 1 つ。
  - 状態ファイルの `payloadId` が埋め込み値と違うとき `outdated`。ハッシュ・manifest・スロットが違う、または reparse point があるとき `damaged`。
  - 読み取りに失敗したときは、安全側（`damaged`）に倒れ、通知は出さない。
  - 結果にパス・本棚の UUID・本棚名を含めない。
  - 実機: 未確認
- 関連コード：src/collector-integration.ts:810（`inspectCollectorIntegration`）、:586-654；src/collector-integration-service.ts:136-210
- テスト：src/collector-integration.test.ts:52、:357、:686、:755
- 状態：実装済み

### COL-08 自己確認（self-check）
- 受け入れ条件：
  - 登録後、レジストリ → manifest → 実行ファイルを Chrome と同じ順にたどって Host を起動し、`health` を送る。プロトコル識別子が埋め込み値と等しく、かつ起動直前の実行ファイルのハッシュ照合（埋め込み値との一致）が通ったとき成功。Host のバージョン比較は、Host が `health` で版を返すまで行わない（TODO(WP-6)。PO 承認 2026-11-25）。
  - 失敗したとき、状態は `damaged` として報告され、`ready` とは扱わない。
  - 自己確認は拡張機能やブラウザーの動作は証明しない。
  - 実機: 未確認
- 関連コード：src/collector-integration-apply-self-check.ts；src/collector-integration-service.ts:325-336；src/collector-integration-apply.ts:919-925（ハッシュ照合と TODO(WP-6)）
- テスト：src/collector-integration-apply.test.ts:1133
- 状態：実装済み

### COL-09 Host の host_info と接触記録
- 受け入れ条件：
  - 許可 origin 以外から `host_info` を受けたとき、Host は `host_configuration_or_origin_invalid` を返す。
  - 許可 origin から `host_info` を受けたとき、`%LOCALAPPDATA%\MAGINALIA\integration\collector-contact.json` に、`version`・`protocol`・`hostVersion`・`extensionVersion`・`contactedAt` の 5 項目だけを書く。パス・本棚の UUID・本棚名・URL・引用文は書かない。
  - 値が変わらないときは 60 秒に 1 回まで。一時ファイルに書いて rename する。
  - 統合フォルダーの所有者・権限の確認に失敗したときは書かない。
  - `health` の `operations` 一覧に `host_info` が追加される。
  - 実機: 未確認
- 関連コード：src/collector-contact-record.ts:28-29、:86；src/collector-native-host-product.ts:69、:120-126；src/collector-native-host-core.ts:64-101
- テスト：src/collector-contact-record.test.ts:35-170；src/collector-native-host-product.test.ts:93（host_info）、:50
- 状態：実装済み
- 備考：設計 10 の Q1（接触記録を許可するか）の Product Owner の回答は、この調査では確認できなかった（要確認 #5）。

### COL-10 保存先の設定（既存コマンドの再利用）
- 受け入れ条件：
  - `maginalia.collector.configureSaveDestination` は、`shelf_location.yml` と D068 マーカーを読み、本棚名つきの確認ダイアログを出し、「この本棚に設定」を押したときだけ binding を書く。
  - 「キャンセル」のとき binding を書かない。マーカーが無効・競合・欠落のとき、binding を書かず、マーカーも作らず直さない。
  - ウィザード経由の結果に、本棚名・パス・UUID を含めない。
  - 実機: 未確認
- 関連コード：src/collector-save-destination.ts:41-42、:108、:183；src/collector-save-destination-ipc.ts；src/collector-shelf-configuration.ts
- テスト：src/collector-save-destination.test.ts:46、:137、:171；src/collector-shelf-configuration.test.ts
- 状態：実装済み
- 備考：binding の詳細は `docs/collector-host-binding.md`。この下書きでは同文書を精読していない（要確認 #9）。

### COL-11 通知と α1 からの移行通知
- 受け入れ条件：
  - 通知の ID は `collector.notice.updated`・`collector.notice.repair`・`collector.notice.alpha1-migration`・`collector.notice.remove-failed` の 4 つだけ。
  - α1 から更新した利用者で、状態が `not-set-up`、状態ファイルが無く、通知が一度も出ていないとき、起動後に 1 回だけ移行通知を出す。「設定する」は `maginalia.collector.setup` を呼ぶ。「今はしない」で閉じると再表示しない。
  - 「設定する」のコマンドが失敗したときは通知を閉じない。
  - 通知の状態は Desktop の userData にだけ書き、他は書かない。
  - 実機: 未確認
- 関連コード：src/collector-integration-notices.ts:18-35、:86-157；src/collector-startup-refresh.ts:1-48；src/renderer/collector-integration-commands.ts:209-221；src/renderer/collector-notices-surface.ts
- テスト：src/collector-integration-notices.test.ts:20、:93；src/collector-startup-refresh.test.ts:315、:741；src/collector-integration-ipc.test.ts；src/renderer/collector-notices-surface.test.ts
- 状態：実装済み
- 備考：通知文言の「Chrome」→「ブラウザー」への一般化は `ff3117f`（引継ぎ v4 §6）。判断 B-1 は未回答。

### COL-12 テスト起動での分離（E2E isolation）
- 受け入れ条件：
  - 環境変数 `MAGINALIA_E2E_ISOLATION_ROOT` があるとき、`setup`・`repair`・`refresh`・`remove` は理由 `e2e-isolation` で拒否され、レジストリもプログラムフォルダーも書き換えない。
  - 同じとき、起動時の更新・通知の処理は何もしない。
  - この変数は連携を無効にするだけで、書込み先を変えることはできない。
  - 実機: 未確認
- 関連コード：src/collector-integration-apply.ts:410、:1004；src/collector-startup-refresh-composition.ts:80、:116-121；src/main.ts:462
- テスト：src/collector-integration.test.ts:789；src/collector-startup-refresh.test.ts:226
- 状態：実装済み

### COL-13 IPC は意図だけを送る
- 受け入れ条件：
  - 描画側が送るリクエストは、列挙された `intent` と、任意の `confirmReplaceForeign`・`proceedWithoutSupportedBrowser`・`browser`（表の行 ID）だけ。それ以外のキー（パス、レジストリキー、値）を含むリクエストは拒否される。
  - `confirmReplaceForeign` は `setup` と `repair` のときだけ、`proceedWithoutSupportedBrowser` は `setup` のときだけ有効。
  - Collector 連携のソース（`collector-integration*.ts`、`windows-integration.ts`）は `process.env`・`process.cwd`・`process.argv` を読まない。
  - 実機: 未確認
- 関連コード：src/collector-integration-ipc.ts:28-89；src/collector-integration-service.ts:355-420
- テスト：src/collector-integration-ipc.test.ts；src/windows-integration.test.ts:461（source scan）；src/collector-integration.test.ts:821
- 状態：検証済み（2026-11-25 最終チェック。静的な性質。実機は不要（collector-integration*.ts に process.env/cwd/argv が 0 件））
- 備考：設計 4.1 は「拡張機能フォルダーのパスだけは表示・コピー用に描画側へ渡る」。実装のウィザード文言は「フォルダーの場所は画面には表示しません」（要確認 #3）。`collector-integration-apply-self-check.ts` と `main.ts` は環境を読む（子プロセス用の環境構築など）。設計の「`collector-integration*.ts` は読まない」との整合は未確認。

### COL-14 コマンドとメニュー
- 受け入れ条件：
  - コマンド ID は `maginalia.collector.setup`・`.repair`・`.removeIntegration`・`.cancelRemove`・`.openBrowserExtensions`・`.configureSaveDestination`・`.clearSaveDestination`（内部用に `.dismissNotice`）で、メニュー・パレット・通知ボタンは同じ ID を呼ぶ。
  - メニュー（ファイル）の表示は「Collector 連携を設定…」「Collector 連携の確認・修復…」「Collector 連携を解除…」「Collector 連携の解除を取りやめる」「Collector の保存先を設定…」「Collector の保存先を解除…」。
  - `setup` と `repair` は、どちらもウィザードを開く。
  - 実機: 未確認
- 関連コード：src/application-menu-contract.ts:27-33；src/renderer/collector-integration-commands.ts:23-28、:140-205
- テスト：src/application-menu.test.ts；src/renderer/collector-integration-commands.test.ts
- 状態：実装済み
- 備考：設計 5 の表記は「Collector 連携を確認・修復…」。実装は「…の確認・修復…」（要確認 #6）。

### COL-15 ブラウザーの組織ポリシー
- 受け入れ条件：
  - ブラウザーの policy（`NativeMessagingUserLevelHosts`=0、または `NativeMessagingBlocklist` に `*` か `org.maginalia.collector` があって Allowlist に無い）で禁止されているとき、そのブラウザーは `policyBlocked` と判定し、書き込まない。HKLM や別ブラウザーのキーへのフォールバックはしない。
  - 検証済みの全ブラウザーが policy でブロックされているとき、状態は `policy-blocked`。
  - 実機: 未確認
- 関連コード：src/collector-integration.ts:174（`evaluateChromePolicies`）、:455 付近（`aggregatePolicy`）；src/collector-integration-apply.ts:381 付近（`readBlockedBrowsers`）；src/collector-registry-adapter.ts:64
- テスト：src/collector-integration.test.ts:404；src/collector-integration-browsers.test.ts
- 状態：実装済み
- 備考：D074：Chrome が policy でブロック・Edge 未導入・Vivaldi 導入済みの場合は「進めない」で確定（コード変更なし）。WIZ-09 参照。

### COL-16 ペイロードの固定（pin）と同梱の検証
- 受け入れ条件：
  - Collector の ZIP は `runtime-versions.json` の `collectorExtension`（版 0.3.0、SHA-256、拡張機能 ID `blgmoddncpknfnikdfnjelmdmphfgknf`）に固定される。SHA-256 の不一致、`manifest.version` の不一致、`manifest.key` から導いた ID の不一致のとき、ビルドは失敗する。
  - ZIP の展開は、絶対パス・`..`・バックスラッシュ・重複・一覧外のエントリを拒否する。
  - `verify:packaged-collector-payload` が `win-unpacked` に対して終了コード 0 で終わる。
  - 開発起動（`npm run start`）では連携は動かない（スタブ。設計どおり）。
  - 実機: パッケージ版のビルドと `verify-packaged-collector-payload` は、引継ぎ v4 §3・§11 で終了コード 0 の記録あり（2026-11-23、ローカル）。インストールしての動作は未確認。
- 関連コード：packaging/runtime-versions.json:13-19；scripts/stage-collector-payload.mjs；scripts/collector-payload.mjs；scripts/verify-packaged-collector-payload.mjs；scripts/embed-collector-payload.mjs；src/collector-payload-compiled.ts:11-12；packaging/electron-builder.json:24-27
- テスト：src/collector-payload-build.test.ts:114、:130、:196、:244、:302、:370、:392；src/collector-payload.test.ts:10
- 状態：実装済み

### COL-17 ブラウザー表（Chrome・Edge・Vivaldi）
- 受け入れ条件：
  - 対応ブラウザーは `edge`・`chrome`・`vivaldi` の 3 行で、すべて `verified`。
  - https の既定ハンドラーの ProgId が `^MSEdgeHTM$` なら Edge、`^ChromeHTML(\.[A-Za-z0-9]+)?$` なら Chrome、`^VivaldiHTM(\.[A-Za-z0-9]+)?$` なら Vivaldi と判定する。Brave などの Chromium 系は `other-chromium`、それ以外は `other`、空は `unknown`。
  - Vivaldi は専用の登録先を持たず（`ownTargets` が空）、Chromium キーと Chrome キーの順に読む。
  - リリースゲート `collectorBrowserReleaseGateViolations` は空を返す。
  - 実機: 一部確認。Edge の ProgId（`MSEdgeHTM`）、拡張機能 ID、origin は 2026-11-22 に実機で確認（引継ぎ v4 §2）。Vivaldi の ProgId `VivaldiHTM` は spike で実測。Vivaldi は、旧インストーラー（2026-11-25）で、ウィザードによる登録→確認と実 Collector 0.3.0 の動作を実機で確認済み。Chrome・Edge のパッケージ版での通しは未確認。
- 関連コード：src/collector-browser-table.ts:40、:126-257（3 行）、:268-280（ゲート）、:300-318（分類）
- テスト：src/collector-browser-table.test.ts:47、:108、:179、:384、:450；src/collector-integration-browsers.test.ts
- 状態：実装済み
- 備考：表示用の根拠（`extensionsPage`・`ui`・`store`・Vivaldi の `downloadUrl`）は `unverified` のまま（`collectorBrowserPresentationEvidenceGaps` が列挙）。設計は「S10 で空にしてからリリース」としている。要確認 #4。

## 要確認（コードと文書の食い違い・文書にない点。仕様には書いていない）
1. 設計書 3.3・3.4 は Chrome の HKCU キー 1 つ、状態ファイル v1。実装は Chrome と Edge の 2 キー、状態ファイル v2（`registeredTargets`）。設計書は更新されていない（`docs/collector-multi-browser-design.md` は別 worktree にあり、この調査では未読）。
2. 設計書 2.4 のアンインストール手順は Chrome の 1 キーの削除と、固定名ファイルの削除。実装の NSIS は「有効な状態ファイルがあるときだけ」ファイルを削除する（INS-04 参照）。
3. 設計 4.1 は「拡張機能フォルダーのパスを読み取り専用欄に表示する」。実装のウィザード文言は「フォルダーの場所は画面には表示しません。［パスをコピー］…」（src/renderer/collector-wizard-copy.ts:526 付近）。
4. 表示用の根拠（`extensionsPage`・`ui`・`store`・`downloadUrl`）が未計測。リリース前に埋めるかどうかの基準は文書に無い。
5. 設計 10 の Q1〜Q4（接触記録、D023 の例外、自動更新、拡張機能の置き場所）の Product Owner の回答は、読んだ文書の中に見つからない。
6. 文言の食い違い：設計 5 の解除ダイアログは「Chrome の拡張機能一覧」、実装は「ブラウザーの拡張機能一覧」。メニュー「確認・修復」の表記も異なる。実装が新しいと見られるが、どちらが正かの記述は無い。
7. 引継ぎ v4 §7 の判断 B-1〜B-9（alpha1 通知文言、解除の取り消し手段、自動更新の文言など）は未回答のまま。
8. 引継ぎ v4 は、`MAGINALIA_IDE/plan/30` の衝突マーカー（L8-15）と、D072・D073 の正本への反映が未実施と記す。この worktree からは確認していない。D073・D074 は `D:\python\MAGINALIA_IDE` の `plan/09_DECISION_LOG.md:108-109` にある。
9. この下書きで精読していない文書：`docs/collector-host-binding.md`、`docs/collector-native-host-smoke.md`、`docs/collector-shelf-*.md`、`docs/desktop-e2e-isolation.md`。COL-03 の「binding は修復しない」と COL-10 の詳細は、これらで確認が必要。
