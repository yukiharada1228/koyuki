# 入荷計画と在庫計画の接続をruntimeへ移す

購買の入荷・返品・数量訂正を、入荷の保存計画を作る段階と、在庫の保存計画を加える段階へ分けた。

```ts
receive: [receiveDecision, includeReceivedStock],
return: { load: context.receipt<ReasonInput>, run: [returnDecision, includeChangedStock] },
correct: { load: context.receipt<CorrectInput>, run: [correctDecision, includeChangedStock] },
```

[接続用の宣言](../src/experiments/procurement/receipt-pipeline.ts)は既存のwithInputを使い、
成功した入荷計画と元の文脈をReadonlyなinput/valueの組として渡す。組だけをfreezeし、元の文脈はcloneしない。
入荷だけのdomain関数の引数型にはstockや減算方針が含まれないため、3つのadapterに文脈の型注釈を明示する。
その注釈から不要なラッパーまで自動推論する改善ではない。新しいframework APIは追加していない。

## 委譲した接続と残る業務判断

従来のwithStockはResultを受け取り、失敗ならreturnし、成功値を取り出して在庫計画を作っていた。
現在の[在庫計画](../src/experiments/procurement/inventory.ts)は成功済みのChangeを受け取り、
Koyukiアプリの失敗伝播と後続停止はwithInputとbusinessが担当する。
単体呼び出し用のreceiveIntoStock等は、従来と同じResult接続をする互換の入口として残す。
plain/helper比較版は入荷関数を直接呼び、失敗停止とinput/valueの組み立てを自分で実装する。
frameworkの接続用関数は比較版の実行には使わない。

入荷の数量・権限・版数、在庫の予約数・減算場所の選択、どの保存計画を結合するかは業務側の判断。
在庫計画が成功した後にだけ、入荷・親注文・請求書のリセット等の既存計画へ、在庫のwrites/checksを加える。
両段階ともDBへ保存せず、最後のsaveが一回だけ結合済み計画を受け取る。
第一段の予定されたwritesを観測できても、それは確定済み保存ではない。

複数モデルの原子保存とCASは引き続きrepository/adapterの契約であり、関数列だけでtransactionを作るわけではない。
減算方針receiving-only / available-locations、操作ID、要求・成功・失敗型、保存順序は維持する。

## 拒否順序と観測

入荷の理由や数量が不正なら、在庫側の不正より先にその失敗を返す。
入荷計画が成功した後に在庫が不足すれば、結合済み計画を作らず、saveを呼ばない。
成功traceはload / run:1（入荷計画と元の文脈）/ run:2（在庫を加えた計画）/ saveとなる。

[全25操作の成功観測比較](procurement-observation-comparison.md)では、32操作のうち入荷が2回、
返品と数量訂正が各1回現れる。既存の共通検証10操作の106記録から4境界が加わり、現在は110記録となる。
入力/結果の射影失敗も110境界で比較し、結果・read/commit回数が3方式で一致する。
選択値の射影は、この実例で使うinput/valueの組から入荷計画のmetadataを選ぶよう明示した。
任意のオブジェクトをframeworkが自動解釈する機能ではない。

## 確認した範囲と限界

[追加検査](../src/procurement-receipt-pipeline.test.ts)で、明示した3モデルの期待writes/checks、
組のfreezeと元の文脈の同一性、元の文脈・第一段の保存計画を変更しないことを確認する。
入荷の拒否と在庫の不正が重なる場合の順序、予約在庫の不足での停止、不適切な入力・保存計画の型の拒否も検査する。
メモリ/SQLiteでは実際に入荷・予約・予約解除を行い、両段階の拒否で保存しないこと、
成功時に入荷・注文・在庫の版数が一度ずつ進むことを確認する。
追加の保存Conflictはcommit前の注入であり、これをSQLiteのcommit途中のrollback検証とは扱わない。
既存の複合保存・競合・障害検査と、全25操作の3方式比較は別途継続する。
追加検査も開発版tarballのconsumerで実行する。

共通検証10操作とは異なる、成功値と元の文脈を併用する3操作への適用である。
業務関数内部の全Result接続の自動除去、全障害・分散transaction・任意の純粋性の保証ではない。
3つの型注釈と在庫投影関数の宣言も必要で、コード量や学習負担が小さくなったという実証はしていない。
独立利用者のDXと講演全体の完全実現も未確認のままである。

[入力保持の推論調査](business-input-pair-inference.md)で、この注釈を減らす際の制限を追加で切り分けた。
withInputの直接呼出しとbusiness配列の接続は同じ推論範囲ではなく、具体的な文脈の注釈と
先行する変数束縛を残す現行形は維持する。調査で見つけた制限を解消済みとは扱わない。
