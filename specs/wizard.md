# Collector 連携ウィザード（ブラウザー選択・ボタン順・おすすめ）

- 機能の略称：WIZ（要件 ID の接頭辞）
- 追加バージョン：v0.2.0
- 状態：**下書き**。ユーザー確認前。「検証済み」は最終チェック後のみ付ける。
- 基準：ブランチ `codex/mb-s8-b4-wiring`（`d52feb9`）の `apps/desktop/`。パスは特記がなければここからの相対パス。

## 実装方針
- 根拠文書：`docs/collector-wizard-integration-design.md` §4・§5、引継ぎ `docs/handoff-collector-wizard-s8-2026-11-23-v4.md`（§2、§5、§10）、`D:\python\MAGINALIA_IDE\plan\09_DECISION_LOG.md` の D074。
- ウィザードは 1 つのパネル。手順は A（ブラウザー選択）→ B（連携プログラムの登録）→ C（保存先の本棚）→ D（ブラウザーへの読み込み）→ E（接続確認）→ 完了。画面の状態遷移は純粋なモデル（`collector-wizard-model.ts`）に置き、描画は `collector-wizard-panel.ts`。
- 設計書 §4 は Chrome のみを前提に書かれている。ブラウザーの選択肢・おすすめ・ボタン順は、Product Owner の指示（2026-11-23、引継ぎ v4 §5）と実装が正本で、設計書には書き戻されていない。
- 「実機」欄：パッケージ版の実機での描画・操作は、引継ぎ v4 の時点で未確認（「実 Electron での描画（ボタン行の折り返し、おすすめ表示）」は未確認と明記）。

## 要件

### WIZ-01 ウィザードの開き方
- 受け入れ条件：
  - コマンド `maginalia.collector.setup` または `maginalia.collector.repair` を実行すると、ウィザードのパネルが開く。
  - ウィザードに必要な 2 つの機能（Collector 連携の実行と保存先の設定）が preload に無い環境では、「Collector 連携はこの環境では使えません。」を報告し、パネルは開かない。
  - 「あとで設定」でパネルを閉じても、何も書かない。
  - 実機: 未確認
- 関連コード：src/renderer/collector-integration-commands.ts:50-69（`createCollectorWizardOpener`）、:154-170；src/renderer/collector-wizard-controller.ts:73（`openCollectorWizard`）
- テスト：src/renderer/collector-integration-commands.test.ts；src/renderer/collector-wizard-controller.test.ts
- 状態：実装済み

### WIZ-02 初回セットアップ完了画面からの任意の案内
- 受け入れ条件：
  - 初回セットアップの完了カードに、見出し「ブラウザー拡張 Collector（任意）」と案内文、「Collector を設定する」ボタンが出る。
  - ボタンを押したときだけ、既存の Collector ウィザードが 1 回開く。押すまで開かず、何も書き込まない。
  - ボタンを押さずに「MAGINALIAを開く」で進めても、初回セットアップは従来どおり完了する。
  - ウィザードの起動手段が使えない環境では、案内の節を出さない。
  - 案内文は特定のブラウザー名（Edge など）や「おすすめ」を含まない。
  - 実機: 未確認（完了カードの上でウィザードのダイアログが正しく出るか、初回セットアップ直後に実行できるか）
- 関連コード：src/renderer/first-run-collector-guide.ts（案内文と結びつけ）、src/renderer/main.ts:503-507（完了カードの節）、:534-547（起動関数の再利用と表示）、src/renderer/style.css
- テスト：src/renderer/first-run-collector-guide.test.ts（4 件。押すまで開かない／押すと 1 回開く／起動関数なしで非表示／例外時のエラー表示／本文がブラウザーに偏らない）。main.ts の DOM 組み立ては対象外。
- 状態：実装済み
- 備考：PO 指示（2026-11-25）で追加。コミット 94d82f9。

### WIZ-03 手順の構成と進捗表示
- 受け入れ条件：
  - 手順は A・B・C・D・E・完了の順で、A〜E の各画面に「手順 n / 5」（A=1 … E=5）が文字で出る。完了画面には出ない。
  - 保存先の本棚の確認（C）は、ブラウザーへの読み込み（D）より前に行う。
  - 実機: 未確認
