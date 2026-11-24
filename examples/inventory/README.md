# Koyuki 在庫引当サンプル

初回は公開済みalpha.1の既存APIだけで実装し、手書きの再送制御を洗い出しました。
現在は開発版alpha.2の `withReplay` で、その手書きの分岐を置き換えています。
業務の状態・検証・純粋な遷移は初回から変更していません。

Node.js 22.13以上が必要です。Node.js 26.12.0で検証しています。
`node:sqlite` の同期APIを使う、小規模なローカルサンプルです。

```sh
git clone https://github.com/yukiharada1228/koyuki.git
cd koyuki
npm ci
npm run build
cd examples/inventory
npm ci
npm run check
npm test
npm start
```

デモは一時DBに在庫10個を作り、6個の引当・同じ要求の再送・在庫不足・確定・別注文のキャンセルを実行します。
最後は実在庫4個、引当0個です。一時DBは終了時に削除します。

## 状態と不変条件

このサンプルでは注文IDにつきSKUと数量が固定の1明細を扱います。
認証・複数テナント・複数明細・引当期限・返品・入荷は対象外です。

| 更新前 | 操作 | 更新後 | 失敗例 |
| --- | --- | --- | --- |
| 未引当 `unreserved` | 引当 `reserve` | 引当済み `reserved` | 在庫不足、不正数量 |
| 引当済み `reserved` | 確定 `confirm` | 確定済み `confirmed` | 注文内容の不一致、更新競合 |
| 引当済み `reserved` | キャンセル `cancel` | 取消済み `cancelled` | 注文内容の不一致、更新競合 |
| 確定済み／取消済み | 新しい要求による再遷移 | 拒否 | `InvalidState` |
| 任意 | 成功済み要求の正確な再送 | 元の応答を返す | 同じキーで内容が違えば `IdempotencyConflict` |

- `onHand` は未販売の実在庫、`reserved` は引当済み数量。利用可能在庫は差分です。
- `0 <= reserved <= onHand`。数量とバージョンは安全な整数です。
- 引当中の注文の数量合計と `reserved` が一致します。
- 確定は実在庫と引当を減らし、キャンセルは引当だけを戻します。
- 終端状態を新しい要求で引き当て直すことはできません。
- 更新の比較に使う在庫バージョンと注文バージョンは保存時に再確認します。

## 宣言する業務

`domain.ts` は直和型、検証、純粋な状態遷移です。
`application.ts` では次のように既存APIへ接続します。

```ts
const reserved = {
  validate: step('validate-reserve', validateReserve),
  require: [step('require-stock', requireStock)] as const,
  evolve: step('reserve', reserve),
};

const reserveCommand = defineTarget({
  operation: 'inventory.reserve.v1',
  load: input => repository.load('reserve', input),
  save: change => repository.save(change),
}).on(reserved);
```

`load → validate → require → evolve → save` とResultの失敗伝播はKoyukiが接続します。
`repository.ts` はSQLiteアダプター、`demo.ts` は操作の呼び出し元です。

## 原子性・競合・再送

保存トランザクションは、在庫・注文の引当状態・実行済み記録をまとめて確定します。
途中で失敗すると全体がrollbackします。同じ在庫スナップショットから作られた別注文は、
保存時のバージョン比較により一方を `Conflict` として拒否します。
自動リトライはせず、呼び出し元が再実行すると新しい在庫で再検証します。

`requestId` は要求ごとの一意キーです。成功した要求だけを記録します。
操作・注文・SKU・数量からfingerprintを作り、同じキーで異なる内容を拒否します。
並行した同じ要求は、保存トランザクション内でも記録を再確認することで、二重に引き当てません。
保存済み記録は別プロセスからも読み出せます。

**再送の応答は元の成功時点のスナップショットです。**
確定後に過去の引当要求を再送すると、元の「引当済み」の応答を返しますが、DBは確定済みのままです。
結果は `{ kind: 'committed' | 'replayed', value }` で新規保存と再送を区別します。
`replayOperation` を使うと再送ではreduceが呼ばれず、Viewを過去の応答で巻き戻しません。
最新状態の再取得自体はホストが設計します。
記録の削除・有効期限・スキーマ変更時の移行は未実装です。

## 共通化した境界と残った責務

`application.ts` の手書き `idempotent` 関数は削除し、`withReplay` の設定へ置き換えました。
再送の事前照会と競合後の再照会はランタイムが接続します。
保存時の記録確認と原子的な書き込みは、引き続きアダプターが担当します。

[初回検証の記録](FINDINGS.md)、[新しい境界の使い方](../../docs/replay.md)、
[在庫・経費への適用結果](../../REPLAY-RESULTS.md)を参照してください。

このサンプルは開発版を `file:../..` で参照します。npm公開版alpha.1には新APIがないためです。
ルートの `npm run test:inventory:package` で、packしたパッケージを別の一時ディレクトリへ
インストールして検証できます。新しいnpm版の公開はこの変更では行っていません。
