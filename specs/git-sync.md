# バックアップ・同期（Git/GitHub バックアップ）

- 機能の略称：SYNC（要件 ID の接頭辞）
- 追加バージョン：未定（#38 EPIC / #65。本ファイルは第1ブロック PR の範囲だけを書く）
- 状態：**下書き**。ユーザー確認前。「検証済み」は最終チェック後のみ付ける。
- 要件の正本：#65 のコメント（2026-11-27）。本ファイルは、#136（S1）と #137（S2）に関係する要件だけを載せる。他の SYNC 要件は、対応するスライスの PR で追記する。

## 実装方針
- 本 PR はネットワーク、Electron、isomorphic-git を使わない純ロジックだけ。置き場所は `apps/desktop/src/sync/`。
- S1：状態の導出（接続・関係・ローカルの3軸 → 表示状態）、Sync の判定表、固定の日本語文言、Command ID の定数。Command Registry への登録は S9。
- S2：machine-local の `sync-remotes.json`（保存先ディレクトリは引数で渡す）。フォルダの対応は `.magi` の UUID で取り、登録時のフォルダの場所（正規化済みルート）を一緒に記録する。同じ UUID が別の場所に現れたら「確認が必要」を返し、接続先を渡さない。
- リスク：`root` の項目は、要件の項目一覧（SYNC-02）に無い追加項目。コピーの検出のために machine-local にだけ置く。
- 表示文言の補足の文（原因ごとの 1 文など）は、草案に文が無いため本 PR で起こした案。

## 要件

### SYNC-01 1 フォルダ = 1 リモートの対応
- 受け入れ条件：同じ `folderId` の登録は 1 件だけ保持される。同じ `folderId` を別の場所から登録しようとすると、既存の登録を変えずに `needs-review` を返す。
- 関連コード：`apps/desktop/src/sync/sync-remotes.ts:124`（`register`）
- テスト：`apps/desktop/src/sync/sync-remotes.test.ts`（「updates the entry for the same folder instead of duplicating it」「refuses to register the same UUID at a second location」）
- 状態：未着手
- 備考：対応表の側だけ本 PR で実装。リモートの作成（private repo、repo 名、種別ごとの除外）は S5。

### SYNC-02 `.magi` の UUID で対応し、対応表は machine-local に置く
- 受け入れ条件：
  - `sync-remotes.json` の各項目は `folderId`、`kind`、`host`、`owner`、`repo`、`accountId`、`lastSyncedCommit`、`lastSyncAt` と、コピー検出用の `root` だけを持つ。`version` は 1 で、未知の version・欠落・不正な項目・余分な項目（`token` を含む）を持つファイルは、読み込みが `error` を返し、書き換えない。
  - 保存先ディレクトリは引数で渡され、フォルダの中には何も書かない。
  - `.magi`、portable なファイル、`.git/config` に、絶対パス、アカウント情報、リモート URL、トークンが出ない（レジストリを使った後のフォルダを走査して確認する）。
  - 書き込みは、同じディレクトリの一時ファイルに書いて rename する。完了後に一時ファイルが残らない。
  - 日本語名のフォルダと、NFC/NFD の違いのあるパス、大文字小文字だけが違う Windows のパスを、同じ場所として扱う。
- 関連コード：`apps/desktop/src/sync/sync-remotes-schema.ts:86`、`apps/desktop/src/sync/sync-remotes-schema.ts:95`、`apps/desktop/src/sync/sync-remotes.ts:72`、`apps/desktop/src/sync/sync-remotes.ts:188`
- テスト：`apps/desktop/src/sync/sync-remotes.test.ts`、`apps/desktop/src/sync/sync-remotes-portable.test.ts`
- 状態：実装済み
- 備考：実機（Electron の `userData` 配下）での確認は未実施。配線は S8 以降。

### SYNC-03 リモート URL を `.git/config` に書かない。コピーに接続先が付いていかない
- 受け入れ条件：
  - レジストリの操作の前後で、フォルダ内のファイル（`.git/config` を含む）の内容が変わらない。
  - 登録済みのフォルダを複製し、複製側の場所で `resolveFolder` を呼ぶと `needs-review` を返し、接続先（owner、repo）を返さない。
  - fetch/push が URL をコードから明示的に渡すこと（本 PR の範囲外）。
