# React経験者向けの業務ロジック組み立て試作

目的はReactの内部を再現することではなく、部品・props・Context・カスタムHooksで業務処理を組み立てる体験を確かめること。試作は `src/experiments/react-business/` に置き、npmの公開APIは変更していない。Reactや新たな実行時依存は追加していない。

## 経費承認の縦断例

[業務関数とコンポーネント](../src/experiments/react-business/expense.tsx)では、既存のドメイン型・検証・遷移をそのまま利用する。

```tsx
// HooksやRepositoryなしでもrun(input)で実行できる純粋な合成。
const approveExpense = workflow('authorize-approval', validateApproval)
  .then('approve', approve);

function useExpenseApproval() {
  const expenses = useContext(ExpenseRepositoryContext);
  const actor = useActor();
  return useOperation({
    name: approval.name,
    load: (input: Input) => expenses.load(input, actor),
    execute: approveExpense,
    save: change => expenses.save(change),
  });
}

function ApproveExpense() {
  const handler = useExpenseApproval();
  return <Operation operation={approval} handler={handler} />;
}

const app = createApplication(<Expenses repository={repository} actor={actor} />);
await app.dispatch(approval, input);
```

ExpensesはRepositoryとActorのProviderを組み合わせる部品。呼び出し元は認証済みの操作者を渡す。業務側では引き続きvalidateApprovalが権限・状態を検証し、クライアント入力に操作者を任せない。

新しいResult合成APIは追加していない。既存のworkflowとthenが、Resultの成功値を接続し、失敗で停止する合成を提供している。純粋な合成とI/Oの境界はHooksを導入しても分けられる。

## 評価と実行の境界

JSXは部品の評価をProviderのスコープ内まで遅延する。組み立て時には操作を登録し、フレームワークからload・execute・saveを呼び出さない。dispatchまたはinspectを明示的に呼ぶと既存のdefineCommandで実行する。inspectも実行を伴い、保存も行うため、プレビューではない。

各createApplicationは独立したContextと登録表を持つ。Hooksを呼べるのは同期的なコンポーネント評価中だけで、評価の終了・例外時に以前のスコープへ戻す。非同期処理には操作者やRepositoryをクロージャとして渡す。dispatch中にグローバルな現在のContextを読み出さない。

この仕組みは利用者の関数の純粋性を強制するものではない。部品の中で直接I/Oを書けば実行される。コンポーネントは同期的な組み立て関数として書く。

## 試作で見つけた設計上の負担

- JSXの要素型だけから、子孫の全操作名・入力・結果を静的に回収する設計にはしていない。代わりに `operationKey<Input, Output, Error>(name)` という型付きハンドルを一つ宣言し、登録とdispatchで共有する。呼び出し時の型安全性は保てるが、これが自然な書き心地かは引き続き評価する。
- executeには通常の関数または既存のWorkflowを渡せる。Workflowをそのまま渡すと内部のルール名・失敗位置をアプリのinspectから追える。通常の関数は一段として扱う。関数の本体を解析してtraceを復元することはしない。
- 再送はuseOperationのreplay設定から既存のwithReplayへ接続する。永続的な変更とreceiptの原子的保存はアダプターの責務。同時要求のloadやsaveの呼び出し回数そのものを一回に制限する機能ではない。操作識別子・要求ID・操作者・入力・ポリシー版の照合もアダプターの契約に含まれる。
- 再描画、useState、useEffect、Hook呼び出し順の追跡、asyncコンポーネントは実装していない。Reactとの互換ランタイムではない。
- Providerの値は参照として渡す。認証済みActorの値の変更管理やHTTPリクエストのライフサイクルは呼び出し元の責務。

## 実行中の通知

createApplicationの第2引数へ既存のExecutionOptionsを渡せる。observeExecution、またはアプリのsubscribeExecutionから、実行ID・各ルールのlive span・完了通知を受け取る。Hookの要求別CommandとOperation登録が、既存の詳細実行の観測能力を引き継ぐ。dispatchとinspectは同じ詳細実行の経路を使い、観測のために業務を再実行しない。

