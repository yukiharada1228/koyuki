# 数量訂正の実経路へWorkflowを採用する

[直接接続の試作](procurement-correction-decomposition.md)を、購買の実際の数量訂正へ移した。
新しいframework APIは追加せず、既存のWorkflow・withInput・businessを使う。

```ts
export const correctDecision = workflow('revalidate-correction',
  withInput((value: CheckedReceipt<ReceiptStockContext<CorrectInput>>) =>
    receiveOrder(receiptCorrectionInput(value))))
  .then('correct-receipt-plan', ({ input, value }) =>
    ok(Object.freeze({ input, value: finishReceiptCorrection(input, value) })));
```

[操作宣言](../src/experiments/procurement/application.ts)は、引き続き
`[checkReceipt, correctDecision, includeChangedStock]`である。
内側の2つの計算も実際のtrace・選択観測・構成図へ現れ、計算全体は4段階となる。
thenのcallbackには追加の型注釈やResultの取り出しを書かない。
3つのwithInputの文脈注釈は残り、任意のgeneric推論を解消したものではない。

## ドメイン計算を共有する

[domain](../src/experiments/procurement/domain.ts)へ、訂正用の入荷入力を作るreceiptCorrectionInputと、
検証後の入荷計画を訂正・注文更新・請求書のリセットへ投影するfinishReceiptCorrectionを分けた。
後者は純粋な計算でChangeを返し、Resultの判定をしない。
従来のcorrectReceipt/correctCheckedReceiptは互換入口として同じ関数を使う。
テスト内に重複していた計画投影も削除し、独立した期待writes/checksは残した。

receiveOrderの成功型は、acceptedの入荷計画と非公開unique symbolのReceivedChangeで表す。
finishReceiptCorrectionはその型を要求し、手作りのaccepted計画や公開マーカーだけでは接続できない。
実行時のプロパティは追加せず、JSONからこの証明を復元することもしない。
証明は検証を通したことの型表現であり、別の文脈との値の一致、型アサーション、検証後の変更、
任意の業務仕様の正しさを保証するものではない。

plain実装は4段階を手で接続し、helper実装には同じ4段階を接続する専用の関数を置く。
これらはKoyukiのWorkflow/business runtimeを使わず、同じドメイン計算を呼ぶ。
独立した接続と期待値による比較であり、独立した開発者が書いた実装ではない。

## 実行と観測

成功時はload→run:1（共通検証）→revalidate-correction→correct-receipt-plan→run:3（在庫計画）→saveとなる。
開発版の訂正について、従来のrun:2一段を2つの明示名へ変更する。名前で選択する観測側はこの変更に追従する必要がある。
再検証に渡す注文・版・既存入荷の除外、権限・数量・状態の拒否順序は元のままにする。
数量超過なら計画作成と保存へ進まず、在庫が不足しても保存しない。
最後の成功値だけを、従来どおり一回のcommitへ渡す。

再検証の成功値には、一時的な「新規入荷としての計画」が含まれる。
これは保存対象ではなく、訂正計画への投影と在庫計画の結合がまだ必要である。
その値を観測できても、DBの変更や保存済みの履歴を表すものではない。
input/valueの組はfreezeし、元の文脈・在庫・計画の参照をcloneせず保持する。

## 確認した範囲

- [ドメインと実repositoryの検査](../src/procurement-receipt-pipeline.test.ts)で、注文・入荷・請求書のリセット計画、入力参照、組のfreeze、型の証明を照合する。
- メモリ/SQLiteの実commandで、数量超過がrevalidate-correctionで止まり、保存せず既存状態を保持することを追加確認する。
- [4方式の比較](../src/procurement-correction-decomposition.test.ts)で、互換経路・平らな接続・run関数・実Workflowの成功計画と失敗停止を照合する。
- 全25操作の3方式比較と、既存のSQLiteの複合保存・CAS・競合・例外検査を継続する。
- ソース診断では4ファイルの6 business＋1 Workflow、25操作IDと48ラベルを解決する。

成功32回の観測は124境界、代表失敗は不正入力64＋保存前Conflict124＋取得失敗78で266境界となる。
I/O例外の入力射影362回・結果射影184回または0回を確認する。
I/O位置72種類、例外注入178回、read/related/commitの回数と実行順序は維持する。
段階を外へ出した分の観測増加であり、業務操作数や生産性の改善件数ではない。

互換関数や他のドメイン内部のResult接続、hostの入力構築、3つの文脈注釈は残る。
独立利用者の試用、原音確認、全講演の完全実現は未完了のままとする。
