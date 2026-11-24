# ライセンス表記（AGPL-3.0-or-later、CLA なし、TRADEMARKS）

- 機能の略称：LIC（要件 ID の接頭辞）
- 追加バージョン：v0.2.0
- 状態：**下書き**。ユーザー確認前。「検証済み」は最終チェック後のみ付ける。
- 基準：決定は `D:\python\MAGINALIA_IDE\plan\09_DECISION_LOG.md:108`（D073）。実装は Desktop PR #112 のブランチ `codex/license-agpl-0.2`（worktree `D:\codex\worktree\license-agpl-desktop`、先頭 `9d34c69`）にあり、**この下書きの基準ブランチ `codex/mb-s8-b4-wiring` には入っていない**（`git merge-base --is-ancestor 9d34c69 HEAD` が偽）。基準ブランチの `LICENSE` は MIT のまま。
- 下の「関連コード」は、特記がない限り `D:\codex\worktree\license-agpl-desktop` 側のパス。

## 実装方針
- D073：0.2.x の Desktop のライセンスを AGPL-3.0-or-later とする。CLA（署名の仕組み）は 0.2.0 では導入しない。フォーク時のフォーク元の明記は依頼（強制ではない）、AGPL の著作権・ライセンス表示の保持は義務として区別する。ADR は未作成で、D073 は暫定。
- 0.1.x の MIT は変えない。MAGINALIA の名称・ロゴは AGPL の許諾対象外とし、`TRADEMARKS.md` に定める。
- 「実機」欄：この機能は文書とメタデータだけで、実機の操作は無い。インストーラに表示するライセンス画面は、文書に要件が無いため扱わない。

## 要件

### LIC-01 Desktop のライセンスは AGPL-3.0-or-later
- 受け入れ条件：
  - リポジトリ直下の `LICENSE` は GNU Affero General Public License v3 の全文になる。
  - `apps/desktop/package.json` ほか、公開パッケージの `license` は `AGPL-3.0-or-later`。
  - README の License 節は、0.2.0 以降が AGPL-3.0-or-later、0.1.x 以前が MIT（`LICENSE-MIT-0.1.txt`）であることを書く。
  - `NOTICE` は、0.2.0 以降が AGPL-3.0-or-later であること、0.1.x が MIT のままであること、名称・ロゴが許諾対象外であること、利用者のデータの所有権を主張しないことを書く。
  - 実機: 未確認
- 関連コード：LICENSE:1-3；LICENSE-MIT-0.1.txt；README.md:93-97；NOTICE:6-25；apps/desktop/package.json:4；packages/format/package.json:5
- テスト：テストなし
- 状態：未着手
- 備考：基準ブランチでは `LICENSE` が MIT（`LICENSE:1`）、`NOTICE` が MIT（`NOTICE:6`）、`README.md:95` が MIT と書く。PR #112（Draft）がマージされるまで、この要件は基準ブランチでは満たされない。状態は基準ブランチの現状に合わせて「未着手」にした（PR #112 のブランチだけで見れば実装済み）。要確認 #1。

### LIC-02 CLA を導入しない
- 受け入れ条件：
  - リポジトリに CLA を求める自動の仕組み（CLA Assistant などのワークフロー）が無い。
  - `CONTRIBUTING.md` は、貢献が AGPL-3.0-or-later で公開されること、フォークが自由であることを書く。
  - 実機: 未確認
- 関連コード：CONTRIBUTING.md:16-22；`.github/workflows`（無い）；`.github/PULL_REQUEST_TEMPLATE.md:5`
- テスト：テストなし
- 状態：未着手
- 備考：ブランチ内の履歴では、CLA の自動化（`41f535f`）が追加され、後に外された（`d25e59d` 「drop the CLA」）。現在 `.github/workflows` は無い。ただし `CONTRIBUTING.md:20` は、PR を送ることで、マージされた部分の著作権を無償で譲渡し、著作者人格権を行使しないことに同意したものとみなす、と書き、PR テンプレート（`.github/PULL_REQUEST_TEMPLATE.md:5`）に同意のチェックボックスを置く。D073 の「署名の仕組みなし。権利者の表明は CONTRIBUTING 等の一文のみ」と合うかは要確認 #2。