- 関連コード：src/renderer/collector-wizard-model.ts:81（`WizardStepId`）、:1231-1249（`wizardStepNumber`・`wizardProgress`）；src/renderer/collector-wizard-copy.ts:508-640
- テスト：src/renderer/collector-wizard-model.test.ts:223、:386、:604、:655、:758
- 状態：実装済み

### WIZ-04 ブラウザーの選択肢（ステップ A）
- 受け入れ条件：
  - 選択肢の並びは「通常のブラウザーで登録（{名前}）」、「Chrome で登録」、「Edge で登録」の順で固定。表の順ではない。
  - 「通常のブラウザーで登録」は、既定ブラウザーが検証済みで、Chrome でも Edge でもない（=Vivaldi）ときだけ出す。既定が Chrome か Edge のときは出さない（同じブラウザーが 2 回並ばない）。
  - 既定ブラウザーが Firefox などの非 Chromium、Brave などの未検証の Chromium、不明、または未導入のときは、「通常のブラウザー」を出さず、Chrome と Edge だけを並べる。
  - 導入されていないブラウザーは並べない。組織の policy でブロックされたものは並べるが選べない。
  - 対応ブラウザーが 1 つも導入されていないときは、選択肢を出さず、ダウンロードのボタンと「ブラウザーは入っています（このまま続ける）」を出す。
  - 実機: 未確認
- 関連コード：src/renderer/collector-wizard-model.ts:262-366（`wizardDefaultOptionId`、`wizardOptionFor`、`wizardBrowserOptions`）、:1493（`wizardAView`）；src/renderer/collector-wizard-copy.ts:462-470
- テスト：src/renderer/collector-wizard-model.test.ts:1605-1780（step A choices の表）、:1336
- 状態：実装済み
- 備考：Vivaldi が導入済みで既定ではなく、Chrome と Edge が未導入のとき、Vivaldi を名前つきで出す抜け道がある（model.ts:301-309。コメントに「owner decision 2026-11-24」）。D074 との整合は要確認 #3。

### WIZ-05 おすすめと初期選択
- 受け入れ条件：
  - 既定ブラウザーが、検証済み・導入済み・policy でブロックされていない、のすべてを満たすとき、その選択肢にだけ「 — おすすめ」が付き、初期選択になる。
  - それ以外（既定が未導入・不明・非対応・ブロック済み）のとき、おすすめは付かず、初期選択もなし。「次へ」は選ぶまで押せない。
  - 既定が Chrome、Edge、Vivaldi のとき、おすすめは順に Chrome、Edge、Vivaldi（Vivaldi は「通常のブラウザーで登録（Vivaldi） — おすすめ」）。
  - Edge を自動でおすすめにしたり、文言で Edge をすすめたりしない。
  - 実機: 未確認
- 関連コード：src/collector-browser-table.ts:359-384（`recommendCollectorBrowser`）、:386-400（`defaultReason`）；src/renderer/collector-wizard-model.ts:313、:1499-1531；src/renderer/collector-wizard-copy.ts:462
- テスト：src/collector-browser-table.test.ts:229、:304；src/renderer/collector-wizard-model.test.ts:1605-1780
- 状態：実装済み
- 備考：引継ぎ v4 §10 の表と同じ内容。軽微な未対応：ラベルの括弧の重なり、「前回は {名前} を選びました。」が今は出していない選択肢を指す場合（引継ぎ v4 §10「軽微」）。

