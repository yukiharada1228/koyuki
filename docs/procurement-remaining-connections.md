# 購買の実装に残る接続と、業務判断の境界

後続の[名前付きI/O接続](process-fields.md)では、context-framework/context-processの
単純なフィールド追加callbackを16個削減した。取得先・順序・フィールド名はhostが引き続き宣言し、
関連データの結合と回復方針、入荷の3つの文脈注釈は残る。

確認基準はea480ea6e727ad304dff1effa344678d2a404685。
独立利用者の試用は未実施との回答を踏まえ、保守者が実ソースを読んだ記録として扱う。
書き心地の評価結果ではない。対象は購買サンプルであり、講演全体の完成判定ではない。

以下は上記commit時点の棚卸し。その後、[在庫4操作の接続](procurement-stock-planning.md)を分離した。
現在のbusinessではcheckStock→checked関数を宣言し、下表の在庫の内部guard接続は互換入口だけに残る。
さらに[返品・訂正の共通検証](procurement-receipt-checks.md)も分離した。続いて[数量訂正の実経路](procurement-live-correction.md)も宣言へ移した。訂正内部の手書きResult接続は互換関数に残し、実経路はWorkflowで接続する。
元の観察を消さず、現在の残存接続・文脈注釈・hostの入力構築と区別する。

後続の[申請作成](procurement-request-creation.md)も、作成前提・明細解析・計画の宣言へ移した。
現在は21操作が複数段階で、上記commit時点の単一段階9操作という記述は履歴である。
createRequestの手動接続は互換入口へ残す。さらに[申請編集](procurement-request-edit.md)も状態検証・明細解析・計画の宣言へ移した。
editCheckedRequestの手動接続は互換入口に残り、他の内部接続と3つの文脈注釈も引き続き残る。

## 操作宣言で既に委譲していること

[application.ts](../src/experiments/procurement/application.ts)の6つのbusinessには25操作がある。
13操作は共通検証と遷移、入荷・返品・訂正の3操作は入荷判断と在庫計画を配列で接続する。
残る9操作は申請作成、請求書登録・照合、支払記録・取消、在庫の予約・解除・移動・調整である。
これらもload→run→saveの接続と失敗停止はruntimeへ委譲するが、内部計算の全接続を委譲したわけではない。
41個のruleラベルを解決できることは、この内部接続が不要になったという証拠ではない。

## 実際に残っている記述

| 場所 | 残る記述 | 判定と次の扱い |
| --- | --- | --- |
| [inventory.ts](../src/experiments/procurement/inventory.ts)のoperate | guardのResultを判定し、成功したpositionsから予約等の計画を作る。在庫4操作がこの接続を共有 | 実際の経路に残る定型接続。次に分離する候補。共通検証を省略できない型と、具体的なMoveInput/AdjustInputの保持が必要 |
| [domain.ts](../src/experiments/procurement/domain.ts)のreturnReceipt/correctReceipt | receiptGuardを手で接続。correctReceiptは数量の解析Resultも取り出す | 入荷3操作の外側を配列へ移しても、この内部接続は残る。状態・関連注文・請求書の拒否順序を維持して検討する |
| domainのcreateRequest/editCheckedRequest | linesの解析Resultを取り出して合計や状態を作る | 業務の値生成と接続が混在する。全てのifをruntimeへ移すことを目的にせず、解析の成功値と入力を次へ渡す負担を評価する |
| [receipt-pipeline.ts](../src/experiments/procurement/receipt-pipeline.ts) | 3つのwithInput callbackへ具体的な文脈型を注釈 | Resultの手動伝播はないが、入力の相関を保持するための記述負担がある。名前付きstepの限定例で改善しても、現在の3注釈が消えたとはしない |
| domainのsubmitRequest等13個の互換関数 | check→成功値の取り出し→checked関数 | 現在のbusinessはchecked関数を直接配列へ接続する。互換関数の残存を、実操作のruntimeが二重に検証する証拠としない。plain側等の利用は別に追う |
| inventoryのwithStockと3つの互換関数 | 入荷判断Resultを取り出してstockChangeへ渡す | businessの入荷3操作はreceipt-pipelineとincludeReceivedStock/includeChangedStockを使う。こちらの互換経路と宣言した実経路を混ぜて数えない |
| [context-framework.ts](../src/experiments/procurement/context-framework.ts)と[context-process.ts](../src/experiments/procurement/context-process.ts) | effectの成功値へcurrent/order/stock等の名前を付け、次の入力を構築 | Resultの判定と停止はProcess側。必要な事実・取得順序・公開名はhostが明示する。現在も手書きの接続宣言であり、全自動とはしない |
| contextのstock取得 | NotFoundだけを空在庫nullへ読み替え、それ以外の失敗を維持 | 業務・hostの回復方針。失敗を無条件にnull化する共通処理へ置き換えない |
| applicationのsave | commit成功後だけ詳細変更を返す。commit前に写したwritesを失敗時には公開しない | 保存adapterの出力契約。独自のbusinessでは必要なhost実装であり、runtimeのRule接続とは区別する |

## 安全に削減するための条件

最初の候補は在庫4操作の共通検証である。現行guardは版だけでなくsku/location/quantityを先に確認し、
その後でConflictを返す。移動先・調整理由の検証はさらに後である。
別の共通検証へ単純に置き換えると、多重に不正な入力で返すエラーの優先順位が変わり得る。
また、guardの現在の成功値はpositionsだけなので、そのまま次段へ渡すと入力・actor・stockを失う。

分離するなら、次を独立した期待値で確認する必要がある。

- 元のエラー優先順位、予約量・移動・調整理由・版の業務仕様。
- 検証済みの文脈が具体的な移動先・理由を保持し、検証の省略や別の証明の流用を型で拒否すること。
- 検証失敗・判断失敗では保存しないことと、成功時の保存計画の一致。
- 3方式比較とメモリ/SQLite比較で、成功だけでなく既存の代表失敗・例外・選択観測の期待値を更新すること。

既存の[推論調査](business-input-pair-inference.md)と[名前付き段階の調査](business-named-stages.md)で
再現済みの制限を、別のAPI名を付けただけで解消したとは扱わない。
新しいframework APIの追加より、既存の普通の関数とbusinessでこの実経路を表せるかを先に検証する。

この棚卸しは、残存接続の種類と次の実装対象を特定するためのもの。
9個の単一段階操作を全て欠陥と数えることも、全Result接続を消すという要求を完了扱いにすることもしない。
独立利用者の記録、未注釈callbackの推論、直接音声の確認、host運用の残件は引き続き別に残る。
