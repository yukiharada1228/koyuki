# genericな入力保持を次の遷移へ渡す

defineTransitionで名前付きのgenericな要件を並べたとき、前段の具体的な文脈をevolveへ渡せるようにした。
evolveの引数へ同じ文脈型を指定し直したり、要件を具体型のcallbackで包み直したりする必要がない。
新しい公開APIや実行処理は追加していない。
呼び出し元の入力型Tも未確定な場合は、入力保持をすべての型について保証する関数の契約を先に確認する。
これにより、別のgenericな呼び出し元からもidentityや入力を保持する値生成を接続できる。

```ts
import { business, defineTransition, transition, step, withInput, ok, err, type Result } from 'koyuki';

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

function forward<T>(input: T) {
  return transition(defineTransition({
    validate: (value: T) => ok(value),
    require: [step('identity', withInput(identity))],
    evolve: pair => ok({ before: pair.input, after: pair.value }),
  })).run(input);
}
const input = { correlationId: 'original' }, forwarded = forward(input);
if (!forwarded.ok || forwarded.value.before !== input || forwarded.value.after !== input)
  throw Error('Generic caller lost its input');

type Envelope<T> = { subject: T; previous: T; kind: 'wrapped'; count: number };
function envelope<T>(input: T): Result<Envelope<T>, never> {
  return ok({ subject: input, previous: input, kind: 'wrapped' as const, count: 2 });
}
function forwardEnvelope<T>(input: T) {
  return transition(defineTransition({
    validate: (value: T) => ok(value),
    require: [step('envelope', withInput(envelope))],
    evolve: pair => ok({ original: pair.input, subject: pair.value.subject,
      previous: pair.value.previous, kind: pair.value.kind, count: pair.value.count }),
  })).run(input);
}
const context = { amount: 100, currency: 'JPY' as const }, wrapped = forwardEnvelope(context);
if (!wrapped.ok || wrapped.value.subject.currency !== 'JPY' || wrapped.value.kind !== 'wrapped'
  || wrapped.value.original !== context || wrapped.value.previous !== context || wrapped.value.count !== 2)
  throw Error('Generic value fields lost their correspondence');

// The same rules also connect directly through the recommended business API.
const project = ({ value }: Readonly<{ value: Envelope<Context> }>) => ok(value);
let saves = 0;
const envelopes = business({
  name: 'envelope.v1', load: async (input: Context) => ok(input),
  save: async (value: Envelope<Context>) => { saves++; return ok(value); },
  operations: { create: [step('envelope', withInput(envelope)), project] },
});
const stored = await envelopes.create(context);
if (!stored.ok || stored.value.subject !== context || stored.value.kind !== 'wrapped' || saves !== 1)
  throw Error('Direct business composition lost its value');
```

quoteはcurrencyを知らない通常のgeneric関数であり、withInputは元のContextと計算したnumberを返す。
上の結果はResult<{ currency: 'JPY'; total: number }, 'Declined'>となる。
従来不受理だった、制約のないidentityと未注釈evolveの元の例にも対応する。
本文のコードを実tarballで型検査・実行し、Node型を読み込まない構成でも検査する。

## 補正の条件

最初に、要件関数が「どんなTでもinput:Tを返す」、または「input:Tとvalue:Tを返す」という契約を持つか調べる。
その契約があれば、未確定のTを持つ呼び出し元でも入力の対応を維持できる。
ここでも、補正した型が元の出力の部分型であることを確認し、既存の検証済み情報を消さない。
単にunknownを受け取れる通常の関数を、そのようなgeneric関数として扱うわけではない。

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

入力保持をすべての型に対して約束する関数では、valueの各フィールドも個別に検査する。
フィールド名を固定せず、そのフィールドをTと元の型の交差へ置き換えた候補を、実際の関数がすべてのTについて保証する場合だけ採用する。
他のフィールドと直和の全variantは候補に残し、最終的な候補全体も元の出力の部分型であることを確認する。
さらに、個別の検査で組み立てた候補全体を、同じ関数がすべてのTについてまとめて保証するか検査する。
重なりのある直和やoverloadの別々の枝から、同時には成立しない根拠を寄せ集めない。
これにより、固定のkind/countや検証済み情報を消さず、unknownの値を入力と関係があると決めつけない。
privateなclass型を、その証明のないmapped objectへ置き換えることもしない。

