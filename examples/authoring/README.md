# Reactらしい組み立てを開発版で試す

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

`expense.tsx`は純粋な合成を作り、ContextからRepository・操作者を取得するカスタムHookを定義する。operationKey(name, useCustomHook)がそのHookから入力・成功・エラー・詳細レポートを推論するため、ハンドル側へ同じ型を重ねて書く必要はない。ハンドルを作るときにHookは評価されない。`expense-replay.tsx`は同じ業務関数に再送境界を加える。`leave-domain.ts`は休暇の状態と認可・遷移を純粋関数として定義し、`leave.tsx`は同じ組み立て方を別ドメインへ適用する。認可成功の証明を次の関数が要求するため、pendingだけの取得でも認可の段階は省略できない。`expense-budget.tsx`は権限検証と状態生成の間にポリシーのI/Oを置き、純粋なWorkflowと明示的なProcessを組み合わせる。main.tsxから明示的にdispatch/inspectを呼ぶまで、フレームワークはI/Oを実行しない。

mainのreceipt adapterは単一プロセスのデモ用メモリ実装。永続的な再送や複数プロセスの原子性は保証しない。本番では状態とreceiptを同じtransactionで保存するアダプターが必要になる。既存SQLiteアダプターとの接続はリポジトリ側のテストで検査する。

`inspect`は実行・保存を伴う。型付きハンドルによって、入力・成功値・エラーとレポート形式を保つ。通常の関数は一段のtrace、Workflowをそのまま渡した場合は内部ルールまで追える。処理中のspanはcreateApplicationのobserveExecutionまたはsubscribeExecutionで受け取る。inspectの第3引数へ同期selectorを渡すと、必要な入力・結果を一度の実行からcaptureできる。mainでは承認待ちから承認済みへの状態の変化を選択する。captureの対象外のresult/plan等は、ログ保存時に別途項目を選ぶ。

一括検証は `npm run test:authoring:package`。別プロジェクトへ実tarballをインストールし、TypeScript 6/7のNode型なしの型検査・宣言生成と、経費承認・休暇承認・再送・操作者分離・live spanを実行する。これは保守者のAI評価であり、人間の初見評価ではない。
