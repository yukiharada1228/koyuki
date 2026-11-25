# この課題で使う最小限のAPI

## Resultと普通の関数

`Result<成功型, 失敗型>`は`{ ok: true, value } | { ok: false, error }`。
ok(value)とerr(error)で返します。関数の中で業務条件を判定することと、
I/OとRuleの間のResult接続を手書きすることは別です。

```ts
import { ok, err, type Result } from 'koyuki';
function positive(value: number): Result<number, 'NotPositive'> {
  return value > 0 ? ok(value) : err('NotPositive');
}
```

## business

```ts
import { business, ok } from 'koyuki';
const counter = business({
  name: 'counter',
  load: async (input: number) => ok(input),
  save: async (value: number) => ok(value),
  operations: { increment: [(value: number) => ok(value + 1)] },
});
const result = await counter.increment(1);
const report = await counter.increment.runDetailed(2);
```

loadは要求からRuleの入力を取得する非同期関数です。
operationsの配列は、成功値を次へ渡す同期Result関数列です。
saveは最後の成功値を保存します。途中の失敗はそのまま返し、後続と保存を止めます。
上の2呼び出しは独立した実行であり、同じ要求の結果をキャッシュするものではありません。

## 操作ごとに異なる入力

共通loadと異なる場合、`{ load, run: [関数] }`の形式で宣言します。
この課題のports.loadはgenericなので、例えば`ports.load<RejectInput>`と
操作の入力に特殊化してから渡せます。型引数の型はcontracts.tsにあります。

型の合う関数列とsaveから、操作の入力・成功・失敗型が推論されます。
汎用saveが実際に受け取った状態型を返す契約を持つ場合は、状態ごとの成功型も保てます。
型アサーションを追加する前に、loadの入力と最初のRule、各Ruleの入出力、最後のRuleとsaveの型を確認してください。

## 実行状態とエラー

`.runDetailed(input)`は`{ result, trace, plan }`を返します。
この課題の通常のbusinessではload・Rule・saveの成否がtraceに並びます。
load失敗ならRuleとsaveは実行せず、Rule失敗ならsaveを実行しません。
想定外のthrow/rejectionは呼び出し元へ伝播し、自動で業務エラーへ変換しません。
この課題では既知の失敗をResultで返してください。

## 型が証明しないこと

コンパイルできても、所有者や権限の判定を省略した業務仕様の誤りまでは証明できません。
提供されたテストと業務仕様で確認します。
また、readonlyという型だけで任意のcallbackの純粋性や本番DBの原子性を保証するわけではありません。

追加の資料が必要な場合は、公開repoのdocs/business.md等を参照し、
読んだ資料・時点・理由をfeedback.mdへ記録してください。保守者用の参考実装を見た場合も区別します。
https://github.com/yukiharada1228/koyuki
