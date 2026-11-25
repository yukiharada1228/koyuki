# 購買25操作の比較：業務接続の一致を先に確認する

通常TypeScript・小さなhelper・Koyukiの3方式を実装し、
同じ25操作を含む32回の成功シナリオについて、返り値と全保存状態の一致を確認した。
メモリ／SQLiteの両方で実行した。これは接続方式の比較の第一段階であり、
再送・trace・Applicationまで含む同等機能比較の完了ではない。

## 共有部分と違い

| 対象 | 3方式での扱い |
| --- | --- |
| 業務型・検証・遷移 | domain.ts、inventory.tsを共有 |
| 認証済みactor・policyのsnapshot | 同じ契約。plain/helperはcontext.ts、Koyukiはcontext-framework.ts |
| 複数モデルのloadと関連照会 | plain/helperは手続き型context、Koyukiは[Process context](procurement-framework-context.md)。結果と順序を別途照合 |
| 保存・CAS・一意性・復元・複合transaction | 同じMemory／SQLite adapterを使用 |
| load → domain → saveの接続 | 各方式で別実装 |
| 基本trace・保存計画 | [追加比較](procurement-trace-comparison.md)で代表的な成功・失敗を検証 |
| 永続再送 | [独立driver比較](procurement-replay-comparison.md)で代表的な要求・障害・重複を検証 |
| Application | [独立session比較](procurement-application-comparison.md)で代表的な状態・queue・通知・再送を検証 |
| 選択値の観測 | [capture比較](procurement-observation-comparison.md)で代表的なsnapshot・失敗分離・並行性を検証 |

通常TypeScript版は`plain.ts`で各操作にResultの分岐と保存を明記する。
helper版は`helper.ts`のaction関数へ同じ処理をまとめ、操作ごとにloadと業務関数を渡す。
共通化を禁止して通常TypeScriptを不利にしない。
Koyuki版は既存のbusiness宣言を使い、Process contextのloadと同じ業務関数を接続する。

初回比較ではcontextを共有していた。後続の[loader適用](procurement-framework-context.md)ではKoyuki側を分離し、
plain/helperがKoyukiのProcessを実行する循環を避けた。型とactorの注入境界は維持し、
既存の再送・Application・SQLiteテストも継続する。現在はhost contextの2系統の保守も評価対象となる。

domain/contextは共通のResult型とok/errを使う。基準実装はbusiness/Workflowを実行しないが、
Koyukiのコード・依存を一切使わない別製品を作ったという比較ではない。
共有domain自体のバグは3方式すべてに現れ得る。結果一致だけで業務仕様の正しさは証明しない。

## 実行したシナリオ

申請の作成・明細変更・申請・取り下げ・再申請・担当変更・差し戻し・承認と、別申請の却下を行う。
発注は仕入先変更・取消・再発行を経由し、検収を訂正・返品・再入荷する。
不一致請求は無効化して登録し直し、照合・請求承認・発注完了・支払記録・支払取消まで進める。
在庫の引当・解除・移動・棚卸調整も同じシナリオで実行する。

25種類の操作に少なくとも一度成功し、32回すべての結果と全6モデルの最終状態を比較する。
成功件数だけでなく、申請version 9、完了発注、在庫version 8、棚卸調整後の実在庫3・引当0も直接検査する。
このメモリKoyuki結果との一致を3方式×2adapterで検査する。
SQLiteで全25操作の成功経路を実行する範囲も、これにより追加した。

別途、空明細・未取得対象・非所有者・申請上限変更で停止し、保存しないことを3方式で検査する。
`src/procurement-comparison.test.ts`を、実tarballの独立consumerでもコンパイル・実行する。
テストの所要時間はbenchmarkではなく、速度差として使わない。
[構築と実行の専用計測](procurement-runtime-results.md)は、同じシナリオを共有し、
2プロセスの試行を別途実施した。限定例では実行・構築の負担が確認でき、性能の優位は示していない。

## 型で分かった違い

両基準実装も入力の必須項目を保持し、不正なsubmit/moveの入力を型検査で拒否する。
二段階承認への仕様変更後、承認成功型はplain/helperではApproved | FinalReviewとなる。
初回比較ではKoyukiの共通saveがRequest全体を返す制限があったが、
[generic saveの推論](business-save-inference.md)を改善し、通常procurementもApproved | FinalReviewを保持する。
3方式の成功型を配布consumerで検査し、Koyukiだけが型安全だという結論にはしない。

型の記述量やエラー文面の使いやすさを独立利用者が評価したわけではない。
procurementChangesのCommitted envelopeも改善したが、任意のgeneric保存関数を特殊化する保証はない。
core businessの再送は、現在のRuleより広い過去の成功型を許す契約を維持する。

## まだ比較していないこと

- 3方式へ同じ再送・未知commit照会・実行trace・観測・Applicationを接続した全体コスト。
- 3方式の同等transport/runtimeを含む認可・監査方針の変更比較。[休暇の認可エラー](authorization-change-study.md)は別途、純粋判断とKoyukiのtransportを検証。二段階承認と複数場所の返品・訂正は[差分の再集計](procurement-change-measurement.md)まで追加済み。
- 共通基盤・adapter・テストを含むソース量と、導入・型検査のコスト。
- 独立参加者の実装時間・レビュー負担・オンボーディング、実運用のバグ率。

この段階ではLOCの優位性や生産性改善率を計算しない。
同じ保存境界で同じ業務結果を返すという前提を確認できたので、次は同等の実行機能と仕様変更を比較する。
講演の標準化構想に対する検証を進めるための基準実装であり、普及や大規模開発の有効性の証明ではない。


[基本traceと保存計画の比較](procurement-trace-comparison.md)を追加した。
基準実装側にも段階通知と呼出しごとの記録基盤を用意し、代表ケースのreport全体と例外・並行呼出しの結果を比較する。
これは再送・Applicationを含む全体コスト比較を置き換えるものではない。


[独立した永続再送driverの比較](procurement-replay-comparison.md)を追加した。
同じSQLite/identity境界の下で、基準実装側のsnapshot・照会・業務実行・記録・失敗後照会を検証する。
Applicationと値の観測を含む全体比較は引き続き未完了。


[独立したApplication driverの比較](procurement-application-comparison.md)を追加した。
状態・revision・通知・実行履歴・queue・例外復旧を代表ケースで比較し、応答消失後に自動refreshしない制約も確認した。
値の観測と仕様変更を含む全体評価は引き続き未完了。


[現在値取得付きApplicationの比較](procurement-current-comparison.md)も追加した。
応答消失後の表示更新・不正patchの拒否・現在値取得待ちのqueueを3方式で検証する。


[選択値観測の比較](procurement-observation-comparison.md)も追加した。
通常業務commandのload/rule/saveで、選択・clone・観測失敗の分離・並行呼出しの記録を比較する。
再送lookup等の全観測経路、仕様変更差分、実装負担は引き続き評価対象。

[2件の仕様変更の差分計測](procurement-change-measurement.md)を追加した。
3方式とも操作接続の変更はゼロで、業務・host・試作・テスト・資料の変更を分類している。
この局所的な結果は、新規実装の総コストや生産性の比較を完了したという意味ではない。
