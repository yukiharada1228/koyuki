# 普通のgeneric関数によるrecordの接続

`withInput`で包まず、普通の共有generic関数が返すrecordのフィールドと入力の型の対応を保持する。
`defineTransition`の中間段階と、推奨入口の`business`の直接の関数列が対象である。実行エンジン・公開APIは変更しない。

```ts
import { business, ok, type Result } from 'koyuki';

type Change<T> = Readonly<{ before: T; after: T; kind: 'change' }>;
const prepare = <T>(input: T): Result<Change<T>, 'Refused'> =>
  input === null ? { ok: false, error: 'Refused' } : ok({ before: input, after: input, kind: 'change' });

function application<T>(initial: T) {
  const finish = (value: Change<T>) => ok(value);
  return business({
    name: 'ordinary-record',
    load: async (_id: string) => ok(initial),
    save: async (value: Change<T>) => ok(value),
    operations: { change: [prepare, finish] },
  });
}

const input = { id: 'expense', amount: 300 };
const result = await application(input).change('expense');
if (!result.ok || result.value.before !== input) throw Error('Lost input correspondence');
```

`prepare`の型は普通のTypeScript関数の型であり、接続用のWorkflowやinput/valueの構築は不要。
型検査のため、入力・出力に同じTを用いるという業務関数自身の契約は必要である。

## 型を絞る条件

1. 各フィールドについて、関数が任意のTに対してその対応を保証することを検査する。
2. フィールドを一緒に絞った出力全体についても、任意のTでの保証を検査する。
3. 実際の前段の入力に対する出力全体の保証も検査する。
4. 候補が元の出力のsubtypeであることを検査し、private class・brandなどの情報を消さない。

候補のキーは呼び出し元の未確定なTとは独立に計算する。直和では各variantのキーを調べるが、保証は常に直和全体に対して確認する。
optional・readonly・固定値・関係のないunknownは維持する。
オーバーロードでは任意のTの比較だけが通っても、実際の入力に対する保証が通らない場合があるため、両方必要である。

[検査](../src/transition-value-fields.test.ts)では、名前あり/なし、別のgeneric呼び出し元、直接businessの保存と失敗停止、
privateな入力、privateな出力、Symbolの証明、判別可能な直和、無関係なunknown、過剰な絞り込みを拒否するケースを確認する。

## 残る制限

任意のgeneric関数への型適用ではない。さらに深い入れ子のフィールド、名前なしinlineのwithInput、型だけで保証されない対応には制限が残る。
独立利用者の試用・原音の未確認区間・講演全体の完全実現は別の未完了事項である。

## 検証記録

785040bのクリーンなソースで[TypeScript 6.0.3](ordinary-record-context6.json)・[7.0.2](ordinary-record-context7.json)を検査した。
9830febで不受理だったgeneric-record-scoped-callerとprobeのhashが一致し、現在は受理され、既存契約の追加診断は0。
深いpair出力・名前なしinlineは[6.0.3](ordinary-record-limits6.json)・[7.0.2](ordinary-record-limits7.json)で引き続き不受理である。

全体1,174件、配布consumerは両版で各830件、宣言検査47件が成功。追加4ケースとこの文書の実コードをtarball利用側でも検査する。
500操作と64段階の検査も成功。これらは保守者による検証であり、独立利用者の開発体験の評価ではない。

[深い出力の推論候補](deep-output-investigation.md)では、再現例の受理と既存契約の回帰を分けて比較する。候補は不採用で、コアの制限は維持する。
