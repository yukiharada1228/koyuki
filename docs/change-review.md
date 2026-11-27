# 変更整理とQuick Start統一

追記（2026-11-28）: 下記はコミット前の分類記録。保留していたキャンセル実装は[追加検証](fee-cancellation-review.md)で確認済み。実際のコミット分割と最終検査は`commit-review.md`へ記録する。

2026-11-28。未コミットの変更を含む現在の作業ツリーを整理した。分類はレビューとコミット候補の責務を示すもので、stage・コミット・公開を実行したという意味ではない。他の変更と既存の出力は保持した。

## 今回統一した入口

- READMEから`examples/authoring-quickstart/README.md`を推奨の入口にする。公開alpha.5・JSXなしのbusiness・三業務の発展例は別の入口として保持し、案内先を統一した。
- `createBookingApp(repository)`で業務ツリーを作り、`scope(children => <Actor.Provider ...>)`で実行ごとのActorを供給する。
- 普通の業務関数 → Operation → JSXの実行スコープ → Guard → trace → 再送の順に導入する。
- `main.ts`・`trace.ts`・`verify.ts`を`.tsx`へ変更し、実行スコープをJSXで示す。`access.tsx`で認可拒否時のI/O停止を検証する。
- Quick Startの旧`createBookingApp(repository, actor)`は廃止し、全実行例とルール変更の検証を新しい形にそろえた。フレームワーク本体の変更ではない。

## レビューとコミット候補の順序

1. 実行エンジン: generic saveの結果型、Template・Guard、denied通知と配送分類。関連する型契約・scope試験も同じ単位に含める。
2. 予約業務: IDのResult生成、宣言参照の接続、同状態内の競合、日程変更の永続再送。SQLite・型・再送の試験と保存契約の説明を含める。
3. 予算付き経費: 既存ドメイン、予算CAS、監査・outbox・receiptの同時保存。共通契約、公開配布物、通常TSとの比較を含める。
4. Quick Startとガイド: 新しい入口、実行コマンド、公開版との差、学習導線。準備・実行・型・負例の検証を含める。

下の分類は関連ファイルを見落とさないための一覧であり、機能ごとのコミットでは対応する説明と試験もまとめる。Git indexを自動で組み替えていない。

## この整理で再実行した検証

- `npm run test:authoring:quickstart`: 独立ディレクトリへtgzをインストール。React・Node型の不在、TS7.0.2 / TS6.0.3の型検査・宣言生成、start / trace / access / replay / verifyに成功。
- 同じコマンドで、既存ディレクトリの上書き拒否、所有者検証の削除を検出する負例、業務ルールだけの変更も検証。
- `npm run check`、`git diff --check`: 成功。

過去の全1332テストと予算・接続の配布物検証は各機能の記録であり、今回の再実行とは区別する。リモートCI・バージョン更新・npm公開は行っていない。

## 変更ファイルの分類

` M`は追跡ファイルの変更、` D`は旧ファイルの削除、`??`は未追跡。未追跡の新実装も含め、git diffだけでは見えない漏れを防ぐ。

基点コミット: `628112ad321a937d1bce949880c8ea239ff8cf77`。未コミット分はこのコミットへ含まれない。

### 実行エンジン・公開API（3件）

- ` M` `src/framework/authoring.ts`
- ` M` `src/framework/execution.ts`
- ` M` `src/framework/wiring.ts`

### 推奨Quick Start（12件）

- ` M` `examples/authoring-quickstart/README.md`
- ` M` `examples/authoring-quickstart/app.tsx`
- ` M` `examples/authoring-quickstart/domain.ts`
- ` D` `examples/authoring-quickstart/main.ts`
- ` M` `examples/authoring-quickstart/replay.tsx`
- ` D` `examples/authoring-quickstart/trace.ts`
- ` D` `examples/authoring-quickstart/verify.ts`
- ` M` `scripts/authoring-quickstart.mjs`
- `??` `examples/authoring-quickstart/access.tsx`
- `??` `examples/authoring-quickstart/main.tsx`
- `??` `examples/authoring-quickstart/trace.tsx`
- `??` `examples/authoring-quickstart/verify.tsx`

