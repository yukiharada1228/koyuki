# 3講演に対する現在の判定

**部分充足。業務の状態・検証・遷移を宣言し、接続と実行を委譲する核は実装・検証している。**
講演全内容の完全実現、React/Elmと同等の開発体験、一般的な生産性優位はまだ確認できていない。
この判定は、下記のコードと検査が対象とする範囲に限る。
[有限モデルの採用評価](finite-model-adoption.md)では、型の合う不具合を検出できる一方、
不適切な状態キーでpassedになり得ることも対照検査し、任意の実験用入口としての採用に限定する。

## 原資料を確認した範囲

| 対象 | 確認済み | 残る確認 |
| --- | --- | --- |
| 保存済み字幕 | 3本4034行を84区間へ対応付け。原文hash・範囲・実装根拠を記録 | 自動字幕の誤認識と発話の照合 |
| 登壇者の公開PDF | 3件198ページの本文とレンダリングを逐次確認し、全ページの対応を記録 | 記載された全コード例の実行、参照先全文、非公開製品仕様 |
| 動画の画面 | 抽出した静止画・補足画像を確認 | 全フレーム・連続音声映像との照合 |

来歴は[資料manifest](lecture-decks.json)、解釈と実装根拠は[詳細照合](lecture-audits/README.md)。
[ローカル音声認識](lecture-local-asr.md)は全3本の別経路処理を完了し、合計9,421.599秒の音声の来歴を記録した。
全文の読み比べや直接の音声視聴の完了とは扱わない。
[1本目の照合](lecture-local-asr-iz-followup.md)は音声認識完了と全39話題の読み比べを記録し、
認識が崩れた用語を推測で補わず追加確認の対象へ残している。
[2本目の21話題](lecture-local-asr-qbf-followup.md)と[3本目の24話題](lecture-local-asr-w0o-followup.md)を合わせ、
追加のペア文面比較は84/84話題で完了した。原字幕の初回全件レビューと、この追加比較は区別する。
3本の記録には直接音声確認が必要な10区間を残している。文面の比較完了は発話の正確性や実装の完全性の証明ではない。
[実行境界等の追加後の再照合](lecture-runtime-reconciliation.md)では、字幕4区間・PDF6ページへ戻り、
trace・capture・成功監査・構成図の保証を区別した。初回の全区間・全頁レビューや未確認flagは維持している。
check:lecture-auditとcheck:lecture-decksは、原文の同一性・割り当て・根拠パス等を検査する。
解釈・実装の完全性や視聴を自動証明するものではない。

[中心的な開発体験への追加照合](lecture-core-focus.md)では、接続済みライブラリの3字幕区間と
保存済み字幕を再確認した。返却101件は本文がすべて一致し、独立した音声確認の証拠とはしない。
途中で切られた窓はローカル字幕で補い、機能追加と書き心地の実証を分けて優先順位を整理した。

[通常APIと観測の再照合](lecture-ordinary-api-observation.md)では、同じ3区間の保存済み字幕へ戻り、
個別loadの省略・生成100/500操作・購買25操作の観測検査を対応付けた。
履歴をdumpできるという説明と、既定の自動永続収集・保持方針の実装要求は区別する。

## 業務フレームワークとしての要件

「確認済み」は、列挙した実例・検査が通るという意味。任意の業務・外部基盤への一般保証ではない。

