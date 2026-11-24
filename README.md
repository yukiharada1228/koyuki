# Koyuki

業務の状態・検証・遷移を宣言し、接続と実行を任せるTypeScriptフレームワーク。

```sh
npm install koyuki@alpha
```

**実験段階のアルファ版です。** APIは変更される可能性があります。ES Modulesと
Node.js 22以上が必要です。現在の実装は `node:crypto` を使うため、ブラウザや
エッジランタイムでの動作は保証していません。

[最小チュートリアル](docs/getting-started.md)では、タグ作成から始め、経費精算・再送へ進めます。
推奨APIと型エラーの読み方、空のプロジェクトへの導入手順を掲載しています。

## 最初の状態遷移

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
| 操作と成功時の業務データ更新 | `defineApplication` による ready / running / failed の管理 |
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

開発版alpha.3では[再送を含む実行記録](docs/replay-trace.md)を追加しています。npmには未公開です。
