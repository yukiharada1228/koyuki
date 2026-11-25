# 未完了Issueと現在の実装の照合

2026-11-25にGitHubの未完了Issue #1–#8を初回照合した実装revisionは
`6c78970b8b5fb8f23b54cfdd684f332ae6f2f15b`。以後の実装は下段に記録し、表も更新している。
Issueがopenであること自体を未実装の証明にはせず、提案の完了条件と現行コードを区別する。
ここにある将来案すべてが講演で要求された機能という意味でもない。

| Issue | 現在使える根拠 | 満たしたと扱えない条件 |
| --- | --- | --- |
| [#1 共通transaction](https://github.com/yukiharada1228/koyuki/issues/1) | `src/expenses/sqlite.ts`のsaveは状態と履歴を同一transactionで保存する。タグ・調達にも個別adapterがある | [同期共通境界](transactions.md)をタグ・経費・経費receiptへ接続済み。callback型の[非同期契約](transactions.md)もPrismaへ接続済み。Target全体の相関観察、他driverの追加検証は未完了 |
| [#2 相関trace](https://github.com/yukiharada1228/koyuki/issues/2) | [Application実行IDと詳細trace](application-execution.md)で待機・開始・実行段階・投影後の完了を関連付ける。[Program単体](program-execution.md)にも同じ観察入口を追加 | 対応するcoreのlive timing・親子spanを追加。opaque関数内部・分散相関・永続履歴は未提供 |
| [#3 構成図](https://github.com/yukiharada1228/koyuki/issues/3) | [JSON/Mermaid構成図](flow-structure.md)で明示branch・IO・保存を保持。既存Traceの名前を重ねる | 送料関数内部のifはopaqueで、branchを捏造しない。状態図・完全なnode実行対応は未提供 |
| [#4 再送と限定retry](https://github.com/yukiharada1228/koyuki/issues/4) | [withReplay](replay.md)、[永続receipt](procurement-replay.md)、[明示的なretryEffect](retry.md)で上限・待機・中断・失敗の安全条件を指定 | withReplay単体は再試行しない。未適用・冪等性はhostの保証。receiptの期限・削除・定義version移行の運用は未提供 |
| [#5 共通監査](https://github.com/yukiharada1228/koyuki/issues/5) | [共通形式とSQLite原子保存](audit.md)をタグ・経費へ接続。監査障害のrollbackと再送非重複を検査 | 他DB adapter、保持・削除の実運用、改ざん耐性、拒否ログは未実装・未検証。診断traceを監査とは呼ばない |
| [#6 宣言検査](https://github.com/yukiharada1228/koyuki/issues/6) | [接続の型検査](workflow-input-contract.md)、配布宣言の負例。[非実行のソース診断CLI](declaration-diagnostics.md)で明示/既定ID・段階名・Application予約名を位置付きで報告 | 独自resolver・動的定義は未解決として残す。全参照の解決、分岐・状態の網羅性、エディター診断、任意の変更解析は未提供。型・構文・メタデータ検査を業務規則の証明とは扱わない |
| [#7 有限モデル検査](https://github.com/yukiharada1228/koyuki/issues/7) | [明示モデルの有限探索](finite-model.md)で上限・反例・実装比較を指定。[経費](expense-state-exploration.md)は最大7操作で照合 | 実験用の検査入口。モデルの同値性・抽象化・実装対応は利用者の契約。チームの保守コスト・導入効果は未測定 |
| [#8 テスト生成](https://github.com/yukiharada1228/koyuki/issues/8) | [seed付き操作列と反例削除](model-sequences.md)で経費を独立仕様と照合。[タグ](tag-model-sequences.md)はメモリ・SQLite各320操作を比較。[非同期比較](async-model-sequences.md)と[指定payload候補の縮小](event-payload-shrinking.md)も両adapterで検査。[初期状態候補](initial-state-shrinking.md)は経費の反例でも縮小 | DB等の隔離・簡略化候補はhostの契約。雛形出力、全候補での最短列は未提供・未検証。sampledを完成・全状態の証明としない |

## 次に実装する境界

最初は#1を対象にする。#5の成功監査と#4のreceiptも、同じ保存先で状態と原子的に保存できる契約に依存するため。
新しい業務DSLを増やす前に、タグと経費の既存業務関数を変えず、保存adapterの接続を揃える。

実装前に固定すべき契約は次のとおり。

1. transactionの範囲は同じadapter・保存先内。外部HTTPや別DBを暗黙に含めない。
2. callbackのResult失敗、throw/reject、commit失敗を区別し、状態と履歴の片方だけが残らないことを確認する。commit結果が不明な場合を「必ず未保存」と偽らない。
3. ネストは明示して拒否するか、adapterが提供するsavepoint等で意味を定義する。同じ接続を並行利用して別操作のtransactionへ混入させない。
4. 開始・確定・失敗の観察側の例外で、確定済み保存を失敗に置き換えない。入力や操作者情報を既定で収集しない。
5. 経費の履歴書込み失敗、タグの保存失敗、別接続・別プロセス競合、commit障害を実際のadapterと障害注入で検証する。fakeだけでDBの原子性を証明しない。

これは次の実装の受入条件であり、現在の共通transaction APIの仕様や完成報告ではない。
共通境界を導入しただけで監査・retry・構成図・モデル検査のIssueを完了扱いにはしない。
また、これらを実装しても独立利用者の開発体験や全編音声との照合は別途残る。

## 同期境界の実装後の差分

上表の#1は同期adapter向けに更新した。[契約・検査・制限](transactions.md)を参照。
共通境界の追加によって#4の限定retryや#5の監査形式まで完成したとは扱わない。

## 共通監査の追加

#5は[SQLiteの成功監査](audit.md)を追加した。監査表があるDBへの設定なしの更新も拒否する。
保持・削除・改ざん耐性については保証範囲を明記し、運用検証まで完了したとは扱わない。

## Application観察の追加

#2へ[Applicationの実行観察](application-execution.md)を追加した。詳細commandを二重に実行せず、
段階名と成否を同じexecutionIdへ接続する。続く開発版では対応するcoreのlive timing・親子spanも追加した。任意の関数内部や分散相関まで実現したとは扱わない。

## 宣言構成図の追加

#3へ[構成図](flow-structure.md)を追加。通常の関数やIOを実行せず、明示した構成だけを取得する。
名前の重複は曖昧として表示し、関数内部の分岐や業務状態図を自動で証明したとは扱わない。

## 経費の独立仕様探索の追加

#7の一部として[経費の遷移列](expense-state-exploration.md)を有限探索した。
初期8状態・各状態128操作・最大7操作で、到達132状態と14,464操作を照合した。
失敗14,000件を含めて独立仕様と一致し、状態の復元と保存の遷移条件も確認した。
続いて[koyuki/testing](finite-model.md)へ再利用可能な明示モデル検査を追加した。
経費の探索は深さ上限によるlimitedであり、無限の版数や#8のseed・縮小器の完成ではない。

編集を除いた一回の承認過程も別に探索し、37状態・1,776操作の有限グラフを打切りなしで検査した。
自己承認拒否15件と終端状態での再承認拒否192件を実装と照合し、モデルを意図的に壊すと
申請→自己承認の反例が出ることも確認した。詳細と抽象化の範囲は[経費の探索](expense-state-exploration.md)を参照。

## 限定retryの追加

#4へ[retryEffect](retry.md)を追加。Resultの失敗ごとに未適用または冪等性を明示し、
試行上限・待機・AbortSignalによる中断を扱う。in-flightの成功は中断で隠さない。
SQLiteではcommit応答と直後のreceipt照会の喪失を注入し、2回目の呼出しが成功記録を返すこと、
更新・履歴・receipt各1件を確認した。権限・version・idempotency競合は再試行しない例もある。
保持・削除の運用、定義versionの移行、永続scheduler、外部副作用のexactly-onceは未提供。
