# Koyuki

独立したTypeScriptの業務関数を、ReactらしいContext・Hooks・JSXで組み立てる業務フレームワーク。状態・検証・遷移は業務側で定義し、型付きの接続・失敗停止・実行記録・イベント配送を共通の実行器へ任せます。

## 開発版のQuick Start

**[最初の業務操作を作る](examples/authoring-quickstart/README.md)** を推奨の入口とします。普通の業務関数から始め、Operation → JSXの実行スコープ → Guard → trace → 再送へ進みます。

```sh
# この開発版のチェックアウトのルートで
npm ci
npm run prepare:authoring:quickstart -- ../my-bookings
cd ../my-bookings
npm install
npm run check
npm start
```

既存ディレクトリは上書きしません。準備したプロジェクトは開発版tarballと公開importのみで動きます。**公開済みnpm alpha.5には`koyuki/experimental`は含まれません。** 未コミットの変更がある場合、新しくcloneした公開リポジトリだけでは同じ開発版になりません。

業務ツリーは`createApplicationTemplate`、操作者は実行ごとの`scope`とProviderで構成します。構成時に業務I/Oは始まらず、`execute` / `executeDetailed`で実行します。React自体は不要で、再描画・useState・useEffectは提供しません。APIは実験段階です。

| 試したいこと | ガイド |
| --- | --- |
| 普通の関数から段階的に理解する | [学習ガイド](docs/learning-path.md) |
| 実行ごとのActor・配下の認可 | [実行スコープとGuard](docs/execution-scopes.md) |
| Resource・イベント・Query・viewをつなぐ | [宣言的な接続](docs/declarative-connections.md) |
| 複数段階の経費承認・予算・再送 | [予算付き経費精算と比較](docs/expense-budget-study.md) |
| ID・接続の型安全性と安定名 | [保証の範囲](docs/identifier-safety.md) |
| 部品・propsで別業務へ再利用する | [予約業務の合成](examples/booking-composition/README.md) |

複数の業務で実行契約を統一したい場合に向きます。単純なCRUDでは普通の関数だけで十分な場合があります。業務仕様・認証・DBの原子性を自動で決定するものではありません。通常TypeScriptより常にコードが少なくなる保証や、大規模チームでの生産性の実証もありません。

コアはWeb標準APIのみ・実行時外部依存ゼロです。[ランタイムの契約](docs/runtime.md)と[互換性の検証範囲](examples/portability/README.md)を参照してください。Quick StartはNode.js 22以上、SQLiteの統合例はNode.js 26で検証します。サンプルのSQLiteアダプターにはNode固有APIを使用します。

## 公開alpha.5と既存の入口

```sh
npm install koyuki@0.1.0-alpha.5
```

公開版を使う場合は[公開版チュートリアル](docs/getting-started.md)へ進んでください。JSXなしの開発版には[businessによる入口](docs/development-start.md)もあります。これらは代替・既存APIの説明であり、上記の開発版Quick Startの手順ではありません。

[三業務を組み立てる試用](examples/authoring/README.md)、[APIの説明と比較](docs/authoring-declaration-api.md)、[チーム開発での評価範囲](docs/team-development-study.md)も参照できます。

### 最初の状態遷移（既存API）

```ts
import { ok, err, step, transition, type Result } from 'koyuki';

const approve = transition({
  validate: step('validate', (amount: number): Result<number, 'InvalidAmount'> =>
    amount > 0 ? ok(amount) : err('InvalidAmount')),
  require: [] as const,
  evolve: step('approve', (amount: number) =>
    ok({ kind: 'approved' as const, amount })),
});

approve.run(100); // { ok: true, value: { kind: 'approved', amount: 100 } }
approve.run(-1);  // { ok: false, error: 'InvalidAmount' }
```

`validate` が成功した値を `require`、`evolve` に渡します。
失敗すると後続の処理を実行せず、型付きのエラーを返します。
この例は接続の最小例です。実際の業務では直和型で状態を表し、権限や不変条件を検証します。

## 取得・保存・アプリケーションの実行

経費承認の宣言は次の形です。下記の関数とrepositoryは利用者が実装します。
[実行できる経費精算サンプル](examples/expenses/README.md)に全コードがあります。

```ts
import { defineTarget, step } from 'koyuki';

const approved = {
  validate: step('authorize-approval', validateApproval),
  require: [] as const,
  evolve: step('approve', approve),
};

const approval = defineTarget({
  operation: 'expense.approve.v1',
  load: input => repository.load(input, authenticatedActor),
  save: change => repository.save(change),
}).on(approved);

await approval.run({ id: 'expense-1', expectedVersion: 2 });
```

| 利用者が書くもの | Koyukiが実行するもの |
| --- | --- |
| 状態の型・検証・純粋な遷移関数 | 型の合う処理を接続し、Resultの失敗を伝播 |
| データの取得・保存アダプター | load → validate → require → evolve → save |
| 操作と成功時の業務データ更新 | `defineApplication` による ready / running / failed / crashed の管理 |
| 内部状態から返したい情報 | `view` の再計算、購読通知 |

HTTPはHonoなどに任せられます。ReactやJSXは必須ではありません。
認証済みの利用者の注入、権限ルール、DBトランザクション、更新競合の防止は利用者が設計します。
自動トランザクション・永続的なリトライ・監査ログは現時点では提供しません。

## 経費精算サンプルを試す