```tsx
const app = createApplication(<Expenses repository={repository} actor={actor} />, {
  sessionId: 'host-request-1',
  observeExecution: event => record(event),
});
await app.dispatch(approval, input);
```

観測者の失敗は業務のResultから分離する。業務I/Oの想定外の例外は元のままrejectし、終端通知はdefectとなる。既存defineApplicationのcrashedへの変換やprojection管理を、この入口に追加したものではない。

## 再送付き経費承認

[再送版のHook](../src/experiments/react-business/expense-replay.tsx)は、同じapproveExpenseを使う。

```tsx
return useOperation({
  name: replayedApproval.name,
  load: (call: ApprovalRequest) => expenses.load(call.input, actor),
  execute: approveExpense,
  save: (change, call) => expenses.saveRequest(request(call), change),
  replay: {
    lookup: call => expenses.receipt(request(call)),
    resolveAfter: error => error.kind === 'SaveConflict'
      || error.kind === 'InvalidState'
      || error.kind === 'RepositoryUnavailable',
  },
});
```

業務関数の変更は不要。Hookにはlookupと回復対象の失敗の指定が追加され、saveは元の要求も受け取る。要求ごとのsaveクロージャを作り、同時実行でも最後に届いた要求で上書きしない。操作者はHook評価時にコピーして固定し、lookupとsaveへ同じ認証済みidentityを渡す。withReplayはdispatch入力をsnapshotしてからlookupと実行へ渡す。

再送用の型付きハンドルは `replayOperationKey<Request, Saved, CommandError, LookupError>(name)`。入力・保存値・エラーに加え、inspectの返すReplayReportの型も保つ。再送設定に対してExecutionを返さないsaveは型検査で拒否する。通常実行と再送実行では戻り値とレポートの形が異なるため、ここは利用者が区別して理解する必要がある。

アプリのinspectでは、再送境界のtraceと、実行した場合の `attempt.trace` を分けて返す。キャッシュが見つかった場合はattemptがnullとなる。失敗時はauthorize-approvalなどの個別ルールまで辿れ、成功済みreceiptならload・業務計算・saveを行わない。

## 休暇承認への適用

[休暇承認の例](../src/experiments/react-business/leave.tsx)も、独立したworkflow、RepositoryのProvider、カスタムHook、Operation、dispatchの同じ構成で記述する。追加のランタイムAPIは不要だった。これは組み立て方を比較するための小さな別ドメイン例であり、既存の休暇サンプル全体を移行したものではない。

残る書き心地の負担は、型付きハンドルでの型宣言と、再送アダプターの要求identityを組み立てる関数。今後は複数操作での共有を評価し、業務固有の永続化契約を暗黙化しない範囲で重複を減らす。

## 検証

[試作テスト](../src/react-business.test.tsx)で、組み立て時のI/Oゼロ、明示実行、失敗停止、独立した純粋関数の合成、Providerの入れ子、異なる操作者による処理の重なり、Provider不足、重複登録、評価失敗後のスコープ復帰を確認する。型検査ではdispatchの必須入力と結果・エラー型、およびloadとexecuteの不一致を検査する。

```sh
npm run check
npx tsx --test src/react-business.test.tsx src/react-business-replay.test.tsx src/react-business-leave.test.tsx src/react-business-execution.test.tsx
```

[再送テスト](../src/react-business-replay.test.tsx)は既存のSQLiteアダプターを使用し、保存済み要求、同時重複、応答喪失、要求payload変更、操作者の違い、dispatch後の入力変更、Hook評価後の操作者変更、異なる要求の並行処理を確認する。[休暇テスト](../src/react-business-leave.test.tsx)では同じ構成で成功・失敗・個別ルールのtraceを検査する。SQLiteはテスト用のI/Oアダプターであり、試作ランタイムはNode APIをimportしない。

これは保守者によるAI実装・評価であり、初見の人間の評価としては数えない。講演全内容の完全実現や、現行APIの置き換え完了を意味するものでもない。
