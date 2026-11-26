# 取得結果を名前付きフィールドへ接続する

開発版の `Process.effect` は、第三引数に新しいフィールド名を指定できる。

```ts
const loaded = process<{ input: Input; actor: Actor }>()
  .effect('read-invoice', context => repository.readInvoice(context.input.id), 'current')
  .effect('read-order', context => repository.readOrder(context.current.orderId), 'order');
```

従来の `(context, current) => ({ ...context, current })` を省略するための形式。
取得する事実・順序・公開名・NotFoundの解釈は引き続きhostが決める。
成功値を指定フィールドに加え、Resultの失敗・例外・後続停止・詳細trace・選択captureは
既存のeffectと同じ実行境界を使う。宣言時にはI/Oを実行しない。

## 型と実行時の境界

- 元の文脈は列挙可能なデータ項目だけを持つplain record。null prototypeも許可する。
  クラス文脈・accessor・非列挙属性を、spreadで黙って失うことを避けるため拒否する。
  object型からplain recordであることを静的に証明はできないため、この検査は実行時に行う。
  通常のinterfaceで宣言したデータ文脈も使える。
- 元の文脈を変更せず新しいrecordを作る。入力内の値や取得結果はcloneせず参照を保持する。
  取得結果自体はクラスなどのopaque値でもよい。純粋性・deep freezeの保証ではない。
- 既存フィールドの上書きは型と実行時の両方で拒否する。unionの一部にだけ存在するフィールドも型で拒否する。
  I/Oの前後で確認するが、外部adapter自身の変更を取り消す機能ではない。
- 広いstring名とindex signatureを持つ文脈は静的な追加先を確定できないため、この形式では受理しない。
  literalのunion名なら、出力も「どちらかのフィールドを持つ」unionとなり、両方あるとはしない。
- 文脈の置換・任意の射影・opaqueな文脈には、従来の第三引数callbackを使う。
  二引数effectの「成功値が次の入力になる」契約も維持する。

## 実際に減らした記述と検証

購買の `context-framework.ts` で11個、`context-process.ts` で5個の
単純なフィールド追加callbackを置き換えた。関連データの結合・policyの追加・
NotFoundの回復方針などの業務やhostの判断は明示したまま。
名前・読み込み順・各境界の成功入力/出力形は維持する。

`process-field.test.ts` は型の厳密一致、誤った上書きの拒否、失敗停止、例外、並行実行、
getter非呼出し、元の文脈とopaque値の参照、union名を検査し、配布consumerでも実行する。
既存の購買3方式・メモリ/SQLite・代表失敗・I/O例外・選択観測の比較も実行する。

これは16個の定型callbackを減らす改善。入荷の3つの型注釈、一般のgeneric関数列の推論、
独立利用者による書き心地の評価、実運用の検証を解消したとは扱わない。
講演全体の部分充足という判定も維持する。
