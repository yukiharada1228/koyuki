# Changes

## Unreleased

- 非同期顧客照合後に状態Unionで作成・更新・変更なしを選ぶ実例を既存Process/Workflowで追加。失敗停止・scope不一致・CAS競合・欠陥伝播・型の絞り込みを検査し、実配布consumerへ追加。新しいcore APIは追加せず、永続DB名寄せと予約取込全体は対象外と明記。

- 1本目の本人公開PDF92ページを全体照合し、3資料全198ページのページ別対応を記録。84ページのframework構想を既存APIへ対応付け、開発体験の未実証・DIと純粋性の違い・非公開仕様の確認限界を維持。

- 3本目の本人公開PDF74ページを本文・図・コードまで照合し、ページ別対応を追加。直和の排他性、状態値の観測と永続履歴の違い、命令的実装の許容、教育用アルゴリズムと機能要件の区別を明記。

- 2本目の本人公開PDF32ページを全体照合し、ページ別の実装対応・設計判断・不足を追加。非同期照合後のUnion分岐、combineとcollectの契約差、型記述簡素化の限界を明記。資料検査で全ページ割り当てと根拠パスも点検。

- 本人公開の講演PDF3件を取得し、URL・hash・ページ数・確認済みページを記録。1本目の公開版には動画の複雑な実製品コード画像がないことを確認。保存資料の同一性検査を追加し、全198ページの意味照合や全編視聴の完了とは区別。

- business.runDetailedの任意captureをload/Rule/save/receipt照会へ接続。実行しない過去段階は記録せず、不明commit後の照会も観測。取得・clone失敗は秘密情報を含まないobservationErrorsへ分離し、保存済み業務結果を維持。通常report・型・操作ID・再送契約を維持。

- Workflow.inspectの任意captureで、選択した段階入力・Resultをcloneして観測可能に。Ruleの再実行なしで失敗停止・選択branch・transitionを記録。通常実行のreportを維持し、値の永続保存やbusiness全体への観測設定は未提供。

- 3本目の画面変化50候補と状態観測の補足3枚を確認。省略されたUnion-Find・Maybe/GraphQL Union・文脈・ナップサックの例を記録し、教育例とframework機能要件を区別。全値履歴の未提供と連続視聴の未確認を維持。

- 2本目の追加画面27枚で、29分台が非同期タスク送信と全失敗集約の例だと確認。collectEffectsを明示的I/O境界として追加し、指定並列数・結果順・全失敗集約・欠陥時の新規停止と開始済み処理の待機を検証。同期Rule・自動再送・transactionとは区別。

- 1本目の画面変化73候補と補足4枚を追加確認し、時刻・hash・観察内容を記録。GraphQL境界の例外変換、非同期依存、51分台のframework構想を字幕照合へ補足。画面検出の取りこぼしと細かいコードの判読限界を明記。

- 3本目の省略箇所周辺を10枚の追加静止画で確認し時刻・hashを記録。命令的記述の許容と直和の説明を補足。構造的Unionだけでは両IDを持つ値が通る点を型・JSON境界のテストで明示し、タグと排他フィールドの必要性を区別。連続映像・音声の全確認とは称さない。

- foldEachを追加。前要素の成功状態に依存する同期Result計算を順次接続し、最初の失敗を保持して停止。残予算の明細配分で途中失敗時の保存停止、呼び出しごとの初期化、所有権・例外・型を検証。独立検証のcollectEachと区別し、非同期I/Oは対象外。

- businessを開発版のルートexportへ昇格。通常の同期Result関数の配列から操作を宣言し直接呼び出す推奨入口を文書化。既存APIは維持。独立consumerは実際の開発版tarballとルートimportで検証し、利用ガイドの最小例も実行。npmへの公開は未実施。

- 接続先メソッドの入力型が狭すぎても許容される型の穴を修正。Process.effect/commit・defineAction・withReplayの詳細操作を関数プロパティ契約で検査し、未検証のstring/状態Unionを狭い入力へ渡す接続を拒否。defineActionはloaderを先に推論し、既存の型引数指定と入出力・エラー推論を維持。

- Process.effectにActionReportを返す操作のobject形式を追加。途中commandの詳細traceを保持し、内部失敗でも後続を停止。関数形式の挙動・例外伝播を維持し、途中planや値の自動記録は追加しない。複数集約の実例・独立配布consumer・Nodeなし実行で検証。

- 非公開businessの複数集約接続例を追加。在庫確保と出荷登録の異なるsave/成功型をProcessで接続し、失敗停止・部分成功・adapterによる再実行時の重複防止・内容変更拒否を検証。永続replayや全体transactionとは区別し、内部traceの未展開も記録。

- 1本目の本編・質疑の保存済み字幕2258行を再読し、39区間の対応を追加。3本4034行の割り当てを検査。宣言を優先する方針、I/O注入と純粋性、講演時点の未実施案、チーム導入とテストの負担を区別。全編音声・画面の検証完了は主張しない。

- 3本目の保存済み自動字幕964行を全体再読し、24区間の対応を追加。段階traceと全状態履歴、型付きResultと予期しない例外、継承への注意と禁止を区別し、省略箇所を29分台・40分台の双方で記録。音声・全画面の確認完了は主張しない。

- defineTransitionのvalidateを先に推論してから段階の契約を検査する形へ変更。型付きのevolveと接続するcollectEach/withInputを直接記述可能にし、完全なUseCaseの入出力・エラー型と不正段階の拒否を配布consumerでも検証。generic呼び出しと未注釈evolveを組み合わせる推論制限は引き続き明記。

- collectEachを追加。通常の同期Result関数から可変長配列の検証Ruleを作り、全エラーを元の要素位置付きで集約。明細・合計の検証例で集計/保存の停止、型の保持、Nodeなし実行を検証。非同期列・要素間の依存処理は対象外で、既存defineTransitionのinline推論制限を明記。

- 2本目の保存済み自動字幕812行を読み直し、21区間の実装対応・判断・経験談・不足を記録。字幕hash・区間・根拠パスの検査を追加し、可変長Result列の専用合成APIが未提供である点を対応表へ明記。音声・画面・実装の完全性の証明とは区別。

- processに直接run / runDetailedを追加。純粋な最終遷移が不要なI/O列をそのまま実行し、登録メールの完了記録から空のvalidate/evolveを除去。既存commitは維持し、失敗停止・型・並行実行・例外・Nodeなし実行を検証。

- 未公開APIの仕様変更実験を追加。承認の新たな証拠型・制限ルールを通常TS/helper/既存遷移/businessで比較し、4方式の接続漏れとHTTPエラー対応漏れを型検査で検出。新仕様5テストで境界・失敗停止・Application・過去receiptの契約を検証し、実際の変更diffを出力。

- business試作を休暇3操作へ適用。一時的なprivate候補tarballを独立consumerへインストールし、既存HTTP/GraphQL・Application・旧宣言比較・SQLite移行の31テスト、6件の不正定義拒否、Node型なしでの型推論を検証。通常の配布exportは変更なし。

- 非公開business試作を既存Workflowへ直接接続し、単一関数の空のcomplete段階を除去。共有context/replay接続を内部へ抽出し公開groupの型・挙動を維持。操作ID resolverと経費SQLiteの旧→新（別プロセス）・新→旧replayを検証。

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
