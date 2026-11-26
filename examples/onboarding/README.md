# Koyuki開発版の利用者課題

これは独立した利用者が、業務仕様からKoyukiのコードを書けるかを確認するための開始用課題です。
人間の独立利用者による評価結果はありません。ユーザー指定によるAIの試用では、複数段の実装を実行し、課題テストの不備を修正しました（[評価記録](../../docs/onboarding-ai-review.md)）。AIの観察や参考実装の成功を、人間の習得しやすさの証明とはしません。

## 開始

保守者がrepo rootから、存在しないフォルダーを指定して準備します。

```sh
npm run prepare:onboarding -- /absolute/path/to/new-workspace
```

そのフォルダーには開発版の実tarballとこの課題、来歴を記録したDEVELOPMENT.jsonをコピーします。npm公開は行いません。
来歴にはbase commitと作業ツリーの状態、パッケージと課題ファイルのhashを記録します。base commitだけで配布物との一致を主張しません。
参加者は準備されたフォルダーで次を実行してください（開発ツールはNode 26以上）。

```sh
npm install --ignore-scripts --no-audit --no-fund
npm run check
npm test
```

最初は型検査が通り、テストは未実装のエラーで失敗する状態です。
課題中に依存を公開済みnpm alpha.5へ置き換えないでください。businessは開発版の機能です。

## 書くもの

application.tsを、普通の純粋なTypeScript関数とbusinessの宣言へ置き換えてください。
createExpenses(ports)からsubmit・approve・rejectを返します。
contracts.ts、host.ts、テストは提供物なので変更しません。
ルールのファイル分割や補助関数は自由です。フレームワーク本体を修正する必要はありません。

loadは要求と現在の経費・認証済みactorを返す汎用関数です。共通loadへそのまま渡せます。
saveは成功した新状態を保存し、実際の成功型を保持する汎用関数です。
接続・Resultの伝播・実行はbusinessへ任せ、loadとsaveを各操作から手で順に呼ぶ実装は避けてください。
この構造に従ったかはコードレビューでも確認します。振る舞いテストだけで使用APIや純粋性を証明しません。

## 業務仕様

経費の状態はdraft・submitted・approved・rejectedの直和です。
成功するたびにversionを1増やし、既存のid・所有者・金額・申請時の証拠を保ちます。

読み込みに成功した後、各Ruleは次の順で判定します。

1. actorがinactiveならDenied。
2. expectedVersionが1以上の安全な整数でなければInvalidInput。
3. 現在のversionと異なればConflict。
4. 操作を実行できる状態でなければWrongState。
5. 操作ごとの権限と入力を検証し、新しい状態を返す。

submitはdraftだけが対象で、所有者本人が実行します。
金額は正の安全な整数、approverIdは前後の空白がない空でない文字列で、所有者とは別人です。
権限違反はDenied、金額・approverIdの違反はInvalidInput。
submittedへ進み、submittedByとapproverIdを記録します。

approveとrejectはsubmittedだけが対象です。
manager権限を持つ指定のapprover本人が実行し、所有者は承認も却下もできません。違反はDenied。
approveはapprovedByを記録してapprovedへ進みます。
rejectはrejectedByと前後の空白を除いたreasonを記録してrejectedへ進みます。
reasonは空白除去後1〜500文字で、それ以外はInvalidInputです。

読み込みのNotFound、保存のSaveUnavailable・Conflictはそのまま返し、失敗で後続を止めます。
自動再試行はしません。入力にactorが追加されても、portsが持つ認証済みactorを使います。

## 確認と記録

npm run checkとnpm testを実行し、結果と困った箇所をfeedback.mdへ記録してください。
型エラー、必要だった注釈、調べた資料、手書きで残った接続を残し、個人情報や秘密の業務情報は記入しません。
時間を記録するなら実作業と休憩を分け、測っていない時間は空欄にします。
速さや合格点の目標は設けません。未完了でも、詰まった状態の記録は有用です。

参照は同梱のreference.mdと配布型宣言を使えます。追加で公開repoの資料を読んだ場合は、その資料を記録します。
独立した利用の記録にする場合、課題に着手する前に保守者用の参考実装は読まないでください。
途中で読んだ場合は、その時点と理由を記録し、それ以降を独立した作業結果とは分けます。
補助を受けた場合も、どこからどの程度受けたかを記録してください。

この課題はbusiness入口の習得だけを対象とします。
React/Elm全体のDX、Application、HTTP、DB、永続再送、実運用の安全性・生産性は評価しません。
hostは1レコードのメモリadapterで、認証サービス・本番DB・完全な入力schema検証ではありません。