### 予約業務・ID・保存（10件）

- ` M` `examples/booking-composition/README.md`
- ` M` `examples/booking-composition/domain.ts`
- ` M` `examples/booking-composition/verify.ts`
- ` M` `src/experiments/declarative-booking/business.tsx`
- ` M` `src/experiments/declarative-booking/demo.tsx`
- ` M` `src/experiments/declarative-booking/domain.ts`
- ` M` `src/experiments/declarative-booking/memory.ts`
- ` M` `src/experiments/declarative-booking/sqlite.ts`
- `??` `src/experiments/declarative-booking/rescheduling-request.ts`
- `??` `src/experiments/declarative-booking/rescheduling.tsx`

### 予算付き経費精算（9件）

- `??` `scripts/test-expense-budget-package.mjs`
- `??` `src/expense-budget.test.tsx`
- `??` `src/experiments/expense-budget/application.tsx`
- `??` `src/experiments/expense-budget/contracts.ts`
- `??` `src/experiments/expense-budget/domain.ts`
- `??` `src/experiments/expense-budget/memory.ts`
- `??` `src/experiments/expense-budget/plain.ts`
- `??` `src/experiments/expense-budget/repository.ts`
- `??` `src/experiments/expense-budget/sqlite.ts`

### 検査・配布物・型契約（8件）

- ` M` `package.json`
- ` M` `scripts/fixtures/authoring-wiring-contracts.tsx`
- ` M` `scripts/test-wiring-package.mjs`
- ` M` `src/authoring-wiring-contracts.test.tsx`
- ` M` `src/authoring-wiring-sqlite.test.tsx`
- ` M` `src/authoring-wiring.test.tsx`
- `??` `src/authoring-rescheduling.test.tsx`
- `??` `src/authoring-scope.test.tsx`

### ガイド・評価記録（17件）

- ` M` `README.md`
- ` M` `docs/declarative-connections.md`
- ` M` `docs/development-start.md`
- ` M` `docs/getting-started.md`
- ` M` `docs/lecture-conformance-current.md`
- ` M` `examples/authoring/README.md`
- `??` `docs/authoring-save-inference.md`
- `??` `docs/booking-validation-results.md`
- `??` `docs/change-review.md`
- `??` `docs/composition-change-study.md`
- `??` `docs/execution-scopes.md`
- `??` `docs/expense-budget-study.md`
- `??` `docs/framework-value-plan.md`
- `??` `docs/identifier-safety.md`
- `??` `docs/learning-path.md`
- `??` `docs/rescheduling-business-study.md`
- `??` `docs/rescheduling-replay.md`

### 今回未検証の保留ファイル（3件）

今回と直近の機能検証の対象ではない。参照・試験・利用目的を別途確認するまで、リリースへ含める判断を保留する。削除・stageはしない。

- `??` `src/experiments/declarative-booking/cancellation-domain.ts`
- `??` `src/experiments/declarative-booking/cancellation-sqlite.ts`
- `??` `src/experiments/declarative-booking/cancellation.tsx`

### 以前からある出力ファイル（10件）

既存の出力・測定ファイル。今回の変更候補と区別し、内容を上書きしない。

- `??` `APPLICATION-DEMO.txt`
- `??` `APPROVAL-DEMO.txt`
- `??` `COMPARISON-METRICS.json`
- `??` `EXPENSES-DEMO.txt`
- `??` `EXPENSES-SQLITE-DEMO.txt`
- `??` `MODEL-DEMO.txt`
- `??` `PROGRAM-DEMO.txt`
- `??` `SHIPPING-DEMO.txt`
- `??` `TAG-DEMO.txt`
- `??` `TAG-METRICS.json`
