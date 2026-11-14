# MAGINALIA desktop α1 "Before Kaldi"

[English README](README_en.md)

**MAGINALIAは、日本語で読む、引用する、書くためのデスクトップエディタです。**

本や資料から集めた引用を整理し、メモや下書きをレポート、論考、作品へとつなげます。主に日本語で読書・研究・執筆を行う学生、研究者、書き手を想定しています。

文書や引用は原則として自分のPCに保存します。Git、ターミナル、プログラミングIDEの知識がなくても使い始められることを目指しています。

> **公開状況:** Windows x64向けのα1（バージョン0.1.0）「Before Kaldi」を一般公開する準備を進めています。α版のため、不具合や仕様変更が生じる可能性があります。UIの一部には英語表記が残っています。

## ダウンロードと関連リンク

- **Windows版ダウンロード:** 一般公開準備中。公開後、公式の配布リポジトリのGitHub Releasesをご案内します。
- **公式サイト:** 準備中
- **取扱説明書:** インストーラーに日本語PDFを同梱しています。原稿のコピーは[こちら](assets/マニュアル.pdf)。
- **MAGINALIA Capture:** 近日公開。現在配布するDesktop α1とは別の製品です。
- **公式Discord:** [MAGINALIA Community](https://discord.gg/RbDJ8DtF7b)
- **作者のX（旧Twitter）:** [@Shishow_of_PO](https://x.com/Shishow_of_PO)

一般利用者は、このソースコードをダウンロードしたり、開発環境を構築したりする必要はありません。

## MAGINALIAでできること

- **Workdesk / Project:** 研究や作品ごとに文書と資料をまとめます。
- **Markdownエディタ:** 複数の文書をタブで開き、編集・プレビューできます。縦書き表示にも対応しています。
- **Private Shelf:** 書籍・資料の情報と引用をPC内で整理し、検索して文書に利用できます。
- **Reviewer:** 引用や注釈を確認し、Private Shelfに保存します。
- **参考文献とSynced Block:** 引用元の情報を確認し、ほかの文書の内容を参照できます。
- **ファイルの書き出し:** Markdown、PDF、DOCXに対応しています。PDF/DOCXでは、Project内のPNG・JPEG・WebP画像を取り込めます。
- **任意の文字認識:** インストール時にNDLOCR-Lite 1.3.1を追加すると、画像からの文字認識をPC内で実行できます。追加しなくても基本機能は使えます。
- **ローカル保存と履歴:** 編集内容を自動保存し、ローカルのGitベースの履歴を扱います。

MAGINALIAはクラウドへの自動同期を前提としません。α1では、GitHubへの接続やリモート同期機能は一般利用者向けに提供していません。

## インストールと注意事項

**対応環境:** Windows x64。ほかのOS向けのインストーラーは今回提供しません。

公開後は公式の配布先から`MAGINALIA-desktop-0.1.0-Setup.exe`を入手し、画面の案内に沿ってインストールしてください。NDLOCR-Liteの追加は任意で、初期状態では選択されていません。

**インストーラーはコード署名されていません。** Windows Defender SmartScreenなどが警告を表示したり、実行を制限したりする場合があります。配布元と公開されるSHA-256を確認し、信頼できる場合にのみ実行してください。SHA-256は改ざん・取り違えの確認に役立ちますが、発行元の身元を証明するものではありません。

α版のため、重要な文書や引用は定期的にバックアップしてください。Workdesk、Project、Private Shelfはアプリ本体とは別の場所に保存し、アンインストール時にも残す設計です。ただし、削除や再インストールの前にはバックアップを推奨します。

Markdownの書き出しは単一の`.md`ファイルです。参照先の画像は同梱されないため、ほかのPCへ移すときは画像ファイルとパスを別途管理してください。

## 開発者・コントリビューター向け

この`MAGINALIA_ALPHA`リポジトリは、独立したElectron + Monacoデスクトップアプリの**開発用ソース**です。一般向けインストーラーの配布場所ではありません。開発・検証用の内容があり、インターフェースや内部APIが変わることがあります。

MAGINALIAは、通常のローカルファイルを研究データの正本とするローカルファーストの設計を採用しています。Markdown、YAML、JSON、画像、Gitベースの履歴を扱い、ユーザーの原稿や研究データをアプリ固有の不透明な保存形式に閉じ込めないことを重視しています。AIサービスの接続は必須ではありません。

### 主なディレクトリ

```text
MAGINALIA_ALPHA/
├─ apps/desktop/          # Electronデスクトップアプリ
├─ packages/format/       # データ形式の契約
├─ packages/repository-core/
├─ packages/source-core/
├─ packages/writing-core/
├─ sidecars/reviewer/     # 引用・注釈のReviewer
├─ mods/                  # Mod実験
├─ spec/                  # データ形式のスキーマ
├─ docs/                  # 実装・契約の資料
├─ memory/                # 開発コンテキスト
├─ package.json
└─ package-lock.json
```

### 開発環境

このリポジトリはnpm workspaceです。開発者向けの基本コマンドは次のとおりです。

```bash
npm ci
npm run typecheck
npm run build
npm test
npm start
```

追加の検証には`npm run smoke`、`npm run smoke:writing`、`npm run smoke:workspace`、`npm run smoke:shelf`、`npm run smoke:export`などを使用できます。正確な依存バージョンは各package manifestと`package-lock.json`を参照してください。

実装・設計変更の前に[AGENTS.md](AGENTS.md)を読み、[MAGINALIA_IDEのDecision Log](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/09_DECISION_LOG.md)と[α版の開発計画](https://github.com/potoha/MAGINALIA_IDE/blob/main/plan/27_ALPHA_CLOSE_SLICE_SEQUENCE.md)の関連事項を確認してください。これらのリンク先は開発関係者向けのPrivateリポジトリである場合があります。

過去の実装は`potoha/MAGINALIA_IDE`、`potoha/MY_marginallia`、`potoha/Uttate-writer`などにあります。`potoha/toybox`はこのプロジェクトからは参照専用です。いずれも現行α1の実装先ではありません。

**安全境界:** アプリのローカルGit履歴と、GitHub等へのリモート同期は別の機能です。認証、リモートfetch/push、復元などの製品機能は現行α1では凍結されています。開発作業のGit操作とは区別してください。

## License

- MAGINALIA 0.2.0 以降: [GNU Affero General Public License v3.0 or later](LICENSE)（AGPL-3.0-or-later）
- MAGINALIA 0.1.x 以前: MIT License（[LICENSE-MIT-0.1.txt](LICENSE-MIT-0.1.txt)）。0.1.x のライセンスは変わりません。
- 著作権者は、AGPLの条件では利用できない組織向けに、別途商用ライセンスを提供することがあります。お問い合わせ: [GitHub Issues](https://github.com/potoha/MAGINALIA_desktop/issues)
- 「MAGINALIA」の名称とロゴの扱いは [TRADEMARKS.md](TRADEMARKS.md) を参照してください。
- 貢献を希望する方は [CONTRIBUTING.md](CONTRIBUTING.md) を読んでください。

### 要点（法的な保証ではありません）

- 自由に使用・改変・再配布できます。
- 改変版を配布する場合、またはネットワーク経由でサービスとして提供する場合は、その改変版のソースコードを同じAGPLの条件で利用者に提供する必要があります。
- フォークは歓迎します。改善はぜひ upstream に送ってください。

第三者のライブラリやNDLOCR-Liteなどのコンポーネントには、それぞれのライセンスが適用されます。

MAGINALIAで作成・編集した原稿、ノート、引用やその他のユーザーデータに、ソフトウェアのライセンスが自動的に適用されることはありません。

Copyright (C) 2026 MADA 5sounds (go-on) / beyond the Word.
