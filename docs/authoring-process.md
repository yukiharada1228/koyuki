# Hooksから途中のI/Oと純粋な計算を組み立てる

開発版のkoyuki/experimentalにおけるuseOperationは、load → 純粋なWorkflow → saveに加え、明示したProcessをexecuteへ受け取る。loadにも詳細形式のProcessを渡せる。同期の計算とI/Oを区別しつつ、既存の実行機構へ接続する。

## 経費の権限検証と予算ポリシー照会

[経費の追加例](../src/experiments/react-business/expense-budget.tsx)は、次の構成を取る。

```tsx
export function budgetApprovalProcess(policies: BudgetPolicyRepository) {
  return process<Loaded>()
    .through(workflow('authorize-approval', validateApproval))
    .effect('read-budget-policy', context => policies.read(context), 'budget')
    .through(approveWithBudgetPolicy);
}

function useBudgetExpenseApproval() {
  const expenses = useContext(ExpenseRepositoryContext);
  const policies = useContext(BudgetPolicyContext);
  const actor = useActor();
  return useOperation({
    name: approvalId,
    load: (input: Input) => expenses.load(input, actor),
    execute: budgetApprovalProcess(policies),
    save: change => expenses.save(change),
  });
}

const budgetApproval = operationKey(approvalId, useBudgetExpenseApproval);
```

validateApproval、予算ポリシーの判定、状態生成は同期の純粋関数。Processは権限検証後にポリシーを取得し、成功値をbudgetへ加えて次の計算へ渡すI/Oのshellである。Hooksの中にResultの取り出し・失敗伝播のifは書かない。型付きの安定した識別子、load/save、外部依存の注入は通常例と同じ。

この例で照会するのは承認額の上限ポリシー。実際の残高引当や予算消費まで含める場合は、ポリシーの版・共有transaction・競合の契約を別途設計する必要があり、この例の保証には含めない。

## 同じ実行機構へ接続する

純粋なWorkflowと通常の同期Ruleは、従来どおりdefineCommandで実行する。詳細形式のProcessは、既存Process.effectとdefineActionでload・途中I/O・saveを接続する。新しい実行エンジンは追加していない。通常の同期RuleへPromiseを紛れ込ませず、I/Oを含む計算は明示した詳細形式のオブジェクトとして渡す。

load・権限検証・途中I/O・上限判定で失敗すれば、その後の段階と保存を止める。I/Oのthrow/rejectは元の例外でrejectし、想定内のResult失敗へ自動変換しない。既存の再送境界も同じHookへ適用でき、成功済みreceiptがあれば途中I/Oも実行しない。途中の外部副作用が最終保存と一緒に巻き戻されるという保証はない。

traceには内部の検証・read・判定・遷移を残す。実行中のspanは外側のexecuteと内部I/Oの親子関係を保ち、待機中にも通知する。詳細形式のloadの内部段階もつなぐ。execute全体の境界もtraceに現れるため、内部の失敗と外側の失敗表示を区別できる。

## Processを利用者のモジュールからexportする

実tarballの利用者がbudgetApprovalProcessを戻り型注釈なしでexportすると、従来は通常の型検査が通っても宣言生成でprivateな匿名クラスや移植できない名前のエラーになった。Processをrootの公開型として参照できるように修正した。実行時のconstructorはexportせず、Process本体とroot indexの実行JavaScriptは変えていない。

予算付きの純粋なWorkflowの入力には、ドメインの名前付きBudgetPolicyLoaded型を用いる。既存の権限証明を持つ型にbudgetがあることを表す業務型であり、最終APIの型アサーションや戻り型注釈ではない。

## 検査

[専用検査](../src/authoring-process.test.tsx)は次を対象にする。

- 組み立て中にI/Oを実行しない。Hookの外でも純粋な上限判定と状態生成を実行できる。
- ロード失敗・権限拒否・ポリシー取得失敗・上限超過の順序と保存停止を確認する。
- I/O待機中のspanと親子関係、内部trace、元の例外とdefectの通知を確認する。
- 異なるProviderの依存を並行実行でも保持し、receipt再送で途中I/Oを省略する。
- 具体的な入力・保存後の成功値・各段階の閉じたエラー型を保つ。

配布物検査は実際の追加例を別プロジェクトへコピーし、TypeScript 6/7のNode型なしの型検査・宣言生成・宣言だけを読むconsumerを検査する。Process入力とload出力、Process出力とsave入力の不一致も拒否する。公開Process型を削る対照は、同じexportするfactoryの通常検査を通り、宣言生成だけが失敗することを確かめる。

講演の途中I/Oと計算の分離への具体的な対応である。原音未確認区間、任意の多相変換、API安定化、実運用の残件を解消したものとはしない。
