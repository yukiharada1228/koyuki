# 可変長の明細を検証する

`collectEach(rule)`は、1要素を検証する通常の同期Result関数を、配列全体のRuleへ変換する。
開発版の追加APIであり、公開済みnpm alpha.5にはまだ含まれない。

```ts
const validateLines = collectEach(validateLine);

const priced = defineTransition({
  validate: validateLines,
  evolve: priceLines,
});
```

validateLineはLine→Result<ValidatedLine, LineError>、priceLinesは検証済み明細の配列から合計を計算する関数。
利用者がmapの結果をResultへ詰め直したり、個々の成功・失敗を分岐したりする必要はない。
固定フィールドを扱うcollectとは別に、可変長の明細を扱える。

## 成功と失敗

すべて成功した場合は、入力順のreadonly配列を返す。
1つでも失敗した場合は、次の形ですべての失敗を入力順に返す。indexは0から始まる。

```ts
err([
  { index: 1, error: { kind: 'InvalidQuantity' } },
  { index: 3, error: { kind: 'InvalidUnitPrice' } },
]);
```

各要素の検証は独立しているため、Resultの失敗があっても残りの要素を検証する。
その外側のtransitionやbusinessは、配列全体の失敗を受けて集計・保存へ進まない。
要素間に依存する逐次処理や、最初の失敗で止めたい処理へこの全エラー収集を流用しない。
非同期I/Oの並列処理・transaction・再送・キャンセルは扱わない。

空の配列はok([])。明細必須などの業務規則は呼び出し側が表現する。
ruleがResultの失敗ではなくthrowした場合は、その例外をそのまま伝播して残りを実行しない。
SDK等の例外分類は、既存の境界adapterで明示する。

## 型と所有権

Rule<Line, ValidatedLine, LineError>から、次を推論する。

```ts
Rule<
  readonly Line[],
  readonly ValidatedLine[],
  readonly { readonly index: number; readonly error: LineError }[]
>
```

async関数や隣接する段階の誤接続を型検査で拒否する。
実行開始時に配列の位置を浅くコピーし、返す配列と失敗位置のwrapperをfreezeする。
入力配列・各要素・error値・成功値そのものをfreezeやdeep cloneはしない。
純粋な検証関数の実装と、外部JSON等の実行時の構造検証は利用者の責務である。

既存defineTransitionの推論では、collectEachの生成結果を上の例のように変数へ置く必要がある。
入れ子に直接記述する場合の推論は未解決で、型をunknownやanyへ広げて回避してはいない。

## 検証した明細の例

[order-lines.ts](../src/examples/order-lines.ts)は、数量・円単価・明細小計と合計の安全な整数範囲を検証する。
独立した行の失敗をまとめ、1件でも失敗したら集計・保存を行わない。
正常な明細は合計して1回保存し、空の注文や桁あふれも保存前に拒否する。
これは小さな判断例であり、受発注・決済・在庫等を備える購買アプリではない。

既存のdefineUseCaseと未公開business試作の両方で接続し、保存の停止を検証する。
配布型はNode型なしconsumer、実行はNodeのglobalを与えないbundleでも確認する。

```sh
npm run check
npm exec -- tsx --test src/collection-validation.test.ts
npm run check:package
npm run test:portable
```

講演2本目29分台のResult列の接続負担のうち、同期の独立検証について具体化したもの。
言語レベルのdo記法や、任意のループ・I/Oの自動合成まで実現したものではない。
