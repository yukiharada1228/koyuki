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