- 関連コード：`apps/desktop/src/sync/sync-remotes.ts:108`（`resolveFolder`）
- テスト：`apps/desktop/src/sync/sync-remotes-portable.test.ts`（「does not carry the connection to a copied folder」）、`apps/desktop/src/sync/sync-remotes.test.ts`（「same UUID in another place」）
- 状態：未着手
- 備考：登録側（URL を保存しない、コピーに付かない）は本 PR で実装。URL を渡す側の fetch/push は S6。移動したフォルダも同じ扱いになるため、利用者の確認後に `confirmRelocation` で場所を付け替える。

### SYNC-24 失敗しても、ローカルの保存と編集を止めない
- 受け入れ条件：接続・関係・ローカル・実行中・確認要因の全組み合わせで `deriveSyncState` が例外なく状態を返す。offline、ahead、behind、未 fetch は「同期待ち」、401 は「再接続が必要」に畳まれる。保存を止める状態や動作は定義しない。
- 関連コード：`apps/desktop/src/sync/sync-state.ts:81`
- テスト：`apps/desktop/src/sync/sync-state.test.ts`
- 状態：未着手
- 備考：状態の写像だけ本 PR で実装。保存を妨げない実行（非同期、予算）は S8。

### SYNC-25 明示操作なしに、公開やリモートの追加を行わない
- 受け入れ条件：`decideSync` が返す動作に、リポジトリの作成・可視性の変更・リモートの追加は無い。保存先が見つからない、または SETUP 外で空の場合は、何も書かず `NEEDS_REVIEW`（remote-missing）になる。
- 関連コード：`apps/desktop/src/sync/sync-decision.ts:81`
- テスト：`apps/desktop/src/sync/sync-decision.test.ts`
- 状態：未着手
- 備考：判定表の側だけ本 PR で実装。実行側の確認は S8。

### SYNC-26 履歴の書き換え、自動マージ、conflict marker の書き込みを行わない
- 受け入れ条件：`decideSync` が返す書き込み動作は push、初回 push、fast-forward の3つだけ。push は `refs/heads/main:refs/heads/main` に固定され、`force` は `false`。push が reject された場合は、再 fetch して再判定する（force に切り替えない）。
- 関連コード：`apps/desktop/src/sync/sync-decision.ts:26`、`apps/desktop/src/sync/sync-decision.ts:81`
- テスト：`apps/desktop/src/sync/sync-decision.test.ts`（「the only writing actions are push, initial push and fast-forward」）
- 状態：未着手
- 備考：事前・事後の refs 検証（EXT-02）は S6/S8。

### SYNC-27 diverged では、両方の履歴を保ち、作業ツリーを変更しない
- 受け入れ条件：relation が diverged のとき、`decideSync` は `keep-both`（`mutatesRepository: false`）、結果の状態 `NEEDS_REVIEW`、原因 `diverged` を返す。他の入力（未保存の編集、SETUP）の組み合わせによらず書き込み動作にならず、入力を変更しない。表示は「同期に確認が必要」と原因の 1 文で、ローカルの内容が保たれる旨を含む。
- 関連コード：`apps/desktop/src/sync/sync-decision.ts:81`、`apps/desktop/src/sync/sync-messages.ts:58`
- テスト：`apps/desktop/src/sync/sync-decision.test.ts`（「diverged is read-only for every combination」）、`apps/desktop/src/sync/sync-messages.test.ts`
- 状態：実装済み
- 備考：実際に refs と作業ツリーが変わらないことの確認（実 Git）は S6/S8。

### SYNC-28 fast-forward のみで進める
- 受け入れ条件：behind のとき、作業ツリーに未保存の編集が無ければ fast-forward、あれば fast-forward せず保存を待って再判定する（「同期待ち」）。merge、rebase、reset に当たる動作は定義しない。
- 関連コード：`apps/desktop/src/sync/sync-decision.ts:81`
- テスト：`apps/desktop/src/sync/sync-decision.test.ts`
- 状態：実装済み
- 備考：plan 21 への明文化（D 案）は別途。

## 要確認
- 表示状態の優先順位：草案は SAVED_ONLY の順位を決めていない。本 PR は、RECONNECT > NEEDS_REVIEW > PENDING > SAVED_ONLY > LOCAL_ONLY_SAVED > SYNCED とし、実行中は SYNCING を最優先にした（`apps/desktop/src/sync/sync-state.ts:71-79` のコメント）。
- behind と未 fetch を PENDING（同期待ち）に写像した。草案の表に該当行が無い。
- offline のときは、equal・clean でも「同期済み」にしない（plan 21:126）ため PENDING。
- 表示文言のうち、補足の文と原因ごとの 1 文は本 PR の案。
