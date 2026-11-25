# 仕様書 索引（v0.2.0、下書き）

**下書きです。** ユーザーが確認してから正本にします。「検証済み」の状態は、最終チェックで「満たす」と判定された後にだけ付けます。この下書きに「検証済み」はありません。

- 基準：ブランチ `codex/mb-s8-b4-wiring`（`d52feb9`）。ライセンスだけは別ブランチ `codex/license-agpl-0.2`（PR #112）が実装の場所。
- 状態の種類：未着手 / 実装済み / 検証済み / 廃止
- 「実機: 未確認」の要件は、受け入れ条件の下にその旨を書いている。実機の確認記録があるのは、COL-17 の Edge の項目（2026-11-22）と、COL-16・INS-06 のビルド検証（ローカル）の一部だけ。
- 各ファイル末尾の「要確認」に、コードと文書の食い違いを列挙した。仕様本文には書いていない。

| 要件ID | 概要 | 機能ファイル | 状態 |
| --- | --- | --- | --- |
| COL-01 | Host manifest と登録先（HKCU の Chrome・Edge キー）の固定値 | specs/collector.md | 実装済み |
| COL-02 | 登録（setup） | specs/collector.md | 実装済み |
| COL-03 | 修復（repair） | specs/collector.md | 実装済み |
| COL-04 | 起動時の自動更新（refresh） | specs/collector.md | 実装済み |
| COL-05 | 解除（remove） | specs/collector.md | 実装済み |
| COL-06 | 解除の取り消し（cancelRemove） | specs/collector.md | 実装済み |
| COL-07 | 状態の判定（inspect、7 状態） | specs/collector.md | 実装済み |
| COL-08 | 自己確認（self-check） | specs/collector.md | 実装済み |
| COL-09 | Host の host_info と接触記録 | specs/collector.md | 実装済み |
| COL-10 | 保存先の設定（既存コマンドの再利用） | specs/collector.md | 実装済み |
| COL-11 | 通知と α1 からの移行通知 | specs/collector.md | 実装済み |
| COL-12 | テスト起動での分離（E2E isolation） | specs/collector.md | 実装済み |
| COL-13 | IPC は意図だけを送る | specs/collector.md | 実装済み |
| COL-14 | コマンドとメニュー | specs/collector.md | 実装済み |
| COL-15 | ブラウザーの組織ポリシー | specs/collector.md | 実装済み |
| COL-16 | ペイロードの固定（pin）と同梱の検証 | specs/collector.md | 実装済み |
| COL-17 | ブラウザー表（Chrome・Edge・Vivaldi） | specs/collector.md | 実装済み |
| WIZ-01 | ウィザードの開き方 | specs/wizard.md | 実装済み |
| WIZ-02 | 初回セットアップ完了画面からの任意の案内 | specs/wizard.md | 実装済み |
| WIZ-03 | 手順の構成と進捗表示 | specs/wizard.md | 実装済み |
| WIZ-04 | ブラウザーの選択肢（通常／Chrome／Edge） | specs/wizard.md | 実装済み |
| WIZ-05 | おすすめと初期選択（既定ブラウザーのみ） | specs/wizard.md | 実装済み |
| WIZ-06 | 既定ブラウザー別の案内文（reason） | specs/wizard.md | 実装済み |
| WIZ-07 | ボタンの並び順 | specs/wizard.md | 実装済み |
| WIZ-08 | 登録の結果表示（ステップ B） | specs/wizard.md | 実装済み |
| WIZ-09 | policy でブロックされた場合（D074） | specs/wizard.md | 実装済み |
| WIZ-10 | 保存先の確認（ステップ C） | specs/wizard.md | 実装済み |
| WIZ-11 | 拡張機能の読み込み案内（ステップ D） | specs/wizard.md | 実装済み |
| WIZ-12 | 接続の確認（ステップ E） | specs/wizard.md | 実装済み |
| WIZ-13 | キーボード操作とアクセシビリティ | specs/wizard.md | 実装済み |
| INS-01 | インストーラの形式と識別 | specs/installer.md | 実装済み |
| INS-02 | コード署名なし（未署名） | specs/installer.md | 実装済み |
| INS-03 | Desktop ショートカット（任意） | specs/installer.md | 実装済み |
| INS-04 | アンインストール時の Collector 連携の後始末 | specs/installer.md | 実装済み |
| INS-05 | アンインストール時のデータの保持 | specs/installer.md | 実装済み |
| INS-06 | Collector のペイロードの同梱 | specs/installer.md | 実装済み |
| LIC-01 | Desktop のライセンスは AGPL-3.0-or-later | specs/license.md | 未着手 |
| LIC-02 | 貢献者同意（CLA 相当）を置く | specs/license.md | 未着手 |
| LIC-03 | TRADEMARKS（名称・ロゴの扱い） | specs/license.md | 未着手 |
| LIC-04 | Collector（別リポジトリ）の MIT の扱い | specs/license.md | 未着手 |

合計 40 要件（COL 17、WIZ 13、INS 6、LIC 4）。実装済み 36、未着手 4、検証済み 0、廃止 0。

## テストが無い要件
- INS-02（未署名）、LIC-01〜LIC-04：テストなし。

## 要確認の重点（詳細は各ファイル末尾）
1. 解決：PO 判断（2026-11-25）で、対応ブラウザーは Chrome と Edge の 2 つ、コードを正とする（collector.md 冒頭、#1）。
2. 解決：PO 指示で、完了画面に任意の案内を実装（WIZ-02、94d82f9）。
3. ライセンスの実装は PR #112 のブランチにあり、基準ブランチは MIT のまま（license.md #1）。
4. 解決：PO 判断（2026-11-25、D075）で CLA 相当を採用（license.md #2）。
5. D074「進めない」と、ウィザードの Vivaldi の抜け道コードの関係（wizard.md #3）。
6. 未署名・SmartScreen の注意書きは README.md:43 にある。導入ガイドに実行手順まで書くかは未決定（installer.md #3）。