| 要件 | 実装と検査 | 現在の限界 |
| --- | --- | --- |
| 状態を直和と必要なpayloadで表す | [domain](../src/tags/domain.ts)、[直和の検査](../src/sum-model.test.ts) | 型アサーションや外部入力は別の検証が必要 |
| 宣言した遷移を独立仕様と照合する | [明示モデルの検査入口](finite-model.md)と[経費の有限探索](expense-state-exploration.md)。一回の承認過程は37状態・1,776操作を探索し、自己承認・終端再承認を拒否 | 編集再申請を含む全操作は深さ7によるlimited。keyの同値性・抽象化・実装対応は利用者が指定。無限状態・DB競合・任意業務の証明ではない |
| 再現する操作列と縮小した反例を得る | [seed付きモデル検査](model-sequences.md)で経費6,144操作を独立仕様と照合。[タグ](tag-model-sequences.md)はメモリ・SQLite各320操作を比較。[非同期比較](async-model-sequences.md)と[指定payload候補](event-payload-shrinking.md)でも反例を縮小。[初期状態の縮小](initial-state-shrinking.md)は経費の反例で検査 | sampledは全状態の証明ではない。縮小は予算付きで、1削除での最小性とlimitedを区別する。外部状態の隔離・簡略化候補はhost側。[テスト雛形](model-test-template.md)を出力できるが、期待仕様・生成器・比較は利用者が記述する。全候補での最短・最小の初期状態は保証しない |
| 確定変更の再保存を生成検査する | [タグの変更再保存](tag-replay-model-sequences.md)で同一・旧版・改変スナップショットをメモリ／SQLite各384操作で比較し、生成テストも配布物で実行 | 逐次の変更スナップショットが対象。要求ID付きの元入力・応答喪失・並行競合・監査行数をこの生成契約で網羅したとはしない |
| 要求ID付き再送を生成検査する | [経費の要求モデル](expense-request-model-sequences.md)で要求の同一性と履歴を独立に記述し、通常384辺と51辺、保存後の応答/事後照会喪失384辺と6操作の列で出力と現在のDB状態を比較。生成コードも配布物で検査 | 逐次・単一経費・既定の定義versionが対象。他の喪失点・並行競合・監査行数・Application表示をこの生成契約で網羅したとはしない |
| 読み込み済みの並行要求を生成検査する | [経費の競合モデル](expense-race-model-sequences.md)で10ケースを左右両順で比較し、3 seed・36バッチも生成。結果・DB状態・receipt/履歴件数を先に計算した許容候補と照合 | 同一プロセスの二接続と制御した進行順。別OSプロセスの生成競合、全割込み点、応答喪失との複合故障はこの生成器の対象外 |
| 検証済みの前提を次段へ渡す | private brand、[配布入力契約](workflow-input-contract.md) | 業務規則そのものの正しさや純粋性を型だけで証明しない |
| 普通の関数を並べ、Resultの接続を任せる | [business](business.md)、実tarballの型・実行検査。[共通generic検証](business-generic-checks.md)では具体的な文脈と、検証が追加するprivate brandを保持して通常関数を再利用。[注文3操作](procurement-order-guards.md)と[申請5操作・請求書2操作](procurement-shared-guards.md)の共通検証を関数列へ接続。[入荷・在庫の3操作](procurement-receipt-pipeline.md)も成功値と元の文脈を併用して接続。[取得成功値の投影](effect-projection.md)を[25操作のhost load](procurement-framework-context.md)へ適用。[全操作が個別loadを持つ場合](business-local-load.md)は未使用の共通loadを省略可能 | 書き心地の優位は未確認。工程・順番・入力構築・必要な業務判断は利用者が宣言する。通常実行はopaque値を渡せるが、診断・Application・永続adapterには別の契約がある |
| 共通generic loadと異なる要求型を接続する | [inputを持つ文脈の推論](business-generic-load.md)で、loadが必要な文脈を保証する場合に、最初のRuleから操作ごとの要求型を保持。経費の参考実装のload特殊化を共通loadへ削減 | 任意のgeneric関数の型適用ではない。動的候補・要求条件・文脈全体の保証を検査し、成立しない場合は明示的なloadが必要。独立利用者の書き心地は未確認 |
| 検証→要件→更新の定型処理を委譲する | [defineTransition](declarative-transitions.md) | [generic要件と未注釈evolve](transition-inference-study.md)は、具体的な関数を名前付きstepにする例を検証。ただし名前なしinlineと多相関数等の推論制限は未解消 |
| 失敗した段階で後続計算・保存を止める | Workflow / Process / command / businessの検査 | 既に確定した別工程の副作用を自動rollbackしない |
| 成功と失敗の型を保持する | [入力・成功・失敗型の検査](../src/business-api-types.test.ts)、[宣言の所有権](declaration-ownership.md)、[動的commandの入力契約](application-input-contract.md)、[generic saveの成功型](business-save-inference.md)、配布宣言の拒否検査。[100/500操作](business-scale.md)の全入力/出力対応と認可欠落拒否も検査 | 64段・生成500操作を無制限の保証にしない。巨大な単一モジュール本体ではTypeScriptの制御フロー解析上限も再現。実業務500種類や独立利用者の生産性の実証ではない |
| 直和に応じて異なる関数へ分岐する | [型ガード付きbranch](typed-branch.md)、[顧客照合](customer-import-study.md) | 型ガードの真偽は利用者の責任 |
| 複数の値生成と失敗方針を明示する | [combine](combine.md)、[フィールドのcollect](validation-fields.md) / collectEach / foldEach | 評価済みResultと遅延実行、先頭失敗と全失敗収集を選ぶ必要がある。collectのテーブルは通常のownデータrecord |
| I/Oを純粋な計算から分離し、途中I/Oも接続する | [Process](process.md)、[複数集約](business-composition-study.md)、[collectEffects](collection-effects.md) | driver・再送・transactionの方針をhostに残す |
| Applicationの実行状態・完了・viewを任せる | [Application](application-development.md)、[状態・イベントの所有](application-ownership.md)、成功・failed・crashed・再送投影の検査 | インプロセスのruntime。永続schedulerではない |
| 通常の関数・オブジェクトを自然に接続する | [Workflow再利用](workflow-input-contract.md)、[command receiver](../src/application-receiver.test.ts) | あらゆるcallbackの型注釈を省けるわけではない |
| 接続ミスの位置を診断する | [businessの段階診断](business-diagnostics.md)を実tarballの既定のcompiler表示で検査 | 操作名・配列位置・入力/保存出力の不一致を対象にする。全診断の表示保証・推論制限の解消・独立利用者の修正時間の実証ではない |
| 明示した宣言メタデータの問題を実行せず確認する | [ソース診断CLI](declaration-diagnostics.md)で段階名・操作ID・Application予約名を位置付きで報告。タグ・経費の11宣言と、購買のbusiness 25操作の既定IDを検査。明示Workflowのthen/branchとconst参照で同名traceの曖昧さも警告し、送料の3構成でも非実行検査。Processのeffect・through・bindMutationも接続し、明示した複数ソースのexport const参照を限定解決して位置を診断 | Koyuki独自の具体化。独自resolver・動的定義等は未解決で残し、全参照・分岐・状態・純粋性を証明しない。解析packageは開発依存のみ |
| 操作宣言と生成されるキーを揃える | [操作テーブルの回帰検査](business-operation-table.md)で非列挙データ、Symbol拒否、数値名の実行型と型宣言を照合 | 操作テーブルは通常のownデータrecord。構造的な型だけではprototype/getter等を表せないため構築時にも確認する。任意のJS objectの型宣言を証明しない |
| 宣言した操作をApplicationのイベントへ接続する | [Application操作テーブル](application-operation-table.md)で通常・再送・直接登録、非列挙操作と数値名の型・実行を照合 | Symbol・accessor・custom prototypeのテーブルは構築時に拒否。generic変換関数との互換性を維持し、Symbolの静的拒否までは保証しない |
| Queryと更新の関心を分ける | [HTTP/GraphQLの実統合](../examples/leave-http/GRAPHQL.md) | [失敗enum](../examples/leave-http/GRAPHQL.md)は対応表を型検査する。SDLからの全自動型生成・clientの再生成は未提供 |
| Repositoryとtransactionを接続する | [同期・callback型の共通保存境界](transactions.md)、[Prisma](../examples/prisma-stock/README.md)、SQLiteの原子保存・CAS。同期transactionの観察callbackのthrow/Promise rejectも業務結果から分離 | 検証したdriver構成の範囲。任意DBの一括保証はない。通知の非同期処理はtransactionの原子性に含めない |
| 顧客の作成・更新の競合を扱う | [SQLite host](customer-import-sqlite.md)、別OS writerの待ち合わせ検査 | 高並列の負荷・耐久試験、実製品の名寄せ仕様は未検証 |
| 再送と過去の成功の再取得を扱う | receipt境界、要求一致、[要求snapshotの検査](replay-request-snapshot.md)、保存との原子性、投影を巻き戻さない検査 | 外部副作用のexactly-onceや自動再試行は保証しない |
| 明示した条件で限定的に再試行する | [retryEffect](retry.md)で失敗ごとの安全条件・試行上限・待機・中断を指定。SQLiteの応答・照会喪失でも更新1回を検査 | 未適用・冪等性はhostの契約。実行中のIOを強制停止しない。各試行のspan・永続scheduler・receipt保持運用は未提供 |
| 人の確認を挟むイベントを接続する | [登録・メール・確認](registration-events.md)、永続outbox・lease・別OSプロセス | fake配送先での検証。scheduler・dead letter等はhostの方針が必要 |
| 途中の値を再実行なしで観測する | [選択値のcapture](workflow-observation.md)、businessのload/Rule/save/receiptと[ProcessのI/O・through](process-observation.md)の観測。[購買25操作](procurement-observation-comparison.md)はメモリ・SQLiteで選択値と射影失敗時の保存結果を3方式比較 | [詳細形式のloader](detailed-load.md)は内部traceを接続する。通常のResult関数は内部traceを公開しない。全値の自動永続監査・保持期間・機密項目の選択は未提供 |
| 処理の宣言構成を実行せず確認する | [JSON/Mermaid構成図](flow-structure.md)、タグ・送料・明示branchの非実行検査 | 関数内部はopaque。状態遷移図・完全な制御フロー・node/span対応は未提供 |
| Applicationから業務段階を同じ実行として観察する | [実行IDと詳細traceの接続](application-execution.md)、失敗・再送・分岐・並行sessionの検査。[Program単体](program-execution.md)も待機・更新・副作用・完了を観察できる | 対応するcoreは処理中の段階時間・親子spanも通知。opaque関数内部・分散相関・永続履歴は未提供 |
| 成功変更の共通監査を保存する | [共通形式・SQLite原子保存](audit.md)、タグと経費でのrollback・再送・競合検査 | SQLiteサンプルの範囲。保持・削除の運用、改ざん耐性、拒否ログ、他DBは未提供 |
| Web標準API・実行時依存ゼロで動く | [配布物の依存検査](runtime.md)、Node型なしの宣言検査・Node globalなし実行 | SQLite・Prisma等のhost依存は各サンプル側にある |
| 通常の接続実装と実行負担を比較する | [ソース計測](procurement-runtime-results.md)に加え、[配布用JSの修正前後4試行](procurement-built-results.md)を来歴付きで記録。構築時の割り当てを削減 | 構築時の限定改善を確認。通常実行の高速化・plainへの性能優位は未証明。実運用・全機能・独立利用者の生産性の測定ではない |

