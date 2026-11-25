# 業務関数から遷移を宣言する

未公開の開発版API。公開済みalpha.5にはdefineTransitionとwithInputは含まれない。
既存のTarget、UseCase、Group、Applicationを使い、実行エンジンは追加しない。

## 検証して更新するだけの操作

従来の宣言：

```ts
const approved = {
  validate: step('authorize-approval', validateApproval),
  require: [] as const,
  evolve: step('approve', approve),
};
```

通常の業務関数を、そのまま宣言できる。

```ts
import { defineTransition } from 'koyuki';

const approved = defineTransition({
  validate: validateApproval,
  evolve: approve,
});
```

validateとevolveは同期の`(input) => Result<output, error>`。
必要な前提条件がなければrequireを書かない。
検証後の型がevolveの入力に合わなければコンパイル時に拒否する。

defineTransitionは宣言を既存のStep形式へ正規化するだけで、関数を実行しない。
Target.on、defineUseCaseのtransition、Group.onでそのまま使える。
純粋な計算だけを試すときは`transition(approved).run(input)`。
正規化された宣言自身にrunはなく、既存の入口を使う。

## 前提条件を必要なだけ追加する

休暇申請の例。SubmissionとFundedは異なるprivate brandを持ち、
残日数の検証を通過した値だけがsubmitへ進める。

```ts
const submitted = defineTransition({
  validate: validateSubmission, // Loaded<SubmitInput> → Submission
  require: [requireDays],      // Submission → Funded
  evolve: submit,              // Funded → Change
});
```

requireは依存する計算の順序を宣言するtuple。各出力と次の入力の接続を検査する。
失敗時には後続も保存も実行しない。型の失敗をanyへ広げて接続しない。
動的に長さや内容が変わる一般配列では、この依存関係を証明できないため受け付けない。

## 元の入力と計算結果を両方使う

経費申請は権限検証後に承認経路を計算し、その結果と元の申請から次の状態を作る。
これまでsubmitの中にあったResultの確認と受け渡しを、次の宣言へ移した。

```ts
const submitted = defineTransition({
  validate: step('validate-submission', validateSubmission),
  require: [step('route-submission', withInput(routeSubmission))],
  evolve: step('submit', submitRouted),
});
```

withInputは成功時に`{ input, value }`を次へ渡す。

```ts
// Submission → Result<SubmissionRoute, ExpenseError>
function routeSubmission(command: Submission) {
  // 入力を承認経路の計算に必要な値へ射影する。Resultの分岐は書かない。
  return verifiedSubmissionRoute.run({
    id: command.current.id,
    amount: command.current.amount,
    receipt: command.current.receipt,
    employeeActive: command.actor.active,
  });
}

// RoutedSubmission = Readonly<{ input: Submission; value: SubmissionRoute }>
function submitRouted({ input, value }: RoutedSubmission) {
  // 元の申請と検証済み承認経路から次の状態を返す。
}
```

[実際のdomain](../src/expenses/domain.ts)と[宣言](../src/expenses/application.ts)を参照。
既存のsubmitも互換入口として残すが、その合成は同じWorkflowへ委譲する。
承認経路の業務判断をフレームワークが推測するわけではない。

SubmissionRouteのprivate brandはdomainが管理する。
withInput自身は業務の証拠を生成せず、渡した関数の出力型を保持するだけ。
このため通常のExpenseDecisionを手で作っても、submitRoutedの入力にはできない。
型は任意のasや異なる要求の証拠の意図的な混合を防ぐセキュリティ機構ではなく、
保存境界での要求・遷移の一致確認も引き続き必要。

## 名前と不変性

- 生の関数の既定名はvalidate、require:1、require:2、evolve。
- Function.nameには依存しない。名前をminifyしても役割のラベルは変わらない。
- 安定した業務名が必要なら、既存のstep(name, fn)を混ぜて使う。
- 生の関数へ移行すると省略したステップのtrace名は変わる。旧名との一致は保証しない。
- 宣言・require配列・Stepの外側をfreezeし、渡されたStepはコピーする。
  呼び出し元が持つStepや配列をfreeze／変更しない。
- withInputのペアも外側だけfreezeする。input/valueの参照はそのまま保持する。
  domain値を深くfreezeしたり、classの複製やprototypeの書き換えは行わない。

通常関数でも副作用を書けるため、型だけで純粋性を保証するものではない。
async関数は純粋な段階として受け付けない。
途中のI/Oが必要な処理には既存processのeffectを使い、IO境界を明示する。

## 型推論の限界

入力と戻り値を型で表した通常の業務関数を渡す使い方を推奨する。
単純なevolveの引数は推論するが、genericなwithInput呼び出しと未注釈のevolveを
同じオブジェクトへ直接入れると、TypeScriptがrequireのtupleを推論できない場合がある。
そのときは要件の計算を名前付き変数に出すか、evolveの引数型を明示する。

```ts
const quoted = withInput(quote);
const next = defineTransition({
  validate,
  require: [quoted],
  evolve: pair => ok({ before: pair.input, quote: pair.value }),
});
```

型推論のためにResultの成功値・失敗型をunknownやanyへ広げる回避はしていない。

## 検証

```sh
npm run check
npm test
npm run test:transition:package
npm run test:use-case:package
npm run check:package
npm run test:portable
npm run test:quickstart
```

- 本体354テスト。各段階の停止、複数の異なる中間型、明示名と既定名、不変な宣言、withInputの参照と失敗の保持を検証。
- 経費の申請・差し戻し・修正・再送・CAS/rollbackを新しい宣言で実行。
  ReceiptRequiredの失敗はroute-submissionに記録し、evolve/saveを行わない。
- 独立したHTTP consumerでは休暇3操作を生の関数へ置き換え、既存HTTP15テストと比較1テストを実行。
  比較では省略したステップ名だけを明示した対応表で変換し、結果・失敗・保存状態・その他の記録を一致させる。
- 外部の型定義で、必要な証拠・require接続・async混入・入力・保存型・失敗型の8種類の誤定義を拒否。
- NodeグローバルなしのVMでdefineTransition/withInputと既存group/Applicationを実行。
  配布物の実行依存ゼロ・全公開型のNode型不要を確認。

npm registryのalpha.5は比較基準のまま。新APIの検証はpackした開発版で行う。
実ブラウザや公開Workersへこの開発版を再デプロイしたという意味ではない。
