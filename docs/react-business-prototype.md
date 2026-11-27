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
    execute: approveExpense.run,
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
- Hooksのexecuteに渡す通常の関数は、一段の業務処理としてtraceに載る。approveExpense自体のinspectでは検証と遷移を個別に追えるが、現在のアプリ側inspectへ内側のtraceは統合していない。
- 再送・永続的な冪等性はこの試作に接続していない。既存の再送境界に必要な操作ID・要求ID・receipt・保存アダプターを、HooksのAPIへどう渡すかが次の設計課題になる。dispatchの二重呼び出しを自動的に一度にまとめる機能はない。
- 再描画、useState、useEffect、Hook呼び出し順の追跡、asyncコンポーネントは実装していない。Reactとの互換ランタイムではない。
- Providerの値は参照として渡す。認証済みActorの値の変更管理やHTTPリクエストのライフサイクルは呼び出し元の責務。

## 検証

[試作テスト](../src/react-business.test.tsx)で、組み立て時のI/Oゼロ、明示実行、失敗停止、独立した純粋関数の合成、Providerの入れ子、異なる操作者による処理の重なり、Provider不足、重複登録、評価失敗後のスコープ復帰を確認する。型検査ではdispatchの必須入力と結果・エラー型、およびloadとexecuteの不一致を検査する。

```sh
npm run check
npx tsx --test src/react-business.test.tsx
```

これは保守者によるAI実装・評価であり、初見の人間の評価としては数えない。講演全内容の完全実現や、現行APIの置き換え完了を意味するものでもない。
