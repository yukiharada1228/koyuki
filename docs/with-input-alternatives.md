# 動的に選んだ業務関数も、そのまま要件へ渡す

`withInput`に複数の関数の直和を直接渡せるようにした。
従来必要だった`withInput((input: Input) => selected(input))`というdispatch関数を省ける。
選んだ関数は構築時に実行せず、呼出し時に一度実行する。成功時は元の入力を添え、失敗時は同じResultを返す。

```ts
import { withInput, ok, err } from 'koyuki';

const quote = (request: { amount: number }) => request.amount > 0
  ? ok(request.amount * 2)
  : err({ kind: 'InvalidAmount' as const, supplied: request.amount });
const closed = (_request: { amount: number }) =>
  err({ kind: 'Closed' as const, retryAfter: 30 });

export function quotation(available: boolean) {
  const selected = available ? quote : closed;
  return withInput(selected);
}

const result = quotation(true)({ amount: 3 });
if (result.ok) {
  const original: number = result.value.input.amount;
  const quoted: number = result.value.value;
  void original; void quoted;
} else if (result.error.kind === 'Closed') {
  const seconds: number = result.error.retryAfter;
  void seconds;
} else {
  const amount: number = result.error.supplied;
  void amount;
}
```

この返却関数を、普通の要件と同じようにworkflow・transition・businessへ並べられる。
関数の選択条件と業務ルールは利用者が記述し、接続・失敗停止・保存は既存runtimeへ委譲する。

## 入力は全候補が受け付ける必要がある

候補が`{ amount: number }`と`{ actor: string }`をそれぞれ要求するなら、呼出し側は両方を渡す。
入力型を単純な直和にするとamountしか持たない値をactorの関数へ渡せてしまうため、共通して渡せる範囲を交差で求める。
候補が`number | string`と`number | boolean`なら、共通の入力はnumberである。
number専用とstring専用の候補には共通の入力がなく、返却関数の引数はneverとなり、どちらの値でも呼べない。
選択条件のbooleanから、後の呼出し時に特定の候補だけへ絞る仕組みではない。

成功値とエラーは全候補の和を保持する。型が適合しても、業務ルールの内容や選択条件の正しさを保証するものではない。
Promiseや非Resultを返す候補、2つ目の必須引数を持つ候補は拒否する。

## 既存のgeneric関数との両立

従来のsignatureを先に置き、関数の直和の場合だけ追加のsignatureを適用する。
これにより、単一のgeneric関数にはTypeScriptの既存の型伝播を使い続ける。
深く包んだprivateな値の同一性、従来の3型引数、旧来のgeneric関数型への代入も検査する。
実行本体・新しいAPI名・型アサーション・実行時依存は追加していない。

[検査](../src/with-input-alternatives.test.ts)では、同じ入力の異なるエラー、入力の交差、異なる成功値、重なる入力の直和、
失敗時の非保存、既存のgeneric値保持を扱う。
配布consumerでは追加signatureだけを外すと直接接続の正例が失敗し、入力を交差から直和に変えると不正な呼出しの拒否契約が失敗することも確認する。

名前なしinline要件、遷移中の深いgeneric変換、任意の多相変換には制限が残る。
単独のwithInputが深い値を保持することと、その関数を遷移全体で未注釈接続できることは別の契約である。
独立利用者の評価・原音確認の完了を示す変更ではなく、講演全体の判定は部分充足を維持する。
