# Koyukiの達成条件

目的は、業務の型・検証・不変条件・状態遷移と表示の導出に集中し、
それらのResult接続と定型的な実行管理をKoyukiへ委ねること。
「最高」は普遍的に証明できる性質ではないため、以下をレビュー可能な達成条件とする。

## 今回の範囲

1. 直和型で業務状態を表し、検証済みの証拠を型で遷移へ渡せる。
2. load → validate → require → evolve → saveのResult合成を利用者が書かない。
3. 共通の保存・再送境界を持つ複数操作は、その接続を一度宣言する。
4. 操作群をApplicationへ渡せば、操作名の再列挙なしに実行状態とViewを管理できる。
5. 異なる操作の入力・失敗型を保持し、誤接続をコンパイル時に拒否する。
6. 失敗時の後続停止、競合、rollback、再送、保存済みだが応答不明の経路を実例で検証する。
7. 経費と休暇の異なる業務で既存動作と比較し、配布パッケージからも検証する。
8. コアはWeb標準APIのみ、実行時外部依存ゼロを維持する。

対象は一回の取得・純粋な判断・保存から成る操作と、その操作を使うインプロセスApplication。
長期間の永続workflow、サービス間のexactly-once、任意の副作用の自動rollbackは対象外。
HTTPやDBの選定・認証・業務ルール・保存とreceiptの原子性は明示したadapterに置く。

## 講演との対応

保存済みの自動字幕と字幕に基づく参照資料で確認。音声付き全編の再視聴や登壇者の監修ではない。
ユーザーが提示したフレームワーク化の箇条書きは今回の製品要件として扱う。
以下は逐語引用ではなく要約で、時刻は確認のための導線。

