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
