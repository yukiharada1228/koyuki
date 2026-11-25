# 元の入力を残すgeneric関数とbusinessの推論制限

購買の入荷・返品・訂正では、`withInput`を使う3つのadapterに文脈の型注釈が残る。
その負担を減らせるか調べ、直接の関数呼出しとbusinessの接続で異なる制限を確認した。
公開API・実行エンジン・購買モデルは変更していない。

## 通る書き方と通らない書き方

[再現例](../scripts/fixtures/business-input-pair.ts)では、最小のBaseから金額を計算する
普通のgeneric関数を用意する。呼び出し側のContextは通貨とclassのprivate fieldも持つ。

```ts
function quote<T extends Base>(input: T): Result<number, 'Declined'> {
  return ok(input.amount * 2);
}
const quoted = withInput(quote);
```

quotedをContextで直接呼ぶ型は、`{ input: Context; value: number }`を返す契約を満たす。
しかし、`business({ operations: { quote: [quoted, finish] }, ... })`では、
途中の成功型を計算する際に、その具体的な入力との対応を保持できない。
finishが必要とする通貨・classの型を次段へ渡す宣言として拒否される。
直接の型代入が通ることを、businessでの接続も通る証拠にはできない。

現行の回避策は、具体的なContextを注釈して先に束縛する形である。

```ts
const explicitQuote = withInput((value: Context) => quote(value));
const app = business({
  name: 'explicit', load, save,
  operations: { quote: [explicitQuote, finish] },
});
```

この例は入力number・結果`Result<string, 'Declined'>`の厳密一致を含めて通る。
load・save・finish・Contextの全定義は再現例に含む。
同じ注釈付きwithInput呼出しを配列へ直接inlineで置く例は通らない。
型注釈だけでなく、先に変数へ束縛する負担もこの例にはある。
すべてのinline関数が通らないという一般化はしない。

## 試した宣言変更を採用しない理由

withInputの戻り値を次のgeneric関数へ変える候補も調べた。

```ts
<T extends I>(input: T) => Result<Readonly<{ input: T; value: O }>, E>
```

この候補は3つのprobeをいずれも通さず、既存ソースに40件の診断を生じた。
generic関数の入力・成功型の対応を壊し、元の明示的な回避策を含むprobeでも失敗する。
40件は独立した40個の不具合という意味ではなく、同じ推論劣化から派生する診断も含む。
候補は一時コピーへだけ適用し、製品へは採用しない。
これを入力保持に関するすべての改善が不可能だという結論にはしない。

## 再現と根拠

[結果JSON](business-input-pair-inference.json)は、7e9992dのクリーンなソースと
TypeScript 7.0.2での3試行を記録する。各試行は同じソース・compiler・候補を使う。

| probe | 現行宣言 | generic戻り値候補 | 現行の既存ソース診断 |
| --- | --- | --- | ---: |
| business-input-pair | 不受理 | 不受理 | 0 |
| business-input-pair-explicit | 受理 | 不受理 | 0 |
| business-input-pair-inline | 不受理 | 不受理 | 0 |

```sh
node scripts/investigate-transition-inference.mjs --only current,input-preserving-generic-return --probe business-input-pair
node scripts/investigate-transition-inference.mjs --only current,input-preserving-generic-return --probe business-input-pair-explicit
node scripts/investigate-transition-inference.mjs --only current,input-preserving-generic-return --probe business-input-pair-inline
```

scriptは全srcを一時コピーして型検査し、probeと既存ソースの診断を分ける。
`probeAccepted`と診断位置を使い、互換性のため残る`inlineProbeAccepted`も同じ値を示す。
minimal欄は従来のtransition用の最小fixtureであり、今回のbusiness例へ書き換えたものではない。
欠落importや暗黙anyによる失敗は今回の記録にない。

購買の3つの注釈付きadapterは維持する。これは保守者によるcompiler検査であり、
利用者の学習時間・修正容易性・生産性の評価ではない。
講演の型記述の省略や自然な書き心地については、未解消の制約として対応表へ残す。

## 後続の名前付き段階

[businessでの名前付きstep](business-named-stages.md)を追加した。具体的なContextを注釈した
withInput呼出しをstepで包む場合は、inlineでも書ける検査を追加した。
このJSONの7e9992dでの結果は当時の宣言の記録として維持する。
名前なしinlineとgenericな入力の対応まで解消したわけではなく、現行APIの改善範囲は後続の文書で区別する。
