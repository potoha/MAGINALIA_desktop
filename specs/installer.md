# Windows インストーラ（未署名・Desktop ショートカット・アンインストール）

- 機能の略称：INS（要件 ID の接頭辞）
- 追加バージョン：v0.2.0
- 状態：**下書き**。ユーザー確認前。「検証済み」は最終チェック後のみ付ける。
- 基準：ブランチ `codex/mb-s8-b4-wiring`（`d52feb9`）の `apps/desktop/`。パスは特記がなければここからの相対パス。

## 実装方針
- 根拠文書：`apps/desktop/packaging/README.md`、`docs/desktop-alpha2-packaging.md`、`docs/collector-wizard-integration-design.md` §2、引継ぎ `docs/handoff-collector-wizard-s8-2026-11-23-v4.md`（§7 C7、§9-4）。
- 配布物は 1 本の NSIS インストーラ `MAGINALIA-desktop-<version>-Setup.exe`。Collector の Host と拡張機能は、アプリの `resources` に読み取り専用で入り、インストーラはインストール先の外に何も書かない（設計 2.1、2.3）。登録はアプリ本体が利用者の操作後に行う（COL-02）。
- アンインストール時の Collector 連携の後始末は、`customUnInstall` の NSIS で行う。アプリの `remove`（COL-05）の、名前だけを使う簡易版。両者が食い違うときは、アプリ側と設計書が正で、NSIS 側を直す（packaging/collector-uninstall.nsh:1-6）。
- 「実機」欄：インストーラの実機での受け入れ（clean-machine の、インストールからアンインストールまで）は、引継ぎ v4 §9-4 で「未着手（NOT VERIFIED）」。この下書きの全要件が「実機: 未確認」。

## 要件

### INS-01 インストーラの形式と識別
- 受け入れ条件：
  - ビルドの成果物の名前は `MAGINALIA-desktop-<version>-Setup.exe`、対象は Windows x64 の NSIS、言語は日本語（1041）。
  - 製品名は「MAGINALIA Alpha2 Wild Berry」、バージョンは `apps/desktop/package.json` の値。
  - `appId`（`org.maginalia.desktop.alpha1`）、staged manifest の名前、userData の場所は α1 から変えない。α1 の上にインストールしたとき、userData、Workdesk、Shelf、初回セットアップの記録が残る。
  - インストール先の変更は許可しない（`allowToChangeInstallationDirectory`=false）。インストール方式の選択ページ（自分のみ／全員）は出る（`oneClick`=false、`perMachine`=false）。
  - 実機: 未確認
- 関連コード：packaging/electron-builder.json:2-3、:29-50；packaging/README.md:3
- テスト：src/windows-integration.test.ts:1163（packaging configuration）；src/collector-payload-build.test.ts:370（repository packaging wiring）
- 状態：実装済み
- 備考：「α1 → α2 でデータが残る」ことを直接検証するテストは見つからない（`docs/desktop-alpha2-packaging.md` は「Not verified on a machine」と記す）。要確認 #2。

### INS-02 コード署名なし（未署名）
- 受け入れ条件：
  - 配布するインストーラ、アプリ本体、同梱の Host にコード署名を付けない。
  - 署名なしであるため、Windows の SmartScreen の警告が出ることは既知の制限として、リリースの案内に書く。
  - 実機: 未確認
- 関連コード：packaging/electron-builder.json（署名の設定なし）；scripts/build-collector-host.mjs:341（`signing: unsigned (SmartScreen warning is a known limitation)`）
- テスト：テストなし
- 状態：実装済み
- 備考：「署名なし」は設定が無いことで成り立つ。引継ぎ v4 §9-5 はコード署名を「PO の承認が要る」未了項目に置く。リリースの案内に SmartScreen の警告を書いた文書は、この調査では見つからない（要確認 #3）。

### INS-03 Desktop ショートカット（任意）
- 受け入れ条件：
  - インストール中のページ「ショートカットを選ぶ」に、チェックボックス「デスクトップにもショートカットを作る」が出て、初期状態はオフ。
  - オンのとき、`%DESKTOP%\MAGINALIA Alpha2 Wild Berry.lnk` を作り、インストール先の実行ファイルを指す。
  - 同じ名前のショートカットがすでにあるとき（更新・再インストールを含む）は、上書きも作成もせず、「同じ名前のショートカットがあるため、デスクトップには追加しませんでした。」と表示する。
  - アンインストール時にデスクトップのショートカットは削除しない。スタートメニューのショートカットはインストーラが管理する。
  - α1 の上にインストールするとき、`MAGINALIA desktop α1.lnk` は、リンク先がインストール先の α1 の実行ファイルと一致するときだけ削除し、新しい名前のショートカットを作る。リンク先が違う、または確認に失敗したときは削除しない。事前リリース版の `MAGINALIA α2 wild berry.lnk` も同じ規則。
  - 実機: 未確認
- 関連コード：packaging/installer-shortcut.nsh:20-48（ページとチェックボックス）、:85-129（`customInstall`）；packaging/electron-builder.json:41-43；packaging/README.md:5-11
- テスト：src/installer-shortcut.test.ts:9、:23、:35
- 状態：実装済み
- 備考：`docs/desktop-alpha2-packaging.md` は、PowerShell 断片だけを単独で実行し、インストーラ全体の動作は未確認と記す。

