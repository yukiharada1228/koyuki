# 配布後も業務処理の入力型を維持する

講演の「前提を型に表し、正しい関数だけを接続する」という方針に対し、
ソース内だけではなく、実際にインストールした宣言ファイルでも拒否を検査する。

## 確認した問題

`'one'`しか受け取れないWorkflowを、string全般を受け取る処理として扱える場合があった。
ソース内のprivate実装フィールドが持っていた型情報が配布宣言で消え、
method形式の入力検査が弱まることによるもの。

接続箇所だけを厳しくしても、先に広い型の変数へ代入すると迂回できた。
また、Applicationのoperationへ明示的に広い型引数を与える経路と、
defineUseCaseが返すcommandの型を広げて代入する経路も検査対象にした。

## 契約

- Workflow.run自体をreadonlyの関数プロパティにし、入力型の不正な拡大を拒否する。
- branch、Process.through、defineCommand、bindMutationでは、入力を受け取る関数の契約を保持する。
- operationとreplayOperationのcommand入力も関数プロパティとして検査する。
- 通常commandと再送対応commandの公開戻り値もrun/runDetailedの入力型を保持する。

readonlyは静的な代入の制限であり、実行時のObject.freezeや純粋性の証明ではない。
広い入力を受け取れる処理を、狭い入力だけが届く場所へ接続する安全な向きは維持する。
loadが常に失敗する場合の既存の型推論、defineCommandの明示的7型引数、
入力・成功・失敗型の推論も回帰検査する。

Workflow.runはreceiverから切り離して渡せるため、既存Workflowの結果を
businessの通常関数列へ`[existing.run]`で登録できる。
この形式は内部段階のtraceを展開する形式ではない。内部の段階も保持してI/O列へ組み込みたい場合は
Process.throughを利用する。

## 検証範囲

[src/command-connection-types.test.ts](../src/command-connection-types.test.ts)はソース内と実配布consumer、
[scripts/fixtures/branch-narrowing-types.ts](../scripts/fixtures/branch-narrowing-types.ts)は
実tarballをインストールしたNode型なしconsumerで、不正接続・変数代入の拒否を検査する。
受け手が必要とする型と、前段が実際に返す型の範囲が一致するかを検証するもので、
any・型アサーション・虚偽の型ガード・不正な外部データ・業務仕様の完全性は証明しない。

[src/workflow-input.test.ts](../src/workflow-input.test.ts)では、通常関数としてのWorkflow再利用、
インスタンスの分離、期待失敗後の保存停止、予期しない欠陥の伝播を検査する。
