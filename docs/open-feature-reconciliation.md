# 未完了Issueと現在の実装の照合

2026-11-25にGitHubの未完了Issue #1–#8を初回照合した実装revisionは
`6c78970b8b5fb8f23b54cfdd684f332ae6f2f15b`。以後の実装は下段に記録し、表も更新している。
Issueがopenであること自体を未実装の証明にはせず、提案の完了条件と現行コードを区別する。
ここにある将来案すべてが講演で要求された機能という意味でもない。

| Issue | 現在使える根拠 | 満たしたと扱えない条件 |
| --- | --- | --- |
| [#1 共通transaction](https://github.com/yukiharada1228/koyuki/issues/1) | `src/expenses/sqlite.ts`のsaveは状態と履歴を同一transactionで保存する。タグ・調達にも個別adapterがある | [同期共通境界](transactions.md)をタグ・経費・経費receiptへ接続済み。callback型の[非同期契約](transactions.md)もPrismaへ接続済み。Target全体の相関観察、他driverの追加検証は未完了 |
| [#2 相関trace](https://github.com/yukiharada1228/koyuki/issues/2) | [Application実行IDと詳細trace](application-execution.md)で待機・開始・実行段階・投影後の完了を関連付ける | 段階の報告は事後。live timing・親子span・裸のProgram全体の共通APIは未提供 |
| [#3 構成図](https://github.com/yukiharada1228/koyuki/issues/3) | [JSON/Mermaid構成図](flow-structure.md)で明示branch・IO・保存を保持。既存Traceの名前を重ねる | 送料関数内部のifはopaqueで、branchを捏造しない。状態図・完全なnode実行対応は未提供 |
| [#4 再送と限定retry](https://github.com/yukiharada1228/koyuki/issues/4) | [withReplay](replay.md)、[永続receipt](procurement-replay.md)は応答喪失・同時再送・要求不一致等を扱う | `src/framework/replay.ts`のwithReplayはcommandを再試行しない。試行上限・待機・中断・保持期限を備える共通retry方針は別途必要 |
| [#5 共通監査](https://github.com/yukiharada1228/koyuki/issues/5) | [共通形式とSQLite原子保存](audit.md)をタグ・経費へ接続。監査障害のrollbackと再送非重複を検査 | 他DB adapter、保持・削除の実運用、改ざん耐性、拒否ログは未実装・未検証。診断traceを監査とは呼ばない |
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

## 同期境界の実装後の差分

上表の#1は同期adapter向けに更新した。[契約・検査・制限](transactions.md)を参照。
共通境界の追加によって#4の限定retryや#5の監査形式まで完成したとは扱わない。

## 共通監査の追加

#5は[SQLiteの成功監査](audit.md)を追加した。監査表があるDBへの設定なしの更新も拒否する。
保持・削除・改ざん耐性については保証範囲を明記し、運用検証まで完了したとは扱わない。

## Application観察の追加

#2へ[Applicationの実行観察](application-execution.md)を追加した。詳細commandを二重に実行せず、
段階名と成否を同じexecutionIdへ接続する。各段階のlive timingや親子spanは未充足として残す。

## 宣言構成図の追加

#3へ[構成図](flow-structure.md)を追加。通常の関数やIOを実行せず、明示した構成だけを取得する。
名前の重複は曖昧として表示し、関数内部の分岐や業務状態図を自動で証明したとは扱わない。
