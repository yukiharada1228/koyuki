# 保存先の異なる業務を接続する試作

在庫確保と出荷登録を、別々のbusinessとして宣言する[実行例](../src/experiments/fulfillment/application.ts)。
非公開APIの検証であり、npmの利用例ではない。
在庫の成功値はReservation、出荷の成功値はShipmentで、それぞれのsaveが自分の型だけを受け取る。
共通saveのための巨大なUnionや、出力をunknownへ広げる宣言は不要。

```ts
const inventory = business({
  name: 'inventory.v1',
  load: ports.loadStock,
  save: ports.saveReservation,
  operations: { reserve: [reserve] },
});
const shipping = business({
  name: 'shipping.v1',
  load: async (reservation: Reservation) => ok(reservation),
  save: ports.saveShipment,
  operations: { create: [createShipment] },
});
const fulfill = process<Order>()
  .effect('reserve-inventory', inventory.reserve)
  .commit(shipping.create);
```

関数の型がそのまま接続契約になる。Processへ別の実行エンジンを追加していない。
在庫確保には保存があるためeffectとして扱い、純粋なworkflowの段階へは混ぜない。
最後の業務には既存commitを使い、結果を取り出すだけの空の検証・遷移は書かない。
この例では出荷登録が必要とする情報をReservationがすべて持つため、loadはその値を返す。
権限・別の状態・出荷先などが必要な実業務では、その取得と検証も必要になる。

## 部分成功と再実行

出荷の保存が失敗しても、先に保存した在庫確保は残る。
Processは最初の失敗で止まるが、過去の保存を自動rollbackしない。
全体を再実行する場合、既に確保した分を再び引かない契約が必要。

[検証用メモリadapter](../src/business-fulfillment.test.ts)は注文IDで確保済みの内容を照合し、
同じ内容なら同じ確保を返し、違う内容ならReservationConflictを返す。
在庫の読込でも当該注文の確保分を考慮する。出荷も同じ注文の重複保存を防ぐ。
再実行時には業務関数自体は再び動く。これはreceiptによる過去の結果のreplayとは違う。
外部APIを含む場合、その副作用にも重複排除や補償の契約が必要。

実行テストは正常系、検証失敗による後続停止、出荷失敗後の確保維持、手動再実行、
確保内容変更の拒否を確認する。型テストは異なるsave契約の混同を拒否する。
メモリadapterの単一プロセス内の検証であり、永続化・再起動・分散競合を保証しない。
原子的な二重集約更新が必要なら、同じtransaction contextに束縛したadapterが別途必要。

## 見つかった限界

Process.effectは呼び出したcommandを一つの段階として記録するため、在庫command内部のtraceは
全体reportには展開されない。最後のcommitの詳細traceは含まれる。
これは既存のProcessの契約であり、この実例を「全段階の自動監査」の証拠にはしない。
再送付きcommandはExecutionで包まれるので、この例と同じ接続だけでは後続入力にならない。
その値をunwrapして続行してよいか、過去の結果で現在の操作を進めてよいかは、業務ごとに判断が必要。

ひとつのbusinessが一種類の保存契約を持つ設計は、この例では維持できた。
一方、複数business間の原子性・補償・再開方針まで自動化できたわけではない。
