# Changes

## 0.1.0-alpha.3

- `withReplay(...).runDetailed(input)`：再送境界の記録と、実際に実行した業務コマンドの記録を区別。
- `defineUseCase({ operation, load, transition, save, replay? })`：取得・遷移・保存と任意の再送をまとめる追加の入口。
- 型診断：saveと遷移の不一致、requireの接続、再送時のExecution契約を表示。通常定義に無関係なoverload診断を除去。
- チュートリアル：通常実行・再送・詳細記録を、独立したnpm consumerで実行。

既存のTarget→on→withReplayは維持。複雑なインラインsaveには型注釈が必要な場合がある。
自動トランザクションや永続リトライは追加していない。保存と成功記録の原子性はアダプターが担う。

公開後、作業ツリー外でnpmからalpha.3を新規インストールし、通常実行・再送・詳細記録・4種類の誤定義の拒否を確認。
再現コマンド：`npm run test:quickstart:registry`。