### INS-04 アンインストール時の Collector 連携の後始末
- 受け入れ条件：
  - 本当のアンインストールのときだけ（`${isUpdated}` が偽）、かつ「自分のみ」のインストール（`$installMode` が `CurrentUser`）のときだけ、後始末が走る。更新（`--updated`）のときは、登録とフォルダーを残す。
  - HKCU の `Software\Google\Chrome\NativeMessagingHosts\org.maginalia.collector` と `Software\Microsoft\Edge\NativeMessagingHosts\org.maginalia.collector` を、それぞれ別に確認し、既定値が `%LOCALAPPDATA%\Programs\MAGINALIA Collector\org.maginalia.collector.json` と等しいときだけ値を削除する。他者の値のキーは残す。他のキー（`Software\Chromium\...`、`Software\Vivaldi\...`、他の Host）は触らない。
  - プログラムフォルダー `%LOCALAPPDATA%\Programs\MAGINALIA Collector` の中は、有効な `integration-state.json` があるときだけ、固定名のファイルと、`<名前>.<16 桁の小文字 16 進>.tmp` の一時ファイルだけを削除する。状態ファイルが無い、または無効なときは、ディスク上に何も触らない。
  - 再帰削除・ワイルドカード削除はしない。リンク／ジャンクション／reparse point は辿らず削除しない。名前を知らないファイルは残し、フォルダーも残る。
  - 「全員向け」のインストール（`$installMode` が `all`）では後始末をしない。その場合は、アプリの「Collector 連携を解除…」（COL-05）が手段になる。
  - 実機: 未確認（引継ぎ v4 §7 C7：「実機のアンインストールは NOT VERIFIED」）
- 関連コード：packaging/collector-uninstall.nsh:1-45（規則）、:375-383（`MAGINALIA_UnregisterHostKey`）、:386-438（`MAGINALIA_CollectorCleanup`）、:449-455（`customUnInstall`）；packaging/installer-shortcut.nsh:4（include）
- テスト：src/collector-uninstall.test.ts:70（静的検査。:83 `isUpdated` と `installMode` の条件、:90、:125）
- 状態：実装済み
- 備考：NSIS の `==` が大文字小文字を区別しないかは未確認（引継ぎ v4 §7。コメントは case-insensitive と書き、実装は `==`）。要確認 #4。

### INS-05 アンインストール時のデータの保持
- 受け入れ条件：
  - アンインストールは、`%LOCALAPPDATA%\MAGINALIA`（binding、coordination、journal、recovery marker）、Shelf、Workdesk、Projects、ブラウザーのプロフィールのデータ（Collector の保留中の引用を含む）、userData を削除しない。
  - `deleteAppDataOnUninstall` は false。
  - 実機: 未確認
- 関連コード：packaging/electron-builder.json:44；packaging/collector-uninstall.nsh:23-25
- テスト：src/collector-uninstall.test.ts:70
- 状態：実装済み
- 備考：このテストは NSIS スクリプトの静的検査。ディスク上の削除対象の網羅は、アプリ側の `remove` のテスト（src/collector-integration-apply-remove.test.ts:352 の junction canary など）による。

### INS-06 Collector のペイロードの同梱
- 受け入れ条件：
  - インストール先の `resources` に、`collector-host/`（Host 実行ファイル、`shelf_mutex.node`、ライセンス・NOTICE・PROVENANCE）、`collector-extension/`、`collector-payload.json`、`windows-integration/`（`windows_integration.node`、PROVENANCE）が入る。
  - インストーラは、インストール先以外のファイルとレジストリを書かない（Collector 連携の登録は、アプリが利用者の操作後に行う）。
  - 実機: 未確認。パッケージ版の `win-unpacked` に対する検証は引継ぎ v4 §3 に終了コード 0 の記録（ローカル）。
- 関連コード：packaging/electron-builder.json:12-27；scripts/verify-packaged-collector-payload.mjs；scripts/verify-packaged-windows-integration.mjs
- テスト：src/collector-payload-build.test.ts:392；src/windows-integration.test.ts:1163
- 状態：実装済み
- 備考：COL-16 と一部重なる（ペイロードの固定と検証は COL-16、配置は本要件）。

## 要確認（コードと文書の食い違い・文書にない点。仕様には書いていない）
1. 設計 2.4 は、アンインストールが固定名の拡張機能ファイル（`collector-extension-files.json` の和集合）を削除するとし、状態ファイルの有無には触れない。実装の NSIS は有効な状態ファイルを所有の証拠にしている（collector-uninstall.nsh:14-17）。設計書が古いと見られる。`packaging/collector-extension-files.json` はこの worktree に見つからない（`git ls-files` で `collector-payload.example.json`、`collector-payload.schema.json` のみ）。
2. α1 → α2 でデータが残ること、初回セットアップが再表示されないこと（設計 2.3）を、実機または自動テストで確認した記録がない。
3. 未署名であること、SmartScreen の警告が出ることを、利用者向け文書に書く場所と文言が決まっていない（`docs/` を検索した範囲では記述なし。日本語マニュアルは `apps/desktop/packaging/manual` の PDF で、この調査では未読）。
4. NSIS `==` の大文字小文字の扱い（collector-uninstall.nsh:379 とコメント :372 付近）。
5. 全員向けインストール（`all`）のときの制限（後始末が走らない）を、リリースノートに書くことが設計 2.4 の条件。リリースノートは未確認。
6. 設計 2.5 は旧スタンドアロン Host のインストーラ（`packaging/collector-host/installer.nsi`）の削除を定める。この worktree に当該ファイルは無く（`git ls-files` で未検出）、設計どおり。旧版を入れた試験者の HKCU 登録の移行は COL-02 の foreign 置換が担う。実機は未確認。
