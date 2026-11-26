# genericな入力保持を次の遷移へ渡す

defineTransitionで名前付きのgenericな要件を並べたとき、前段の具体的な文脈をevolveへ渡せるようにした。
evolveの引数へ同じ文脈型を指定し直したり、要件を具体型のcallbackで包み直したりする必要がない。
新しい公開APIや実行処理は追加していない。

```ts
import { defineTransition, transition, step, withInput, ok, err, type Result } from 'koyuki';

type Context = Readonly<{ amount: number; currency: 'JPY' }>;
function quote<T extends { amount: number }>(input: T): Result<number, 'Declined'> {
  return input.amount > 0 ? ok(input.amount * 2) : err('Declined');
}
const quotation = transition(defineTransition({
  validate: (input: Context) => ok(input),
  require: [step('quote', withInput(quote))],
  evolve: pair => ok({ currency: pair.input.currency, total: pair.value }),
}));
const accepted = quotation.run({ amount: 100, currency: 'JPY' });
const declined = quotation.inspect({ amount: 0, currency: 'JPY' });
if (!accepted.ok || accepted.value.currency !== 'JPY' || accepted.value.total !== 200
  || declined.result.ok || declined.result.error !== 'Declined'
  || declined.trace.at(-1)?.step !== 'quote') throw Error('Unexpected quotation');

function identity<T>(input: T): Result<T, 'Declined'> { return ok(input); }
const double = transition(defineTransition({
  validate: (input: number) => ok(input),
  require: [step('identity', withInput(identity))],
  evolve: pair => ok(pair.input + pair.value),
}));
const doubled = double.run(3);
if (!doubled.ok || doubled.value !== 6) throw Error('Unexpected identity composition');
```

quoteはcurrencyを知らない通常のgeneric関数であり、withInputは元のContextと計算したnumberを返す。
上の結果はResult<{ currency: 'JPY'; total: number }, 'Declined'>となる。
従来不受理だった、制約のないidentityと未注釈evolveの元の例にも対応する。
本文のコードを実tarballで型検査・実行し、Node型を読み込まない構成でも検査する。

## 補正の条件

すでにinputの型が前段の入力を保証している組は、出力型をそのまま使う。
これにより、独立したgenericな呼び出し元でTを使う既存の厳密な対応を維持する。
広い組だけを補正の候補とし、次の両方を確認する。

1. 実際の要件関数が、その具体的な入力に対して候補の成功型を約束する。
2. 候補は宣言済みの出力の部分型であり、既存の検証済み情報を消さない。

inputだけを保持する場合と、identityのようにvalueも同じ型を保持する場合を区別する。
元の入力が詳細だからという理由だけでは、通常の関数の広い戻り値を狭めない。
動的に選ぶ関数の全候補が保証しない情報や、unknownのvalueとの相関も補わない。

正規化後のrequireの関数型は、宣言した前段の文脈に対する成功を表す。
元のstepや元のgeneric関数の呼び出し方を変えるものではない。
失敗型・段階名・最初の失敗での停止・保存の境界・実行時の関数参照も維持する。

## 検証と限界

[遷移の検査](../src/transition-inline-step.test.ts)では、inline/先行束縛のidentity、
複数のgeneric要件、literalの追加フィールド、privateなclassの同一性、検証済み情報を確認する。
広い通常関数・保証のない関数Union・異なる入力・unknownのvalueの補完は拒否する。
既存のscoped generic関数の厳密型、step単独のTからitem:Tへの対応も変更しない。

全体1,150件、TypeScript 6.0.3/7.0.2の実tarball consumer各806件で確認した。
15個の不正宣言と、finance/order/receipt/storageの既存対照検査も維持する。
実行時のJavaScriptモジュールは28のままで、外部実行依存やNode型の要求は追加していない。

一般の多相変換を適用できるという保証ではない。
名前なしのwithInput直接呼出しと、未確定のTを使う別のgeneric呼び出し元でのidentityの厳密一致は未解消である。
後者の再現はcollectorの`--probe generic-identity-scoped-caller`で検査できる。
以前から通っているscoped generic callbackの例まで不受理になったという意味ではない。

collectorの過去の宣言変更候補は、元のcommitで再現する。新しい宣言形状へ部分的に適用しないよう拒否する。
現在の宣言は`--only current`で検査する。
独立利用者の開発体験や直接音声の確認は未完了で、[講演全体の判定](lecture-acceptance.md)は部分充足を維持する。