### WIZ-06 既定ブラウザー別の案内文（reason）
- 受け入れ条件：
  - 理由は 8 種：`default-supported`、`default-unsupported`（組織 policy のブロック専用）、`default-not-chromium`、`default-unverified`、`default-not-installed`、`default-unknown`、`none-installed`、`detection-failed`。
  - 既定が Firefox など非 Chromium のとき `default-not-chromium`：「ふだんお使いのブラウザーは、Collector に対応していません。」と「Collector は Chromium 系のブラウザーでだけ使えます。…」を出す。
  - 既定が Brave など未検証の Chromium のとき `default-unverified`：「ふだんお使いのブラウザーでは、Collector の動作をまだ確認していません。」と「下の選択肢から、Chrome か Edge を選んでください。」を出す。
  - 対応ブラウザーが無いとき `none-installed`：「対応しているブラウザー（Microsoft Edge、Google Chrome、Vivaldi）が見つかりませんでした。」を出す。
  - どの理由の文言も、特定のブラウザーをおすすめする文を含まない（`default-supported` の「…に Collector を入れることをおすすめします。」を除く）。
  - 実機: 未確認
- 関連コード：src/collector-browser-table.ts:344-357（理由の型）；src/renderer/collector-wizard-copy.ts:208、:473-504
- テスト：src/renderer/collector-wizard-copy.test.ts；src/renderer/collector-wizard-model.test.ts:1605
- 状態：実装済み
- 備考：`default-supported` の detail には「おすすめします」が残る。これは既定ブラウザーに対する文で、設計の方針（既定だけにおすすめ）と矛盾しない。

### WIZ-07 ボタンの並び順
- 受け入れ条件：
  - すべての画面で、ボタンは左から「戻る」、「あとで設定」、その他の操作、主操作（右端）の順に並ぶ。その他の操作どうしは、画面ごとに定めた追加順を保つ。
  - 「戻る」「あとで設定」は主操作より右に来ない。
  - ボタンの DOM 順と Tab 順が一致する（ツール行とナビ行を 1 行にまとめる）。
  - 保存先の失敗画面と busy 画面は、「保存先を選び直す」「キャンセル」「もう一度試す」の順（主操作が右端）。
  - 実機: 未確認（狭い幅での折り返しは未確認）
- 関連コード：src/renderer/collector-wizard-model.ts:1319（`wizardActions`）、:1452-1455（並べ替え）；src/renderer/collector-wizard-panel.ts（ボタン行）
- テスト：src/renderer/collector-wizard-model.test.ts:1524；src/renderer/collector-wizard-panel.test.ts；src/renderer/collector-wizard-view.test.ts
- 状態：実装済み
- 備考：「ツール行とナビ行の統合」を直接アサートするテストの有無は未確認。

### WIZ-08 登録の結果表示（ステップ B）
- 受け入れ条件：
  - 「連携プログラムを登録する」を押すと `setup` を 1 回実行する。実行中は他の操作を受け付けず、別の操作が実行中のときは「別の Collector 連携の操作を実行中です。」と出す。
  - 成功したとき「…登録しました。」、すでに最新のとき「…登録済みです」、更新したとき「…更新しました」を出す。
  - 他者の登録（foreign）があるときは、置き換えてよいか確認し、「切り替える」を押したときだけ置き換える。「やめる」では何も書かない。
  - 組織の policy でブロックされているときは、何も書かず、閉じるだけにする。
  - 登録先が自分のものでないとき（例：Vivaldi が読む Chromium キーを他者が持つ）は、成功表示の代わりに警告（`registered-not-effective`、role=alert）を出し、先へ進めるようにする。
  - 解除を依頼済みで取り消していないときは、「解除を取りやめる」ボタンを出す（COL-06）。
  - 実機: 未確認
- 関連コード：src/renderer/collector-wizard-model.ts:486-518、:945；src/renderer/collector-wizard-copy.ts:508-515、:600-640
- テスト：src/renderer/collector-wizard-model.test.ts:386、:529、:1050、:1781
- 状態：実装済み
- 備考：引継ぎ v4 §10 の要確認 1（Vivaldi の実効登録）に対する警告（`registered-not-effective`）が入っていることをテスト（:1781）で確認。残りの未決は要確認 #3。

### WIZ-09 policy でブロックされた場合（D074）
- 受け入れ条件：
  - Chrome が policy でブロックされ、Edge が未導入で、Vivaldi が導入済みのとき、ウィザードは先へ進めない（選べる選択肢が無い）。
  - 検証済みのすべてのブラウザーが policy でブロックされているとき、ステップ A は「組織の管理設定により…使えません」を表示し、登録を行わない。
  - 実機: 未確認