## 観測契約の追加確認

観測処理の追加点検では、同期captureへ誤ってasync関数を渡すと、値はCaptureFailedになっても
返されたPromiseのrejectが未処理になる不具合を再現・修正した。
[回帰検査](../src/capture-rejection.test.ts)は業務結果・保存回数・同期inspectの例外契約と、
then getterを実行しないことを確認する。対象は同じrealmの通常のnative Promiseであり、
非同期captureを待つ機能や、任意のcallbackの副作用を隔離する保証ではない。
講演がasync captureの仕様を指定していたという意味ではなく、Koyuki自身の契約の改善である。

## 完了扱いにしていないこと

[未完了Issueとの照合](open-feature-reconciliation.md)では、既存の部分実装と各提案の未充足条件を分けている。
再点検では#1〜#5の元の完了条件を、指定した実例で検証できることを確認した。
他DB・分散相関・保持運用などの追加範囲を元の完了条件へ混ぜず、講演全体の完成とも扱わない。
個別adapterの原子保存だけで任意driverの共通transaction契約を証明することもできない。

- 全編の連続音声映像と自動字幕の照合。
- 独立利用者による開発体験・学習負担の評価、実業務での運用実績。[評価用課題](../examples/onboarding/README.md)と開発版配布物での成立性検査は用意したが、実際の参加者による結果は未取得。利用者への確認でも独立した試用記録はまだないとの回答であり、保守者側の検査を代用しない。
- genericな要件計算と未注釈callbackの推論制限。
- [再送付きbusinessのcallback推論](replay-context-inference-study.md)は専用overloadで改善した。検証した無注釈例を超える、あらゆるcallbackの推論省略は保証しない。
- [opaque値の通常保存](opaque-decisions.md)は改善済み。[Application・captureの情報を失うコピー](application-ownership.md)も拒否するよう改善済み。明示的なView rendererのJSON照合や、任意のopaque値を状態・永続adapterで扱う保証は残る課題。
- hostをまたぐ永続実行・再試行・監査保持の共通方針と、他DB/driverでの追加検証。
- [25操作のチーム評価案](team-development-study.md)の実装・同条件での比較。[25操作の初期実装](procurement-study.md)を実装済み。[SQLiteの複合保存と復元](procurement-sqlite.md)を検証済み。[複合Application投影](procurement-projection.md)も検証済み。[永続再送境界](procurement-replay.md)も接続済み。[25操作の接続比較](procurement-comparison.md)で3方式の結果一致を検証済み。[基本traceと保存計画](procurement-trace-comparison.md)の代表ケースも一致を検証済み。[独立再送driver](procurement-replay-comparison.md)も代表ケースを比較済み。[独立Application](procurement-application-comparison.md)も代表ケースを比較済み。比較で見つかった表示制約に対する[現在値取得](procurement-current-projection.md)も追加。[現在値取得方針](procurement-current-comparison.md)も代表ケースを比較済み。[選択値観測](procurement-observation-comparison.md)は全25操作を通る成功シナリオも比較済み。[二段階承認への仕様変更](procurement-approval-change.md)と[複数場所からの返品・訂正](procurement-return-change.md)も3方式で検証済み。[2変更の差分計測](procurement-change-measurement.md)と[認可エラーのtransportへの接続](authorization-change-study.md)も追加済み。全失敗・分岐・再送を含む全観測経路の比較、その他の仕様変更評価、全体の実装負担の測定は未実施。
- 公開されていない元製品の予約取込・テーブル割当等との仕様の等価性。

型クラス、Union-Find、ナップザック等の説明例や参照書籍全体は、設計思想を説明する文脈として記録した。
それらを業務runtimeへ丸ごと内蔵する機能要件にはしていない。
講演の経験談を、Koyukiの普及率・バグ率・生産性の実測結果へ置き換えない。

## 再検証する入口

[継続検査の構成](ci.md)で、core・独立consumer・永続adapterの検査をCIへ登録する。
記録の参照・区間・ページの整合性はCIで継続検査する。原文のhashと実際の字幕行の照合は、
ローカル保存先を渡して別途実行する。

```sh
npm run check
npm run check:package
npm run test:portable
npm run test:business:package
npm run test:registration:package
npm run test:prisma:package
npm run check:lecture-audit -- /path/to/functional-business-talks
npm run check:lecture-decks -- /path/to/functional-business-talks
```

配布検査は開発版tarballを一時ディレクトリへinstallする。npm公開は行わない。
source hashを検査する最後の2コマンドは、本人公開資料等のローカル保存先を必要とする。
各検査の成功を、上表で対象外としている項目の証拠には使わない。
