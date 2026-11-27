# Reactらしい組み立てを開発版で試す

最初は[Quick Start](../authoring-quickstart/README.md)で一つの業務操作と実行スコープを確認してください。このページは経費・休暇・会員登録をまとめて試す発展例です。

この例は未公開の開発版tarballを使う。npm公開済みalpha.5には`koyuki/experimental`は含まれない。APIは実験段階で変更され得る。

リポジトリのルートで、未使用の保存先を指定する。

```sh
npm run prepare:authoring -- /path/to/new-koyuki-authoring
cd /path/to/new-koyuki-authoring
npm install
npm run check
npm start
```

準備ツールは開発版tarballと、実際の経費・休暇の業務関数、部品、Hooks、サンプルmainをコピーする。既存フォルダーを上書きしない。準備後は元リポジトリへ依存せず、通常のnpmパッケージのimportだけで実行する。ReactやNode型はインストールしない。開発時のTypeScript・tsxと、Koyukiだけを使用する。

会員登録の業務関数とHooks、休暇の再送Hookも含む。`three-businesses.tsx`は同じProvider・Hooks・Fragmentを使って3業務を一つのアプリへ組み立てる。永続保存adapterはホストが渡す。実DBによる再送・rollback・登録outboxの検証はリポジトリ側のテストで行い、Node型なしのこの試用パックへSQLite実装は含めない。

`expense.tsx`は純粋な合成を作り、`defineOperation('expense.approve.v1', () => { ... })` のカスタムHook内でContextからRepository・操作者を取得する。Hookは名前を持たない操作定義を返し、入力・成功・エラー・詳細レポートを推論する。定義時にHookは評価されない。宣言した操作を`<Operation operation={approval} />`と`app.execute(approval, input)`で共有するため、operationKeyやhandlerの手書き接続は不要。

`expense-replay.tsx`は同じ業務関数に再送境界を加える。`leave-domain.ts`は休暇の状態と認可・遷移を純粋関数として定義し、認可成功の証明を次の関数が要求する。`registration.tsx`は登録・確認を同じ宣言で組み立てる。`expense-budget.tsx`は途中に明示的なProcessのI/Oを置く。execute/executeDetailedを呼ぶまで、フレームワークはI/Oを実行しない。旧useOperation/operationKey、dispatch/inspectは削除した。

mainのreceipt adapterは単一プロセスのデモ用メモリ実装。永続的な再送や複数プロセスの原子性は保証しない。本番では状態とreceiptを同じtransactionで保存するアダプターが必要になる。既存SQLiteアダプターとの接続はリポジトリ側のテストで検査する。

`executeDetailed`は実行・保存を伴う。型付きハンドルによって、入力・成功値・エラーとレポート形式を保つ。通常の関数は一段のtrace、Workflowをそのまま渡した場合は内部ルールまで追える。処理中のspanはcreateApplicationのobserveExecutionまたはsubscribeExecutionで受け取る。第3引数へ同期selectorを渡すと、必要な入力・結果を一度の実行からcaptureできる。mainでは承認待ちから承認済みへの状態の変化を選択する。captureの対象外のresult/plan等は、ログ保存時に別途項目を選ぶ。

一括検証は `npm run test:authoring:package`。別プロジェクトへ実tarballをインストールし、TypeScript 6/7のNode型なしの型検査・宣言生成と、経費承認・休暇承認・再送・操作者分離・live spanを実行する。これは保守者のAI評価であり、人間の初見評価ではない。

検証モードはさらに、Node上の別integrationテストで、新しい会員登録HookとSQLite adapterを実tarballへ接続する。再接続・登録と確認の再送・rollback・同時要求を検査する。このDB用テストは準備モードの試用パックには含めず、Node型なしの型検査対象とも分ける。


## 三業務の宣言と表示更新

`dashboard.ts`のbusinessDashboardは、再送対応の経費承認・休暇承認・会員登録・確認に共通のviewを定義する。各業務コンポーネントがQueryもProvider内で登録し、viewはrefreshQueryのonでイベントとの関係を宣言する。`await app.start(businessDashboard(target))`で初期データを読み、session.dispatchの後続処理が終わると該当Queryを読み直す。呼出し元の手動loadやResult分岐は不要。

Query失敗はsnapshot.state.queriesへ保持し、保存済み業務の成功を取り消さない。外部の永続イベントをviewへ反映する入口はsession.deliver、再取得のみの入口はsession.refresh。snapshot.state.refreshingで再取得中を判定する。複数セッションや別プロセスの変更は、ホストがそのセッションへイベントを届ける。

サンプルのイベントoutboxは開発用で、本番のlease・schedulerを提供するものではない。メール送信は行わない。詳しくはリポジトリのdocs/declarative-connections.mdを参照。