- 関連コード：src/renderer/collector-wizard-model.ts:393-410（`wizardBlockedBrowsers`、`wizardAllBrowsersBlocked`）、:615、:1339；src/collector-integration-service.ts:361-367
- テスト：src/renderer/collector-wizard-model.test.ts:1336
- 状態：実装済み
- 備考：D074（2026-11-24）：「進めない」で確定、コード変更なし。引継ぎ v4 §10 の要確認 2b・3（Vivaldi が使えるのに進めない、Vivaldi が「選択可」なのに「すべて block」と表示）は D074 により扱いが決まったと読めるが、文書には明記がない（要確認 #3）。

### WIZ-10 保存先の確認（ステップ C）
- 受け入れ条件：
  - 「保存先を確認する」を押すと、既存の保存先設定コマンドを実行する（COL-10）。結果が `configured` または `already-configured` のとき「保存先を設定しました。」を出す。
  - 結果が `cancelled` のとき、「保存先は設定されていません。…」を出し、「もう一度確認する」「次へ」「あとで設定」を選べる。
  - 設定フォルダーの所有者・権限を確認できず書込みが無効のとき、「次へ（保存は無効のまま）」を選べる。
  - 実機: 未確認
- 関連コード：src/renderer/collector-wizard-model.ts:604 以降（step C の遷移）；src/renderer/collector-wizard-copy.ts:516-525；src/renderer/collector-wizard-controller.ts
- テスト：src/renderer/collector-wizard-model.test.ts:604、:1224
- 状態：実装済み

### WIZ-11 拡張機能の読み込み案内（ステップ D）
- 受け入れ条件：
  - ステップ D に入ると、拡張機能のフォルダーを用意し、選んだブラウザーの名前で手順 5 つ（拡張機能の画面を開く、デベロッパー モード、パッケージ化されていない拡張機能を読み込む、フォルダーの選択、一覧の確認）を表示する。
  - ［パスをコピー］でフォルダーのパスをクリップボードにコピーし、［フォルダーを開く］でフォルダーを開く。パスは画面に表示しない。
  - ［拡張機能の画面を開く］を押すと、表の行から決めた拡張機能ページをそのブラウザーで開く。開けなかった場合は、アドレスを入力する案内を出す。
  - ご注意として、プロフィールの使い分け、デベロッパー モードをオンのままにすること、読み込んだ Collector を削除しないこと（保留中の引用も消える）を表示する。
  - 実機: 未確認。拡張機能の画面を `chrome://extensions/`・`edge://extensions/` のアドレスで直接開く方法は、2026-11-22 の実機で「新しいタブになり開かない」と確認（引継ぎ v4 §4）。
- 関連コード：src/renderer/collector-wizard-copy.ts:526-570；src/renderer/collector-wizard-model.ts:1559（`wizardStepDView`）；src/collector-integration-service.ts:388-426
- テスト：src/renderer/collector-wizard-model.test.ts:655；src/renderer/collector-wizard-copy.test.ts
- 状態：実装済み
- 備考：Vivaldi の拡張機能ページの UI ラベルと、ドラッグ＆ドロップの動作は未確認（引継ぎ v4 §10）。

### WIZ-12 接続の確認（ステップ E）
- 受け入れ条件：
  - 接触記録（COL-09）を 2 秒ごとに確認し、拡張機能の版が MAGINALIA の付属版と同じなら「MAGINALIA Collector から接続を確認しました。」と、保存先の「設定済み」または「未設定（保存は保留されます）」を表示する。
  - 拡張機能の版が付属版と違うときは、版の違いと更新方法を案内する。プロトコルが違うときは「Collector と MAGINALIA の版が合わないため、接続できません。」を表示する。
  - 3 分（180,000 ms）で接続が確認できないとき、「まだ接続を確認できません。」と確認項目（拡張機能の一覧、ID `blgmoddncpknfnikdfnjelmdmphfgknf`、「はじめに」画面の表示）を出す。
  - 利用者が「「準備ができました」と表示されている」を押して終えたときは、「Collector の設定を終了しました。MAGINALIA からは接続を確認できていません。…」と表示し、確認済みとは表示しない。
  - 自動で次の手順へ進まない。ポーリング中にフォーカスを動かさない。
  - 実機: 未確認
