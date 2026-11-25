# 任意の再送・実行境界（alpha.2）

`withReplay` は既存の `defineTarget(...).on(...)` などのコマンドに追加する、任意の実行境界です。
`transition`、業務状態の型、検証関数を変える必要はありません。
このAPIは `koyuki@0.1.0-alpha.2` に含まれます。alpha.1には含まれません。

## 契約

```ts
type Receipt<O> = { kind: 'missing' } | { kind: 'found'; value: O };
type Execution<O> =
  | { kind: 'committed'; value: O }
  | { kind: 'replayed'; value: O };
```

- `lookup` は記録なし・成功済みを区別します。キー衝突や読込失敗は `Result` のエラーです。
- `save` は業務データと成功済み記録を同一トランザクションで確定します。
- 新しく保存したら `committed`、同時実行した要求の記録を返したら `replayed` です。
- `withReplay` はコマンドを実行する前に成功済み記録を確認します。
- コマンドが失敗した際は、`resolveAfter` が明示的に許可した失敗だけ再照会します。
- コマンド自体を自動リトライすることはありません。

開発版には別の任意の境界として[retryEffect](retry.md)がある。
未適用または冪等性をhostが明示した段階だけ、上限・待機・中断付きで再試行する。
withReplay単体や既存の公開alpha.5へ自動retryを追加したものではない。

同じキーの異なる内容を拒否するfingerprint、要求キーのスコープ、応答の復元検証はアダプターが定義します。
認証・要求ごとのアクセス制御は、この境界へ入る前にホストが行います。
成功済み記録がある場合はドメインの検証関数を再実行しないため、認証をその検証だけに頼ることはできません。

## 在庫引当への接続

[application.ts](../examples/inventory/application.ts) の実コードでは、次の構成です。

```ts
const command = withReplay(commands.reserve, {
  lookup: input => repository.receipt('reserve', input),
  resolveAfter: error =>
    error.kind === 'Conflict' ||
    error.kind === 'InvalidState' ||
    error.kind === 'StorageUnavailable',
});
```

再送済みの注文は `reserved` や `confirmed` に進んでいるため、元の操作の `validate` は失敗し得ます。
事前照会とloadの間に他の要求が成功する場合もあるため、このサンプルは `InvalidState` も再照会対象にしています。
ただし、記録がなければ元のエラーをそのまま返します。業務上の拒否を成功に変換するものではありません。

入力は最初のawaitより前に[対応する要求データの形式を検査](replay-request-snapshot.md)し、`structuredClone` で切り離します。
呼び出し側が入れ子の入力を後から変更しても要求は変わりません。
関数などcloneできない入力や、Symbol属性・accessor・独自クラス等の情報を失う入力は `ReplayInputNotCloneable` になります。
クラスのインスタンス等は黙ってDTOへ変換せず、照会前に拒否します。要求用のDTOを明示的に用意してください。
フックが投げた想定外の例外は握りつぶさず、そのままrejectします。

## 古い応答でViewを巻き戻さない

成功済み記録は「その操作が成功した時点の応答」です。再送時点の最新状態ではありません。
`replayOperation` は `committed` のときだけ利用者のreduceを呼び、`replayed` では現在の業務データを維持します。

```ts
operations: {
  submit: replayOperation(commands.submit, replace),
  approve: replayOperation(commands.approve, replace),
  reject: replayOperation(commands.reject, replace),
}
```

[経費精算への適用](../src/expenses/replay.ts)では、承認済みの画面で過去の申請を再送しても、
画面は承認済みのままであることを検証しています。
初期Viewそのものが古い場合は更新しません。別利用者の更新を取り込む再取得や購読はホストが設計します。
明示的に過去の応答を扱いたい場合は `withReplay(...).run()` の結果から `kind` を確認できます。

## 保存の責務は残る

この境界は、独立した `save()` と `recordReceipt()` を安全なトランザクションに変換しません。
在庫のアダプターは在庫・引当・成功済み記録を、経費のアダプターは経費・変更履歴・成功済み記録を、
それぞれ同じDBトランザクションに含めています。

認証済みActorをfingerprintへ含め、役割や有効状態が変わった要求も同じ成功記録として返さないようにした例が、
[経費のSQLite拡張](../src/expenses/sqlite-replay.ts)です。
[経費の実行定義](../src/expenses/replay.ts) は `defineRequestTarget` を使い、要求情報を保存へ渡します。

```ts
const command = defineRequestTarget({
  operation: 'expense.submit.v1',
  load: (call: RequestInput<Input>) => repository.load(call.input, identity),
  save: (change: Change, execution) =>
    repository.saveRequest(request('submit', execution.request), change),
}).on(submitted);
```

コマンドは一度宣言し、要求ごとの接続はフレームワークが作ります。
`execution` は `{ operation, request }`。業務の検証・遷移にはloadの結果だけが渡ります。
既存の `defineTarget` と `save(change)` はそのまま使用できます。
要求なしで保存できないよう、新APIは `run`・`runDetailed`・純粋な `decision` のみ公開し、`mutation` は公開しません。
`runDetailed` でも要求情報とtrace・planが維持されます。

実行情報の外側はfreezeしますが、入力全体のcloneやdeep freezeは行いません。
単体では呼び出し後に入力を書き換えない契約です。再送を扱う場合は `withReplay` のclone済み入力を使います。
要求IDと業務判断が一致するかの検証、認証、原子的な保存は引き続きアダプターの責任です。

`withReplay` の公開alpha.2は `run` を公開します。alpha.3では[再送を含むrunDetailed](replay-trace.md)も提供します。
mutationの準備用APIを再送境界で包むものではありません。
検証用の準備APIを直接呼べば境界を迂回するため、通常の操作には包んだコマンドを使用してください。

## 開発版を検証する

```sh
npm ci
npm run build
npm run test:replay
npm run demo:expenses:replay
npm ci --prefix examples/inventory
npm run check:inventory
npm run test:inventory
npm run test:inventory:package
```

在庫サンプルは、新APIを試すため `file:../..` でビルド済み開発版を参照します。
最後のコマンドはnpmパッケージをpackし、作業ツリー外の一時ディレクトリへインストールして、
型チェック・在庫18テスト・デモを実行します。ソースへの相対importに依存しないことを確認します。
記録の有効期限・削除・フォーマット変更時の移行や、分散トランザクションは提供していません。
