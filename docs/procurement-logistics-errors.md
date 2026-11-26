# 入荷・在庫7操作のエラー型を保持する

入荷・返品・数量訂正と、在庫の予約・解除・移動・調整で、広いRuleErrorへの型の拡大を除いた。
これで[申請・発注12操作](procurement-commercial-errors.md)、[財務6操作](procurement-finance-errors.md)と合わせ、
購買サンプルの全25操作について固有のエラーkindを通常・詳細・再送まで検査する。
業務関数の実行方法や成功状態、検証証明、保存計画は維持する。

## 公開されるkind

共通部分はDenied / TargetMismatch / InvalidInput / Conflict / NotFound。

| 操作 | 共通部分に加わるkind |
| --- | --- |
| 入荷・数量訂正 | WrongState / QuantityExceeded / InsufficientStock |
| 返品 | WrongState / InsufficientStock |
| 在庫予約・解除・移動・調整 | InsufficientStock |

在庫操作にWrongState、返品にQuantityExceededの分岐を書くコードは型検査で拒否する。
これは宣言したResultの集合であり、全入力・DB制約に対する到達可能性の証明ではない。
NotFound/Conflictは取得・保存adapterの契約からも来る。NotFoundを空在庫へ回復する処理を自動で解析して消す変更ではない。
再送では元の集合にInvalidReplayRequest / ReplayMismatch / CommitUnknown / ReplayInputNotCloneableを加える。
履歴の成功型は、現在の遷移だけの状態へ狭めない。

## 型が広がっていた境界

在庫のfail helperをliteralなkindを保持するgeneric関数へ変更した。
checkStock、在庫の計算、stockChange、入荷・返品・訂正の検証や互換関数は、失敗を本体から推論する。
返品計画とstockChangeの成功型はokの型引数で明示し、返却する状態と元のReceipt型を維持する。

互換用withStockは、元のエラーkindとstockChangeが返すエラーを合成したResultを返す。
stockChange側の集合はReturnTypeから取り出し、別の手書きの一覧を作らない。
単純なResult<T, E>の引数からEを推論すると最初の失敗だけが選ばれたため、
このkindだけを持つ既存ドメインの互換境界ではkindをgenericに集約する。
失敗値の変換、再実行、業務判断の追加は行っていない。

比較用helperの入荷・返品の接続も、各段階のkindを保持するようにした。
plain/helperは自分自身の手書きの接続を維持し、Koyukiのruntimeを呼んで比較を成立させていない。

## 検査

[追加検査](../src/procurement-logistics-errors.test.ts)は、7操作の通常・詳細・再送を3方式で独立した期待集合と比較する。
16のドメイン/在庫関数の集合も検査し、privateな追加文脈の参照を保持すること、拒否順序、
3方式で独自の保存エラーpayloadを保持し、失敗時に在庫が保存されないことを確認する。
既存25操作の成功・代表失敗・例外・保存計画・選択観測の比較も継続する。

配布consumerでは、checkReceiptの戻り型、在庫のfail、withStockの戻り型をそれぞれ広いRuleErrorへ戻すと、
新しいエラー型の契約が失敗する。単に型を広く受け取って通す修正ではない。
返品と数量訂正の2つの生成元の成功型だけをReceipt全体へ広げた対照でも、
既存の互換関数・在庫接続の状態型契約が失敗する。accepted/placedの証明を外す既存の対照も維持する。

変更前23fbc99と変更後のdomain/inventory/helperをesbuildで型除去して比較し、出力JavaScriptの一致を確認した。
新しいframework API、runtime処理、実行時依存、型アサーションは追加していない。

## 残る範囲

25操作でエラー集合を検査しても、任意の業務の正しさやJavaScriptの全例外を型で証明したものではない。
他のアプリケーションで利用者が広い戻り型を注釈すれば、その注釈をframeworkが本体解析で絞る仕組みではない。
一般のinline/deep generic推論、独立利用者の評価、原音確認の未完了は残す。
講演全体の判定は部分充足のままである。

実装基準はe1dab1b。全体1,204件、実tarballのTypeScript 6.0.3/7.0.2のconsumer各860件が成功した。
3つのエラー型の拡大と2つの状態生成元の拡大、既存の証明を除く対照も両版で検出した。
Node型なしの公開宣言、実行時依存ゼロ・28モジュール、宣言診断47件・資料記録9件も確認した。
