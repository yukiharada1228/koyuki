# Koyuki 経費精算サンプル

公開されたnpmパッケージを使う、独立したTypeScriptアプリケーションです。
Node.js 22以上で実行できます。

```sh
git clone https://github.com/yukiharada1228/koyuki.git
cd koyuki/examples/expenses
npm ci
npm run check
npm test
npm start
```

最初の申請は `draft → manager → finance → approved` へ進みます。
別の申請は上長が理由を付けて却下し、`rejected` として保存されます。
購読通知では `ready → running → ready` の実行状態も表示します。

## どこを読むか

| ファイル | 利用者が定義する内容 |
| --- | --- |
| `domain.ts` | 直和型の業務状態、権限検証、純粋な状態遷移 |
| `policy.ts` | 金額と領収書による承認経路のルール |
| `repository.ts` | 取得・保存・バージョン照合。ここではメモリ実装 |
| `application.ts` | 検証と遷移の宣言、Target、操作、結果の反映、View |
| `demo.ts` | 認証済み利用者に相当するActorの注入と操作のdispatch |
| `expenses.test.ts` | 承認・却下・失敗・競合・型の制約の検証 |

`application.ts` の `model.change.on(approved)` が、取得から保存までの接続を引き受けます。
利用者が各段階の `Result` を展開して次へ渡す必要はありません。
`defineApplication` が実行中・成功・失敗の状態管理を行うため、完了イベントを手書きしません。

## このサンプルの業務ルール

- 3,000円以下は自動承認。
- 3,000円を超える申請は領収書と上長の承認が必要。
- 100,000円を超える申請は、さらに経理の承認が必要。
- 申請は本人のみ。承認・却下は適切な役割の別人のみ。
- 却下理由は必須。古いバージョンからの更新は拒否。

業務上の失敗は `session.snapshot().state.kind === 'failed'` とエラーを確認します。
`dispatch` が受理されたことだけでは、業務の成功を意味しません。

Actorは実際の認証機能ではなく、ホストから渡す固定データです。
メモリ保存はプロセス終了で消えます。実運用ではDBの原子的な更新と認証基盤が必要です。
リポジトリ内のSQLite実装は `src/expenses/sqlite.ts` を参照してください。

サンプルの依存先は、検証済みの `koyuki@0.1.0-alpha.0` に固定しています。
GitHubの開発ソースや `npm link` を参照しないため、公開されたAPIだけで再現できます。
