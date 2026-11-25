# 3講演に対する現在の判定

**部分充足。業務の状態・検証・遷移を宣言し、接続と実行を委譲する核は実装・検証している。**
講演全内容の完全実現、React/Elmと同等の開発体験、一般的な生産性優位はまだ確認できていない。
この判定は、下記のコードと検査が対象とする範囲に限る。

## 原資料を確認した範囲

| 対象 | 確認済み | 残る確認 |
| --- | --- | --- |
| 保存済み字幕 | 3本4034行を84区間へ対応付け。原文hash・範囲・実装根拠を記録 | 自動字幕の誤認識と発話の照合 |
| 登壇者の公開PDF | 3件198ページの本文とレンダリングを逐次確認し、全ページの対応を記録 | 記載された全コード例の実行、参照先全文、非公開製品仕様 |
| 動画の画面 | 抽出した静止画・補足画像を確認 | 全フレーム・連続音声映像との照合 |

来歴は[資料manifest](lecture-decks.json)、解釈と実装根拠は[詳細照合](lecture-audits/README.md)。
check:lecture-auditとcheck:lecture-decksは、原文の同一性・割り当て・根拠パス等を検査する。
解釈・実装の完全性や視聴を自動証明するものではない。

## 業務フレームワークとしての要件

「確認済み」は、列挙した実例・検査が通るという意味。任意の業務・外部基盤への一般保証ではない。

| 要件 | 実装と検査 | 現在の限界 |
| --- | --- | --- |
| 状態を直和と必要なpayloadで表す | [domain](../src/tags/domain.ts)、[直和の検査](../src/sum-model.test.ts) | 型アサーションや外部入力は別の検証が必要 |
| 検証済みの前提を次段へ渡す | private brand、[配布入力契約](workflow-input-contract.md) | 業務規則そのものの正しさや純粋性を型だけで証明しない |
| 普通の関数を並べ、Resultの接続を任せる | [business](business.md)、実tarballの型・実行検査 | [読み込みの接続試作](procurement-load-composition.md)でも定型分岐は減るが、書き心地の優位は未確認。工程・順番・必要な業務判断は利用者が宣言する。通常実行はopaque値を渡せるが、診断・Application・永続adapterには別の契約がある |
| 検証→要件→更新の定型処理を委譲する | [defineTransition](declarative-transitions.md) | [generic要件と未注釈evolve](transition-inference-study.md)の推論制限は未解消 |
| 失敗した段階で後続計算・保存を止める | Workflow / Process / command / businessの検査 | 既に確定した別工程の副作用を自動rollbackしない |
| 成功と失敗の型を保持する | [入力・成功・失敗型の検査](../src/business-api-types.test.ts)、[generic saveの成功型](business-save-inference.md)、配布宣言の拒否検査 | 64段の検査を無制限長の保証にしない |
| 直和に応じて異なる関数へ分岐する | [型ガード付きbranch](typed-branch.md)、[顧客照合](customer-import-study.md) | 型ガードの真偽は利用者の責任 |
| 複数の値生成と失敗方針を明示する | [combine](combine.md)、collect / collectEach / foldEach | 評価済みResultと遅延実行、先頭失敗と全失敗収集を選ぶ必要がある |
| I/Oを純粋な計算から分離し、途中I/Oも接続する | [Process](process.md)、[複数集約](business-composition-study.md)、[collectEffects](collection-effects.md) | driver・再送・transactionの方針をhostに残す |
| Applicationの実行状態・完了・viewを任せる | [Application](application-development.md)、[状態・イベントの所有](application-ownership.md)、成功・failed・crashed・再送投影の検査 | インプロセスのruntime。永続schedulerではない |
| 通常の関数・オブジェクトを自然に接続する | [Workflow再利用](workflow-input-contract.md)、[command receiver](../src/application-receiver.test.ts) | あらゆるcallbackの型注釈を省けるわけではない |
| Queryと更新の関心を分ける | [HTTP/GraphQLの実統合](../examples/leave-http/GRAPHQL.md) | [失敗enum](../examples/leave-http/GRAPHQL.md)は対応表を型検査する。SDLからの全自動型生成・clientの再生成は未提供 |
| Repositoryとtransactionを接続する | [同期・callback型の共通保存境界](transactions.md)、[Prisma](../examples/prisma-stock/README.md)、SQLiteの原子保存・CAS | 検証したdriver構成の範囲。任意DBの一括保証はない |
| 顧客の作成・更新の競合を扱う | [SQLite host](customer-import-sqlite.md)、別OS writerの待ち合わせ検査 | 高並列の負荷・耐久試験、実製品の名寄せ仕様は未検証 |
| 再送と過去の成功の再取得を扱う | receipt境界、要求一致、[要求snapshotの検査](replay-request-snapshot.md)、保存との原子性、投影を巻き戻さない検査 | 外部副作用のexactly-onceや自動再試行は保証しない |
| 人の確認を挟むイベントを接続する | [登録・メール・確認](registration-events.md)、永続outbox・lease・別OSプロセス | fake配送先での検証。scheduler・dead letter等はhostの方針が必要 |
| 途中の値を再実行なしで観測する | [選択値のcapture](workflow-observation.md)、businessのload/Rule/save/receiptと[ProcessのI/O・through](process-observation.md)の観測 | [詳細形式のloader](detailed-load.md)は内部traceを接続する。通常のResult関数は内部traceを公開しない。全値の自動永続監査・保持期間・機密項目の選択は未提供 |
| Web標準API・実行時依存ゼロで動く | [配布物の依存検査](runtime.md)、Node型なしの宣言検査・Node globalなし実行 | SQLite・Prisma等のhost依存は各サンプル側にある |

