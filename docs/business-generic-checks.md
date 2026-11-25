# 普通のgeneric検証関数を業務操作で共有する

`business`の関数列へ、成功なら受け取った型をそのまま返すgeneric検証関数を置ける。
型引数で操作ごとに特殊化したり、Resultを取り出すラッパーを書いたりせず、次段へ具体的な文脈を渡す。

```ts
function active<T extends { readonly actor: { readonly active: boolean } }>(
  value: T,
): Result<T, 'Inactive'> {
  return value.actor.active ? ok(value) : err('Inactive');
}

function positive<T extends { readonly input: { readonly amount: number } }>(
  value: T,
): Result<T, 'InvalidAmount'> {
  return value.input.amount > 0 ? ok(value) : err('InvalidAmount');
}

// loadが{ input, actor }を取得し、approveがその具体的な文脈から変更を返す例。
const expenses = business({
  name: 'expense',
  load,
  save,
  operations: { approve: [active, positive, approve] },
});
```

この断片のload・save・approveは利用側の関数。
[実行可能な検査](../src/business-generic-check.test.ts)には、それらの定義と成功・失敗型の厳密一致を含む。
失敗した検証より後の業務関数と保存は実行しない。これは既存runtimeが担当し、今回の変更は型計算だけである。

## 型を維持する条件

従来はgeneric関数のReturnTypeから得た制約の型を、後続へ渡す型として使っていた。
例のactiveではactorしか残らず、後続のpositiveやapproveへinputを渡せない宣言として拒否された。

現在は直前の成功型を各段へ渡して計算する。戻り値が既にその型の部分型なら、その戻り値を保つ。
そうでなければ、実際の関数がその入力から同じ型の成功値を返すRuleとして代入可能か検査し、
成立する場合だけ具体的な入力型を維持する。成立しなければ、宣言された戻り値を使う。
最後の段がgeneric検証の場合も、保存の成功型を計算する候補へその具体的な型を渡す。
保存自体が狭い結果を保証するかは、従来のsaveの検査を維持する。

例えば`(value: Base) => Result<Base, E>`と宣言された通常関数が、入力の追加フィールドまで
返すとは推測しない。認可のbrandを持たない入力に検証関数を通しても、そのbrandを生成しない。
元より狭い成功型を返す関数の情報も、入力型へ置き換えて捨てない。

## 確認した範囲と限界

- 2つの共通検証を並べ、具体的なinputとactorを次段へ渡すこと。
- 操作ごとのloadで異なる文脈・入力・結果・失敗型を保持すること。
- 最終段のgeneric検証で、private fieldを持つclassの型と実際の参照を保持すること。
- 各検証の失敗で後続と保存を止め、詳細traceに実行した段階だけを残すこと。
- 広い型しか返さない通常関数、足りない認可brand、不適合なgeneric制約を拒否すること。
- 64個のgeneric検証をinlineで並べた型検査。従来の64個の異なる状態をつなぐ検査も維持する。

rootだけでなく、実tarballをinstallしたconsumerへ同じ検査をコピーし、公開宣言と実行を検査する。
無制限長の関数列や、任意のgeneric関数に型引数を適用する機能ではない。
異なる構造へ変換する多相関数や、型引数に依存した任意のエラー型をすべて計算するものでもない。
generic loadの推論契約や、defineTransitionの名前なしinline要件と未注釈evolveの制限を解消する変更ではない。
業務関数の純粋性・業務仕様の正しさ、独立利用者の書き心地の優位は、この検査から保証しない。
新しいbuilder・runtime処理・実行時依存は追加していない。
