# Changes

## Unreleased

- Strengthen the unpublished business API study with authorization-proof, exact inference, and 64-stage connection checks; use accumulator-based type recursion. Mapped adjacency checks now preserve 64-stage inline tuple inference for shared and per-operation loaders, with errors located at the mismatched stage.

- 非公開のAPI試作：通常関数の配列とbusiness.operation(input)で経費5操作を実行。入力・失敗型、既存の再送・詳細記録・Application連携を検証。配布入口へは追加せず、trace・操作ID互換性などの未決事項を記録。
- チーム開発での価値仮説と比較方針を文書化。通常TSの共通helper版を比較対象へ明示し、旧実験の計測漏れ・タグ比較の古いファイル参照を修正。行数比較を大規模開発・バグ率・生産性の証拠とは扱わない。
- Prisma 7.10.1＋SQLiteの独立在庫サンプルを追加。transaction contextへ既存の業務宣言を束縛し、失敗Result→rollback、2件更新と履歴の原子保存、commit失敗時の専用Clientの後処理、実migrationを検証。コアの依存追加なし。
- 休暇サンプルにGraphQL.js＋HonoのPOST /graphqlを追加。同じ業務宣言でQuery/Mutation分離、結果union、権限、再送、保存後の例外、複数mutationの部分成功を検証。公開npm consumer27件・開発版consumer30件が成功。コア依存の追加なし。
- fromThrowable / fromPromise：既存の同期例外・Promiseを明示した境界で型付きResultへ接続。引数型を維持し、非同期境界は呼び出し時のthrowも変換する。
- 登録→メール→人の確認を、既存のUseCase / ProcessとSQLite outboxで実装。原子保存・lease・再配送・古いclaim・別OSプロセスを配布パッケージから検証。永続workflow機能をコアへ追加したものではない。
- [3講演との論点別対応と未確認事項](docs/lecture-coverage.md)を追加。全内容の完全実現という評価は未完了。
- Program / Applicationはdispatch時にイベントをcloneし、待機中の入力変更から実行を保護。clone不可の入力はPromiseでrejectし、状態と後続キューを維持。
- subscribeの初回通知が失敗した場合は購読を保持しない。配布パッケージの休暇ApplicationでView更新・失敗・再送・待機入力・stale revisionを追加検証。
- [Application全体の開発手順と責務](docs/application-development.md)を追加。
- defineTransition：通常の業務関数から遷移を宣言。requireは任意で、依存する型と失敗を保持し、既存Step定義へ正規化する。宣言は不変、名前は役割ラベルまたは明示した業務名。
- withInput：成功した計算結果と元の入力を保持し、Resultの接続を共通化。経費申請の承認経路を独立したrequireとして宣言し、失敗箇所をtraceへ表示。
- 休暇の生関数宣言を独立したHTTP consumerで検証し、明示名の版と結果・状態を比較。既定のtrace名は異なる。
- [追加APIの使い方と制限](docs/declarative-transitions.md)。公開alpha.5との区別を維持。

## 0.1.0-alpha.5

- Honoの休暇申請HTTPサンプルを追加。認証前提の再送、入力検証、業務エラー→HTTP、同時競合、保存後の応答不明、実サーバー再起動を15テストで検証。コアへのHTTP依存追加なし。

- `defineUseCaseGroup`：複数操作の共通保存・要求情報・再送方針を一度宣言。操作ごとの入力・失敗型とload→純粋な遷移の接続を維持。
- `operations`／`replayOperations`：同じ表示更新規則を持つ通常／再送の操作群を、キーの再列挙なしでApplicationへ登録。
- 経費の5操作と独立consumer内の休暇3操作で既存動作と比較。誤接続の配布型診断も検証。
- Applicationに`crashed`状態を追加。予期しない操作例外・成功値のreduce失敗を業務失敗と区別し、実行前の表示状態を保持。dismissは解除だけで自動再試行しない。低レベルcommandの例外伝播は維持。
- 講演との対応、達成条件、共通境界と利用者の責任範囲を文書化。

移行点と失敗時の契約は[alpha.5移行ガイド](docs/migration-alpha.5.md)を参照。

公開後、npmからalpha.5を新規インストールし、全14配布モジュール・外部型不要・実行依存ゼロを確認。
チュートリアルの通常／再送／詳細記録と誤定義4件、休暇HTTPの15テスト（実TCPとプロセス再起動を含む）を再検証。
HTTPとquickstartのサンプル依存も公開alpha.5へ切り替え。
再現：`npm run check:package:registry`、`npm run test:quickstart:registry`、`npm run test:leave:http:registry`。

## 0.1.0-alpha.4

- Web標準APIのみ・実行依存ゼロを配布契約として明記。Node型なしのビルド、全配布モジュールと型定義、実インストールの依存ツリーを検証。
- ランタイム中立のコアに合わせ、パッケージのNode専用engines指定を除去。開発・SQLiteサンプルのNode要件は別途記載。

- コアの`node:crypto`依存を除去。保存直前の決定の一致確認は、正規化文字列の同期比較を使う。
- この確認には暗号ハッシュが不要なため、Web Cryptoへの置換ではなく暗号APIへの依存自体を除去した。
- タグの永続化用ハッシュはアダプターへ分離し、既存の保存形式を維持。
- `npm run test:portable`でビルド済み公開入口をブラウザ向けにbundleし、NodeグローバルのないVMで実行を検証。
  Chromium 156とCloudflare Workersの公開環境でも同じ業務結果を確認。その他の環境は未確認。

公開後にnpmからalpha.4を新規インストールし、実行依存ゼロ・外部型不要・通常実行・再送・詳細記録を確認。
Workers検証サンプルもnpmのalpha.4へ切り替え、型チェック・bundle監査・公開URLの確認を実施。

## 0.1.0-alpha.3

- `withReplay(...).runDetailed(input)`：再送境界の記録と、実際に実行した業務コマンドの記録を区別。
- `defineUseCase({ operation, load, transition, save, replay? })`：取得・遷移・保存と任意の再送をまとめる追加の入口。
- 型診断：saveと遷移の不一致、requireの接続、再送時のExecution契約を表示。通常定義に無関係なoverload診断を除去。
- チュートリアル：通常実行・再送・詳細記録を、独立したnpm consumerで実行。

既存のTarget→on→withReplayは維持。複雑なインラインsaveには型注釈が必要な場合がある。
自動トランザクションや永続リトライは追加していない。保存と成功記録の原子性はアダプターが担う。

公開後、作業ツリー外でnpmからalpha.3を新規インストールし、通常実行・再送・詳細記録・4種類の誤定義の拒否を確認。
再現コマンド：`npm run test:quickstart:registry`。
