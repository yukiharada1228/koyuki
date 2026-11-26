# 返品と訂正の共通検証も宣言へ移す

在庫4操作に続き、返品・数量訂正に残っていたreceiptGuardの手書き接続を、
実際のbusiness宣言から取り除いた。新しいframework APIは追加しない。

```ts
return: {
  load: context.receipt<ReasonInput>,
  run: [checkReceipt, returnDecision, includeChangedStock],
},
correct: {
  load: context.receipt<CorrectInput>,
  run: [checkReceipt, correctDecision, includeChangedStock],
},
```

[checkReceipt](../src/experiments/procurement/domain.ts)は元の文脈をそのまま返し、
非公開unique symbolの証明を付ける。引数の具体的な型を保持するので、stock・数量・理由・減算方針を失わない。
returnCheckedReceipt/correctCheckedReceiptはこの証明を要求する。
withInputの3つの文脈注釈は維持し、返品・訂正では検証済みの文脈を明示する。
証明の実行時プロパティ追加や、型アサーション・検証後の破壊的変更に対する防御ではない。

## 順序と保存

共通検証は、認可→対象と関連データの整合→入力の版→Conflict→状態の順で拒否する。
状態には返品済み・注文終了・請求書承認済みの制約を含む。
返品理由や訂正数量はその後に判断し、最後に在庫計画を加える。
最初の計画作成で予定するwritesを観測しても、DBへ保存したという意味ではない。
全段階が成功した後で、注文・入荷・請求書のリセット・在庫を一回のcommitへ渡す。
原子性とCASは引き続きrepositoryの契約である。

従来のreturnReceipt/correctReceiptと在庫付きの互換関数は残す。
現在のbusinessと詳細取得の実験は、共通検証とchecked関数を直接接続する。
plain/helperは同じ3段階を自身で実行し、Koyukiのruntimeで比較結果を作らない。
helper側はgenericな検証を具体的な文脈へ特殊化する必要があった。比較側の記述負担も隠さない。

## 確認と残件

[検査](../src/procurement-receipt-pipeline.test.ts)へ、共通検証の文脈・在庫参照の保持、
独立に書いた返品/訂正のwrites/checksと請求書のリセット、多重不正入力の拒否優先順位を追加した。
未検証・偽の公開マーカー・数量の欠落・businessでの検証省略は型検査で拒否する。
正しい接続を同じload/saveで受理する対照例も置く。
メモリ/SQLiteの非保存・保存拒否・成功、3方式の取得・例外・観測比較と配布物consumerの検査を継続する。

20操作が複数段階となり、うち返品・訂正の2操作は3段階、他の18操作は2段階となる。
全25操作のrule出現数は47。32回の成功は123境界、代表失敗は不正入力64＋保存前Conflict123＋取得失敗78で265境界。
I/O例外検査は入力射影360回・結果射影182回または0回となるが、I/O位置72種類と例外注入178回は変わらない。
段階を表に出した分の観測増加であり、業務操作や保存の増加ではない。

訂正の内部には、数量再検証のためにreceiveOrderを呼び、そのResultから計画を作る接続が残る。
注文側の版や累計数量の再検証も行うため、同じ検証に見えるという理由だけで削除しない。
入荷そのものの内部計算、3つの文脈注釈、hostの取得と入力構築も残る。
全Result接続の除去、独立利用者の書き心地、全講演の完全実現は未達のままとする。

その後、[数量訂正の実経路](procurement-live-correction.md)をWorkflowへ移し、内側のResult接続も宣言へ出した。
現在は返品が3段階・訂正が4段階となり、計画投影をdomainで共有する。上記の数値は共通検証分離時点の記録である。