| 出典・話題 | Koyukiでの対応 |
| --- | --- |
| [izV1h6o3hgQ 24:55](https://www.youtube.com/watch?v=izV1h6o3hgQ&t=1495s)：検証前後の型 | domainのbrandと状態Union |
| [同 33:14](https://www.youtube.com/watch?v=izV1h6o3hgQ&t=1994s)：失敗を含む計算の合成 | transitionと実行エンジンによるResult伝播 |
| [同 51:21](https://www.youtube.com/watch?v=izV1h6o3hgQ&t=3081s)：Resultで自前接続している負担とReact/Elmの比較 | 操作のdispatchから接続・実行・表示更新までをruntimeで管理 |
| [同 39:58](https://www.youtube.com/watch?v=izV1h6o3hgQ&t=2398s)：集約・Repositoryを維持 | domainとrepositoryを利用者のコードとして分離 |
| [qBf910_YiqA 18:28](https://www.youtube.com/watch?v=qBf910_YiqA&t=1108s)：取得→Workflow→保存 | defineUseCaseと操作群の接続 |
| [同 26:05](https://www.youtube.com/watch?v=qBf910_YiqA&t=1565s)：Result合成の記述負担 | 定型の成功分岐・失敗分岐をruntimeへ移す |
| [w0oLNoGsGLc 06:45](https://www.youtube.com/watch?v=w0oLNoGsGLc&t=405s)：状態更新と表示の宣言 | defineApplicationとview、購読通知 |
| [同 25:00](https://www.youtube.com/watch?v=w0oLNoGsGLc&t=1500s)：I/O間の純粋な業務処理 | load/saveと純粋なtransitionを分離 |
| [同 35:00](https://www.youtube.com/watch?v=w0oLNoGsGLc&t=2100s)：直和と直積 | 経費・休暇の状態と検証済み証拠 |

共通接続API、receiptによる再送、traceはKoyuki独自の設計。
講演がこれらの具体的APIや保証を提案・実証したという意味ではない。


## 今回の検証結果

上記の範囲をalpha.5で実装・検証した。公開alpha.4には追加APIは含まれない。

| 達成条件 | 実装・根拠 |
| --- | --- |
| 1. 状態と検証済み証拠 | 経費の状態Union、休暇のSubmission→Funded→Change。既存の型拒否と業務テストを維持 |
| 2. Result接続と後続停止 | 既存transition/commandを共通エンジンとして使用。groupと個別UseCaseの通常／詳細結果と呼び出し回数を比較 |
| 3. 共通境界を一度宣言 | defineUseCaseGroupで共通save・operation・要求context・lookup・再照会方針を定義 |
| 4. 操作名の再列挙を廃止 | operations／replayOperationsでキー・入力・失敗型を保ったままApplicationへ登録 |
| 5. 型安全性 | 本体の@ts-expect-error検証、外部consumerで元API6件＋group6件の誤定義を拒否 |
| 6. 実行の失敗経路 | 経費・休暇の既存CAS/rollback/再送/unknown commitテストに加え、Applicationのcrashed・表示更新失敗・非clone可能値を検証 |
| 7. 別業務・配布型 | 本体344テスト、独立した休暇consumer17テスト。通常／再送の登録は手書き版と比較 |
| 8. 実行環境 | 全14配布JSモジュールの外部importなし、実行依存ゼロ、Node型なしで配布型を検証。NodeグローバルなしのVMでgroup・Application・例外状態まで実行 |

実行した検証：

```sh
npm run check
npm test
npm run test:use-case:package
npm run check:package
npm run test:portable
npm run test:quickstart
```

quickstartでは既存の通常実行・再送・詳細記録と4件の誤定義の拒否も確認。
今回追加したAPIを実ブラウザ／公開Workersへ再デプロイしたという意味ではない。
公開alpha.4の既存互換性検証は[別の記録](../examples/portability/README.md)にある。

## 評価と残る境界

今回の範囲では、利用者は業務の型・検証・遷移、IO adapter、成功値の表示更新とviewを宣言する。
Resultの受け渡し、失敗時の後続停止、要求ごとの保存context、再送wrapper、操作名の再登録、
実行中／失敗／例外の状態管理を手書きしなくてよい。

これは一回の業務操作とインプロセスApplicationの宣言的な開発体験。
異なる保存先・トランザクション・成功時更新規則を一つに隠す必要はない。
外部にまたがる長期プロセスやメール配送まで自動的に接続・永続化することは保証しない。
直和型に何を表すか、集約の境界、認可や不変条件、どの失敗を再照会するかは業務とadapterの判断として残す。

「講演のすべてを完全に実装した」「どんな業務でも最良」とは評価しない。
ここで明記した要件について、実装と再現可能な検証が揃った状態とする。
APIの具体例とApplicationの新しいcrashed状態は[共通境界のガイド](use-case-group.md)に記載。


## alpha.5後の再評価：宣言と業務内の接続

前節はalpha.5時点の達成範囲。再評価では、空のrequireとStep包装の必須記述、
および経費のsubmit内に残るResultの接続を改善対象とした。

開発版のdefineTransitionは、通常の検証・前提条件・遷移関数を既存エンジンへ正規化する。
withInputは元の値が必要な後続処理へ計算結果を渡し、手書きの成功／失敗分岐を減らす。
経費申請を権限検証→承認経路の判定→状態更新として宣言し、経路の失敗をrequireのtraceに出す。
業務の判断・直和型・private brandの設計と、IO adapterは引き続き利用者が記述する。

追加APIは公開alpha.5に含まれない。新しいruntime・HTTP DSL・自動retryは追加していない。
[通常関数による宣言](declarative-transitions.md)に、型推論の制限と全検証を記載。
「最高」を普遍的に証明したり、講演の全内容・全業務を自動化したという評価ではない。
引用の中心である接続・実行の委譲について、実際の利用コードを一段改善した結果とする。

## アプリケーション全体の再評価

新しいAPIを増やさず、配布パッケージから休暇Applicationを組み立てて検証した。
操作のResult接続、完了イベント、実行状態、View通知は既存の宣言からruntimeへ委譲できる。
残る接続は、信頼するactor・load/save・再送方針・成功値の投影という意味のある境界。
手順と責務を[Application開発ガイド](application-development.md)にまとめた。

実例の確認で、待機中イベントが呼び出し元の変更を受ける穴を修正し、dispatch時のcloneで所有権を確定した。
初回通知が失敗した購読の保持も解消した。公開alpha.5にはまだ含まれない。
Applicationの再送による巻き戻し防止・失敗時の状態維持・View更新・待機入力の変更・stale revisionを、
独立したSQLite consumerで追加検証する。DBの並行性・トランザクションの責務は移さない。

この再評価では本体357テスト、配布パッケージのHTTP・Application consumer18テスト、
8件の誤宣言の拒否、追加2件のApplicationイベントの型拒否を確認。
配布14モジュールの外部importなし・実行時依存ゼロ・Node型不要と、
NodeグローバルなしのVMでの宣言・再送・Application・入力所有権も確認した。

## 講演全体への対応拡大

「講演の全内容を完全実現」という追加要求に対し、[論点別の対応表](lecture-coverage.md)を作成。
既存の例外・Promiseの境界と、メール・人の確認を挟む永続イベント接続を追加した。
後者はコアに新しい実行エンジンを足さず、既存UseCase / ProcessとSQLite adapterで具体化する。

本体369テスト、公開APIだけを使う登録consumer8テスト、休暇HTTP / Application consumer18テストを確認。
登録consumerは別OSプロセス・原子保存・配送失敗・ack失敗・lease競合・確認の競合を含む。
Web標準のみ・外部実行依存なしの契約も維持している。今回の追加はnpm未公開。

全画面・音声との照合、独立した利用者の評価、運用実績、GraphQL / Prismaでの実統合、
永続イベントを一般APIへ昇格させる設計判断は未完了。
講演の経験談・モデリング・チームの合意をライブラリの機能で保証できるという扱いにはしない。

## GraphQL実統合

GraphQL.js 17.1.0＋Honoから既存の休暇3操作を実行するadapterを追加。
GraphQL固有12テスト、既存RESTを含む公開npm consumer27テスト、通常関数宣言の開発版consumer30テストが成功。
クエリの分離、要求ごとの認証、保存後の例外・再送、実TCP、サーバー再起動後のREST/GraphQL間receipt共有を確認した。
複数mutationの文全体が一つのDB transactionになるわけではないことも検証する。
コア・domain・repositoryの変更なし。PrismaやSDLからの型生成、実運用評価は残る。
[具体例と契約](../examples/leave-http/GRAPHQL.md)に記載。

## Prisma transaction contextの検証

Prisma 7.10.1＋SQLiteで在庫2件と履歴を原子的に保存する独立サンプルを追加。
Result.errはPrismaの普通の戻り値なので、そのままではrollbackしないことを比較テストで確認した。
adapterが失敗Resultをrollbackへ接続し、txを取得・計算・複数保存へ渡す。
commit時の遅延制約違反では、専用Clientの後処理まで含む接続所有権を明示した。
コアAPIの追加・Prisma依存はない。
[再現方法と契約](../examples/prisma-stock/README.md)を参照。

配布開発版・公開npm alpha.5をそれぞれリポジトリ外へインストールしたconsumerで各12テストが成功。
配布14モジュールの外部importなし・実行時依存ゼロ・Node型不要も再確認した。