```sh
git clone https://github.com/yukiharada1228/koyuki.git
cd koyuki/examples/expenses
npm ci
npm run check
npm test
npm start
```

サンプルはソース内部の相対importではなく、npmの `koyuki` を使用します。
申請 → 上長承認 → 経理承認と、別申請の却下を確認できます。

## 在庫引当で実行境界を検証する

[在庫引当サンプル](examples/inventory/README.md)では、引当・確定・キャンセルを
SQLiteで保存競合・成功済み要求の再送・rollbackを検証します。
開発版alpha.2の新しい再送境界を使うため、まずルートでビルドしてください。

```sh
npm ci
npm run build
cd examples/inventory
npm ci
npm run check
npm test
npm start
```

初回検証で手書きになった再送処理は、開発版の `withReplay` へ取り込みました。
`replayOperation` は過去の再送応答でViewを巻き戻さないための接続です。
[契約と使い方](docs/replay.md)、[適用結果と残る課題](REPLAY-RESULTS.md)を参照してください。
これらのAPIはalpha.2で追加しています。基本の経費サンプルは比較用にalpha.1を固定しています。

## フレームワークを開発する

リポジトリのルートで実行します。全テストには `node:sqlite` が必要です。
Node.js 26.12.0で検証しています。

```sh
npm ci
npm run check
npm test
npm run build
```

既存のタグ管理・SQLite/Honoデモは [README.txt](README.txt)、
APIの検討記録は [PUBLIC-API.txt](PUBLIC-API.txt) を参照してください。
将来機能は [Issues](https://github.com/yukiharada1228/koyuki/issues) で管理しています。

## License

[MIT](LICENSE) © 2026 yukiharada1228

開発版の業務例：[差し戻し・修正・再申請](docs/expense-correction.md)。
`npm run demo:expenses:correction` で、既存runtimeを使った複数周回と再送時のView維持を確認できます。

[休暇申請サンプル](examples/leave/README.md)は、公開済みalpha.2だけで作った別業務の例です。
申請時の残日数の仮確保・承認・取り下げ、SQLiteの競合と再送を検証しています。

alpha.3では[再送を含む実行記録](docs/replay-trace.md)を追加しています。

alpha.3では[defineUseCaseによる接続の集約](docs/use-case.md)も利用できます。既存APIは引き続き使用できます。


## alpha.5：複数操作の接続を一度宣言する

`defineUseCaseGroup`で共通の保存・要求情報・再送境界を定義し、
操作ごとのloadと純粋なtransitionを`.on`で接続できる。
`operations(commands, reduce)`／`replayOperations(commands, reduce)`は、
通常／再送の操作名を再列挙せずApplicationへ登録する。
予期しない操作例外は業務失敗と区別した`crashed`状態で扱い、自動再試行しない。

[全体例と責任範囲](docs/use-case-group.md)、[講演との対応と達成条件](docs/framework-goal.md)。
既存APIは引き続き利用できる。Applicationの変更は[alpha.5移行ガイド](docs/migration-alpha.5.md)を参照。


[休暇申請のHTTP API](examples/leave-http/README.md)では、alpha.5の新APIをHonoへ接続しています。
認証→入力検証→業務操作→SQLite保存・再送→HTTP応答を、実TCPとサーバー再起動まで検証します。
`npm run test:leave:http:package`で、配布パッケージだけを使う独立consumerとして再現できます。
[開発体験の評価](examples/leave-http/FINDINGS.md)も記録しています。


## 開発中：通常の関数をそのまま遷移へ

```ts
const approved = defineTransition({
  validate: validateApproval,
  evolve: approve,
});
```

空のrequireや各関数のstep包装を必須にせず、必要な前提条件だけを追加する。
withInputは計算結果と元の入力を保持し、業務内のResultの受け渡しも共通化する。
[設計・例・型推論の範囲](docs/declarative-transitions.md)。
**この追加APIは未公開。npmのalpha.5には含まれない。**

[業務宣言からApplicationまで](docs/application-development.md)に、状態・検証・遷移から
dispatch・保存・View更新までの手順と、利用者に残るadapterの責務をまとめています。

[開発版の継続検査](docs/ci.md)、[3講演の要件別判定](docs/lecture-acceptance.md)と[詳細な対応・未確認事項](docs/lecture-coverage.md)を公開しています。
開発版には[例外・Promise境界](docs/result-boundaries.md)と、
[メール・人の確認を挟む永続イベントの実例](docs/registration-events.md)を追加しています。
実例は別OSプロセス・rollback・再配送・workerの競合まで検証し、全内容の完全実現とは区別しています。
[途中のI/Oを接続するprocess](docs/process.md)は開発版で直接runでき、最終の業務遷移がない処理にも利用できます。
[可変長の明細検証](docs/collection-validation.md)では、collectEachで位置付きのエラー収集と後続の停止を宣言します。
[固定tupleのcombine](docs/combine.md)は、評価済みの検証結果を位置どおりにまとめ、最初の失敗を変更せず返します。

[GraphQLの統合例](examples/leave-http/GRAPHQL.md)では、RESTと同じ業務宣言・保存先を使い、
クエリ・mutation・型付き失敗・再送とトランザクション境界を検証しています。

[Prismaの統合例](examples/prisma-stock/README.md)では、外側のtransaction contextへ業務宣言を束縛し、
失敗Resultのrollback、複数在庫と履歴の原子保存、commit失敗時の後処理を検証しています。
