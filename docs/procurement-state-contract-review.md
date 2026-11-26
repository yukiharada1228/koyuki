# 購買6モデルの状態と遷移型の再点検

財務操作の精密化に続き、購買の全6モデルの定義と、domain/inventoryの遷移関数を
状態の直和・検証の成功型・次状態型の観点で読んだ。独立利用者の評価ではない。

| モデル | 確認結果 |
| --- | --- |
| Request | draft、複数段階の承認、approvedの単独/二人承認、rejectedを直和で表現。遷移はDraft等の生成範囲を返す |
| Order | 以前は一つのrecordのstateプロパティだけがunion。今回、共通部分とplaced/cancelled/completedの直和へ整理し、8関数の戻り型を生成するvariantへ精密化 |
| Receipt | accepted/returnedは直和。receiveOrderの生成型はacceptedだが、return/correctと在庫追加の保存計画には広いReceipt型が残る |
| Invoice | registered/matched/approved/voidedは直和。[前回](procurement-finance-state-types.md)の8関数の精密化で次状態を保持 |
| Payment | recorded/cancelledは直和。同じ前回の精密化で次状態を保持 |
| Stock | stateタグを持たないpositionsとlastAdjustmentのモデル。状態名を増やすためだけの直和は追加しない |

## 注文の成功した検証が示す事実

checkOrderは所有者・関連データ・入力の版・現在版を検査した後で、placed以外を拒否する。
従来のCheckedOrderはprivateな検証印だけを足し、currentの状態を広いまま返していた。
今回は既存の検証結果に合わせて、currentがplacedであることも成功型に表した。
入力の追加属性や同じ文脈への参照、検証順序は維持する。

place/amend/cancel/completeの互換入口とchecked入口の計8関数が、それぞれ
placed/placed/cancelled/completedを返す。既存のbusinessとgeneric saveを通して、
4つの通常公開操作と詳細結果へそのまま届く。実行本体とtraceの構造は変えない。
過去のreceiptを返すprocurementReplayはOrder全体のままにする。

モデルの整理前後で許可するJSONの状態の集合は同じであり、これだけで実行時の不正状態を
新しく排除したわけではない。改善はExtractによるvariantの抽出、検証成功後の状態、
関数の次状態の型を一貫させた点にある。readonlyやprivate印は、任意のaliasによる
実行中の改変・DB保存の事実まで証明するものではない。

## 検査と残件

[既存の注文検査](../src/procurement-order-guard.test.ts)へ8生成型、4公開型、詳細結果、
広い再送型、成功後のplaced型、閉じた状態で検証印を再利用できない契約を追加した。
既存4件の実行検査は、不正入力の優先順位、独立した保存計画、メモリ/SQLiteでの停止・保存を照合する。
不正状態を試す表のContextはOrder全体へ明示し、fixture自身がplacedへ狭まったことによって
拒否検査を削除したり不正入力を型アサーションで偽ったりしない。

配布consumerでも同じ検査を使う。戻り型だけを広くする候補と、placedの成功型だけを
外す候補を一時コピーへ適用し、それぞれ厳密型契約と拒否契約が失敗することを確認する。
core API・外部依存・Web標準の方針・業務エラーの集合は変更しない。

Receipt側の精密化は未完了である。純粋な遷移だけでなく、その後のstockChange・
withStock・includeChangedStockでも状態型が広がるため、公開操作まで確認する必要がある。
また、入荷3箇所の文脈注釈と今回の状態型は別問題である。
講演の84話題の判定、9件のpartial、原音確認、独立利用者の未実施は変更しない。
