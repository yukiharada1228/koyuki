# 未完了Issueと現在の実装の照合

2026-11-25時点。対象はGitHubの未完了Issue #1–#8と、照合時の実装revision
`6c78970b8b5fb8f23b54cfdd684f332ae6f2f15b`。
Issueがopenであること自体を未実装の証明にはせず、提案の完了条件と現行コードを区別する。
ここにある将来案すべてが講演で要求された機能という意味でもない。

| Issue | 現在使える根拠 | 満たしたと扱えない条件 |
| --- | --- | --- |
| [#1 共通transaction](https://github.com/yukiharada1228/koyuki/issues/1) | `src/expenses/sqlite.ts`のsaveは状態と履歴を同一transactionで保存する。タグ・調達にも個別adapterがある | adapter共通の契約、ネスト・commit失敗・例外の統一した扱い。個別実装が動くことと共通契約の完成は別 |
| [#2 相関trace](https://github.com/yukiharada1228/koyuki/issues/2) | Workflow / Processのtrace、[詳細loader](detailed-load.md)、[選択値の観測](process-observation.md)、Applicationの購読がある | dispatchから内部完了まで共通の実行ID・親子関係・所要時間で相関するイベント契約。選択captureがあることだけでは全条件を満たさない |
| [#3 構成図](https://github.com/yukiharada1228/koyuki/issues/3) | `src/framework/workflow.ts`のstepsは名前の列を保持する | 分岐・IO・保存境界を保持する静的構造、JSON/Mermaid出力、実行経路との対応。名前の列から完全な構造や業務状態遷移を復元できるとは扱わない |
| [#4 再送と限定retry](https://github.com/yukiharada1228/koyuki/issues/4) | [withReplay](replay.md)、[永続receipt](procurement-replay.md)は応答喪失・同時再送・要求不一致等を扱う | `src/framework/replay.ts`のwithReplayはcommandを再試行しない。試行上限・待機・中断・保持期限を備える共通retry方針は別途必要 |
| [#5 共通監査](https://github.com/yukiharada1228/koyuki/issues/5) | 経費の状態履歴、receipt、診断traceがある | 信頼された操作者・定義version等を含む共通監査形式と、状態との原子保存。診断traceや選択captureをそのまま監査ログとは呼ばない |
| [#6 宣言検査](https://github.com/yukiharada1228/koyuki/issues/6) | [接続の型検査](workflow-input-contract.md)、配布宣言の負例がある | 重複ID・未登録参照等の位置付き診断CLI。型の接続検査をメタデータの検査や業務規則の証明とは扱わない |
| [#7 有限モデル検査](https://github.com/yukiharada1228/koyuki/issues/7) | 直和状態と状態遷移の具体例・テストがある | 明示した抽象モデルの探索、探索上限、反例列、実装との対応検査。手書きの遷移テストを到達可能性の網羅検査とは扱わない |
| [#8 テスト生成](https://github.com/yukiharada1228/koyuki/issues/8) | [仕様変更比較](procurement-change-measurement.md)やメモリ/SQLiteの具体例検査がある | 独立した参照仕様に基づく生成、再現seed、失敗列の縮小。既存の手書きテスト数は生成器の完成を示さない |

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