## 検証と限界

[遷移の検査](../src/transition-inline-step.test.ts)では、inline/先行束縛のidentity、
複数のgeneric要件、literalの追加フィールド、privateなclassの同一性、検証済み情報を確認する。
広い通常関数・保証のない関数Union・異なる入力・unknownのvalueの補完は拒否する。
既存のscoped generic関数の厳密型、step単独のTからitem:Tへの対応も変更しない。

初回のeba9335では全体1,150件、TypeScript 6.0.3/7.0.2の実tarball consumer各806件で確認した。
15個の不正宣言と、finance/order/receipt/storageの既存対照検査も維持する。
実行時のJavaScriptモジュールは28のままで、外部実行依存やNode型の要求は追加していない。

[6.0.3の記録](transition-pair-context6.json)と[7.0.2の記録](transition-pair-context7.json)は、
eba9335のクリーンなソースで、元の名前付きidentity probeを再検査した結果である。
[以前の6.0.3](step-generic-identity6.json)・[7.0.2](step-generic-identity7.json)とprobeのhashは一致し、
不受理から受理へ変わった。既存契約の追加診断は0。
minimal欄は変更していない名前なしの最小fixtureであり、名前付きの修正済み宣言ではない。

後続の修正で、未確定のTを使う別のgeneric呼び出し元でのidentityの厳密一致も対応した。
入力だけを保持し、独立したnumberを計算するgeneric関数も接続する。
新しい例ではvalidateの戻り型も推論し、Result<T, never>の重複注釈を必要としない。
追加の3ケースは、inline/先行束縛、privateなclass、元の参照、失敗時の後続停止を検査する。
unknownの値や広い通常関数、保証のない関数UnionからTを補完する宣言は拒否する。
この追加後は全体1,153件、TypeScript 6.0.3/7.0.2の実tarball consumer各809件で検査する。
[6.0.3の追加記録](universal-pair-context6.json)・[7.0.2の追加記録](universal-pair-context7.json)は81d68a7のクリーンなソースの結果である。
eba9335の残件記録と同じprobeのhashで、別のgeneric呼び出し元のidentityが不受理から受理へ変わった。既存契約の追加診断は0。

さらに、共有generic関数によるTからitem:Tの対応も、別のgenericな呼び出し元から接続できるようにした。
[フィールドの検査](../src/transition-value-fields.test.ts)では、複数の名前、optional/readonly、tuple・配列・index signature、直和、非公開Symbolの証明を確認する。
privateなclass型とpair側の判別子の相関も維持する。businessの保存まで正確な型と失敗停止を検査する。
推奨入口のbusinessも同じ型計算を共有し、上のように各段階を配列へ直接並べられる。
非pairの既存のgeneric検証は元の推論を維持し、メソッドのvarianceによって必須要求項目を消さないことも検査する。
フィールド対応の追加後は全体1,170件、TypeScript 6.0.3/7.0.2の配布consumer各826件で確認する。
17件の追加ケースも実tarballへコピーし、既存の15不正宣言・finance/order/receipt/storage対照と併せて検査する。

一般の多相変換を適用できるという保証ではない。
名前なしのwithInput直接呼出しと、item.value:Tのようにさらに深い共有generic関数の対応には制限が残る。
後者はcollectorの`--probe generic-deep-wrap-scoped-caller`で再現できる。
この補正はinput/valueの組を対象とする。組を介さない共有generic関数のrecord出力も、`--probe generic-record-scoped-caller`の別の残件として再現する。
step単独のgenericな呼出しと、具体的なcallbackでTからitem:Tを作る既存の例は引き続き厳密一致を検査する。
[6.0.3](transition-pair-limits6.json)・[7.0.2](transition-pair-limits7.json)にあるidentityの不受理はeba9335時点の履歴であり、現在の制限とは区別する。
[81d68a7の6.0.3](universal-pair-limits6.json)・[7.0.2](universal-pair-limits7.json)のitem:Tの不受理も、その時点の履歴として保持する。

collectorの過去の宣言変更候補は、元のcommitで再現する。新しい宣言形状へ部分的に適用しないよう拒否する。
現在の宣言は`--only current`で検査する。
独立利用者の開発体験や直接音声の確認は未完了で、[講演全体の判定](lecture-acceptance.md)は部分充足を維持する。