## 完了扱いにしていないこと

[未完了Issueとの照合](open-feature-reconciliation.md)では、既存の部分実装と各提案の未充足条件を分けている。
将来の機能案を講演の必須要件へ読み替えず、個別adapterの原子保存を共通transaction契約の完成とも扱わない。

- 全編の連続音声映像と自動字幕の照合。
- 独立利用者による開発体験・学習負担の評価、実業務での運用実績。[評価用課題](../examples/onboarding/README.md)と開発版配布物での成立性検査は用意したが、実際の参加者による結果は未取得。
- genericな要件計算と未注釈callbackの推論制限。
- [opaque値の通常保存](opaque-decisions.md)は改善済み。[Application・captureの情報を失うコピー](application-ownership.md)も拒否するよう改善済み。明示的なView rendererのJSON照合や、任意のopaque値を状態・永続adapterで扱う保証は残る課題。
- hostをまたぐ永続実行・再試行・監査保持の共通方針と、他DB/driverでの追加検証。
- [25操作のチーム評価案](team-development-study.md)の実装・同条件での比較。[25操作の初期実装](procurement-study.md)を実装済み。[SQLiteの複合保存と復元](procurement-sqlite.md)を検証済み。[複合Application投影](procurement-projection.md)も検証済み。[永続再送境界](procurement-replay.md)も接続済み。[25操作の接続比較](procurement-comparison.md)で3方式の結果一致を検証済み。[基本traceと保存計画](procurement-trace-comparison.md)の代表ケースも一致を検証済み。[独立再送driver](procurement-replay-comparison.md)も代表ケースを比較済み。[独立Application](procurement-application-comparison.md)も代表ケースを比較済み。比較で見つかった表示制約に対する[現在値取得](procurement-current-projection.md)も追加。[現在値取得方針](procurement-current-comparison.md)も代表ケースを比較済み。[選択値観測](procurement-observation-comparison.md)も代表ケースを比較済み。[二段階承認への仕様変更](procurement-approval-change.md)と[複数場所からの返品・訂正](procurement-return-change.md)も3方式で検証済み。[2変更の差分計測](procurement-change-measurement.md)と[認可エラーのtransportへの接続](authorization-change-study.md)も追加済み。全観測経路の比較・その他の仕様変更評価・全体の実装負担の測定は未実施。
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