- 関連コード：src/renderer/collector-wizard-model.ts:66-68、:84-91、:145-146、:1601（`wizardConnectionView`）、:1634（`wizardDoneView`）；src/renderer/collector-wizard-copy.ts:571-625；src/collector-integration-service.ts:179-208（`summarizeConnection`）
- テスト：src/renderer/collector-wizard-model.test.ts:758、:942、:1468
- 状態：実装済み

### WIZ-13 キーボード操作とアクセシビリティ
- 受け入れ条件：
  - パネルはラベル付きのダイアログで、手順が変わるとフォーカスが見出し（`tabindex="-1"`）へ移る。
  - 進行・結果は `role="status"`（`aria-live="polite"`）、失敗は `role="alert"` に出る。
  - すべての操作は文字ラベルのついた `<button>` で、Tab で到達でき、Enter か Space で実行できる。ブラウザーの選択肢は `radiogroup`（ローヴィング tabindex、矢印キーで移動）。Tab はダイアログの外へ出ない。
  - Esc は「あとで設定」と同じ扱いで、完了済みの書込みを黙って取り消さない。
  - 実機: 未確認
- 関連コード：src/renderer/collector-wizard-panel.ts:8-12、:104-116、:405-413、:490
- テスト：src/renderer/collector-wizard-panel.test.ts；src/renderer/collector-wizard-view.test.ts；src/renderer/collector-wizard-model.test.ts:339、:942
- 状態：実装済み

## 要確認（コードと文書の食い違い・文書にない点。仕様には書いていない）
1. 設計 4.1 は「初回セットアップの完了カードに Collector の案内を加える」。実装には該当する参照が見つからない（`src/first-run-*.ts` と `src/renderer` の初回セットアップ関連に Collector 無し）。新規インストールの利用者が Collector の設定へ到達するのは、メニューまたはコマンドだけに見える。α1 からの利用者は移行通知（COL-11）で案内される。「初回ウィザード」の範囲に初回セットアップとの連携を含めるかを確認したい（WIZ-02 は未着手として残した）。
2. 設計書 §4（Chrome のみ前提）と、実装・引継ぎ v4 §5・§10（Chrome／Edge／Vivaldi、選択肢 3 つ、おすすめは既定のみ、ボタン順）が異なる。設計書・正本計画への書き戻しは引継ぎ v4 §10「未確認」で未実施。受け入れ条件は引継ぎ v4 と実装テストに合わせた。
3. D074 は「Chrome が policy でブロック・Edge 未導入・Vivaldi 導入済みは進めない」と定める。一方、model.ts:301-309 は、選べる選択肢が無いとき Vivaldi を名前つきで並べる抜け道を持つ（コメントに「owner decision 2026-11-24」）。Vivaldi は借用先の Chrome キーがブロックされるため選択不可になり、結果は「進めない」になるはずだが、この組み合わせを直接検証するテストが見つからない（引継ぎ v4 §10「取りこぼし：Vivaldi 既定 + Chrome policy block + setup」、「要確認 2b のテスト」）。
4. 設計 4.2 の「ステップ A」の文言（「Chrome で集めた引用を本棚へ」など）は実装で「ブラウザーで…」に変わっている。設計 4.5 の画面文言は「実際の Chrome のスクリーンショットで確認する」とされるが、その確認の記録は見つからない（引継ぎ v4 §10 でも Vivaldi の UI ラベルは未確認）。
5. 引継ぎ v4 §10「軽微（未対応）」：ラベルの括弧の重なり、対応ブラウザー一覧と none-installed のダウンロードボタンが Edge 先頭の名残、`multiBrowserNote` の「おすすめ」の語、「前回は…」が今ない選択肢を指す場合。仕様には含めていない。