### LIC-03 TRADEMARKS（名称・ロゴの扱い）
- 受け入れ条件：
  - `TRADEMARKS.md` があり、保護対象を「MAGINALIA」「MAGINALIA Collector」などの製品名、MAGINALIA のロゴ、「beyond the Word.」の名称とロゴとして列挙する。
  - 許可なく使えるものとして、公式版を改変せずに再配布するときの公式の名称、事実を正確に述べる言及、レビュー・記事・論文・教育での紹介を挙げる。
  - 許可が必要なものとして、改変版・フォーク版の製品名・サービス名・ドメイン名・ロゴとしての使用、公式・提携・推奨の誤認を与える使い方、有償サポートなどでの名称・ブランドとしての使用を挙げる。
  - アイコンと名前を差し替えれば、改変版・フォーク版は AGPL-3.0-or-later の範囲で自由に再配布できると書く。
  - フォーク元の明記は「お願い（義務ではありません）」、AGPL の著作権表示・ライセンス表示の保持は「ライセンス上の義務」と書き分ける。
  - 問い合わせ先は GitHub Issues。
  - README と `NOTICE` が `TRADEMARKS.md` へリンクする。
  - 実機: 未確認
- 関連コード：TRADEMARKS.md:1-30（日本語）、:31 以降（English）；README.md:98；NOTICE:11-15
- テスト：テストなし
- 状態：未着手
- 備考：基準ブランチに `TRADEMARKS.md` は無い。基準ブランチの `NOTICE` は商標を MIT の対象外とする表現（`NOTICE:7-12`）。

### LIC-04 Collector（別リポジトリ）の MIT の扱い
- 受け入れ条件：
  - `NOTICE` は、MAGINALIA Collector（別リポジトリ `potoha/MAGINALIA-Collector`）が MIT License であり、MAGINALIA に同梱された Collector の複製もそのライセンスを保つ、と書く。
  - 同梱の Collector の拡張機能と Host のライセンス表記（`LICENSE.txt`・`NOTICE.txt`・`NODE-LICENSE.txt`）が、`resources/collector-host/` に入る。
  - 実機: 未確認
- 関連コード：NOTICE:17-19；apps/desktop/packaging/electron-builder.json:25（基準ブランチ）
- テスト：テストなし
- 状態：未着手
- 備考：`NOTICE` の記述は PR #112 のブランチだけにある。同梱ファイルの配置は基準ブランチで実装済み（INS-06）。

## 要確認（コードと文書の食い違い・文書にない点。仕様には書いていない）
1. PR #112（`codex/license-agpl-0.2`）は基準ブランチに含まれない。0.2.0 のリリースに載せる前提だが、いつマージするかは文書に無い（引継ぎ v4 §9-5「ライセンス（#112）の判断」）。また、そのブランチの `apps/desktop/package.json` は version `0.1.0`、基準ブランチは 0.2.0 のため、マージ時に衝突し得る（未確認）。
2. D073「CLA は 0.2.0 では導入しない。署名の仕組みなし。権利者の表明は CONTRIBUTING 等の一文のみ」と、`CONTRIBUTING.md:20` の著作権譲渡への同意（PR テンプレートのチェックボックスつき）は、同じ意味かが不明。D073 の備考は「署名なしの権利表明は第三者貢献の著作権譲渡にならないため、外部のコード貢献を受ける前に再検討する」と書く。LIC-02 の受け入れ条件は「CLA 自動化なし」だけにし、譲渡の同意文の可否は判断しなかった。
3. D073 は ADR 作成までの暫定。「ライセンス変更は ADR が必要」（`AGENTS.md`）だが、ADR は未作成（`docs/decisions/` に 0001・0002 のみ。MAGINALIA_IDE 側は未確認）。
4. 新規ファイルへの SPDX ヘッダ（`CONTRIBUTING.md` の進め方 4）が実際に付いているかは、この調査では確認していない（`apps/desktop/src/*.ts` で `SPDX-License-Identifier` を含むファイルは 0 件）。要件にはしていない。
5. 商用ライセンスの提供（README.md:97）、`beyond the Word.` の権利者の表記（`NOTICE:3`「MADA 5sounds (go-on)」）は、D073 に書かれていない。要件にしていない。
6. インストーラや製品内にライセンスを表示する要件は、読んだ文書に無い。
