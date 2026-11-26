# 入荷・返品・訂正の状態型を保存計画まで保持する

後続の点検では、checkReceiptの成功型にも、実際に検証済みのcurrent:acceptedとorder:placedを
反映した。閉じた状態へ差し替えて検証印を再利用するコードを型で拒否し、その2つの状態型だけを
外す対照では拒否契約が失敗する。実行時の検証手順・同じ文脈への参照は維持する。
任意のaliasによる変更や型アサーションまで防ぐ保証ではない。

[6モデルの点検](procurement-state-contract-review.md)で残っていたReceipt側を修正した。
returnReceipt/returnCheckedReceiptはreturned、correctReceipt/correctCheckedReceiptと
finishReceiptCorrectionはacceptedのChangeを返す。receiveOrderのprivateな数量検証印は維持する。
業務の判断・計算・拒否順序の本体は変更していない。

## 純粋な遷移だけでは足りなかった箇所

receiptChange、stockChange、withStock、ReceiptDecision、在庫を追加する2関数が
Receipt全体へ型を広げていた。これらを生成したT extends Receiptを保持する型へ変更した。
コピーするのはchecks/writesの配列であり、result自体は元の型を保持する。
3つの互換入口receiveIntoStock/returnFromStock/correctInStockでも同じ型を保つ。

これだけでは、businessの普通の関数列で最終のgeneric投影を接続した際の成功型は
広いReceiptのままだった。公開操作の3つの厳密型検査が失敗することを確認した。
既存のWorkflowで具体的な直前の値を受けるcallbackから在庫投影を呼ぶ形へ変更すると、
追加のcallback型注釈やResultの手動取り出しなしで型を保持できた。
これは通常のbusiness関数列の任意のgeneric推論を修正したという意味ではない。

receiveStockDecision/returnStockDecision/correctStockDecisionを業務宣言へ接続する。
既存の3つのwithInputの文脈注釈は残し、新しいラッパーの型注釈へ移して隠してはいない。
core APIや外部依存は追加していない。

通常公開操作と詳細結果はaccepted/returned/acceptedを返す。
過去receiptを返す再送はReceipt全体のままであり、今回の遷移の型を過去へ当てはめない。
比較用helperの接続関数も同じ型を保持するよう精密化したが、Resultの手動接続と
plain/helper/Koyukiの独立した実行方法は維持する。

## 観測・診断と検証

Workflow内でも従来のrun:1/run:2/run:3、revalidate-correction、correct-receipt-planの
段階名を保持する。実際の各操作の段階数、成功130境界・代表失敗274境界、
I/O72位置・178注入、capture入力374/結果196は変えない。
構成図のグループはWorkflowへ変わるため、旧構成と同じオブジェクト形とは主張しない。

ソース診断の対象5ファイルは6 businessと6 Workflowの計12宣言となる。
25操作ID・52ラベル・診断/未解決0を確認する。application単独では、Workflow参照に
まとめた分、未解決位置は47から44になる。未解決の減少は業務の完全性の証拠ではない。

[既存の入荷検査](../src/procurement-receipt-pipeline.test.ts)へ生成関数・互換入口・
3公開操作・詳細結果・広い再送型の厳密一致を追加した。既存の失敗停止・保存計画・
メモリ/SQLite・3方式観測・再送の検査も継続する。
配布consumerでは戻り型だけを元の広いReceiptへ戻す対照が失敗することも検査する。

入荷の文脈注釈3箇所、一般の型推論の制約、独立利用者の未実施、原音確認、
講演全体の部分充足の判定は変更しない。
