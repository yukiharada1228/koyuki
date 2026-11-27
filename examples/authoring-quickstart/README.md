# 最初の業務操作を作る

React経験者向けの開発版Quick Start。公開済みnpm alpha.5には`koyuki/experimental`が含まれないため、開発版tarballを使用する。APIは実験段階。Reactのインストールは不要で、再描画・useState・useEffectは提供しない。

## 1. 独立したプロジェクトを準備する

このリポジトリを取得し、ルートで実行する。Node.js 22以上とnpmが必要。

```sh
git clone https://github.com/yukiharada1228/koyuki.git
cd koyuki
npm ci
npm run prepare:authoring:quickstart -- ../my-bookings
cd ../my-bookings
npm install
npm run check
npm start
```

既存のフォルダーは上書きしない。準備後はコピーされたtarballと公開importだけを使うため、元リポジトリなしで動く。現在のディレクトリを保存先に指定しない。

成功すると、idがbooking-1、状態がcancelledのResultが表示される。

## 2. 三つのファイルを読む

- `domain.ts`：booked / cancelledのUnionと、認可→キャンセルの純粋なWorkflow。HooksやDBなしで`cancelBooking.run({ booking, actor })`をテストできる。
- `app.tsx`：必要な予約・操作者をresourceとして一度定義し、defineOperationのneedsへ宣言する。取得とResultの値の組み立て・失敗伝播はruntimeが担当する。useSaveで保存先を取得し、部品をProviderの内側へ置く。
- `main.ts`：メモリRepositoryとアプリを作り、`app.execute(cancellation, { id })`で実行する。

利用者は業務ルールと取得・保存方法を記述する。Koyukiがload→業務の合成→saveを実行し、Resultが失敗なら後続を止める。部品を評価するだけでは保存しない。actorはホストで認証した値を渡し、リクエスト本文から採用しない。同じアプリ内の操作名は一意にする。

`.use()`を通常の登録で直接呼ぶ必要はない。自分のカスタムHookへ組み込む場合だけ使用する同期Hookで、状態保持・キャッシュは行わない。

## 3. 業務ルールを一つ変更する

「idがlockedの予約はキャンセル不可」を加える。domain.tsのauthorize-cancelに、ownerの確認の後、状態判定の前で次を追加する。

```ts
if (booking.id === 'locked') return err('CancellationLocked');
```

同じ関数の失敗型にも`'CancellationLocked'`を加える。main.tsで予約と実行入力のidを両方lockedへ変更して試す。

```sh
npm run check
npm start
```

`{ ok: false, error: 'CancellationLocked' }`となる。app.tsxのHook・Provider・save・executeは変更不要。状態型やRepositoryの契約まで変える仕様変更では、その変更も必要になる。期限と時計を導入する例はリポジトリの`docs/authoring-specification-change.md`を参照。

## 4. 内部ルールを追う

```sh
npm run trace
```

executeDetailedは実行と保存を一度行い、その結果と内部ルールのtraceを返す。読み取り専用の確認ではない。trace.tsはmain.tsと別の新しいメモリ状態で実行する。手順3でルールを変更した場合もtrace側はidがbooking-1なので成功する。

## 5. 成功済み要求を再送する

```sh
npm run replay
```

replay.tsxは同じ純粋なWorkflowを利用し、requestId、照合用の入力・操作者、receiptを追加する。最初はcommitted、同じ要求の再送はreplayedとなる。同じrequestIdで対象が変わればIdempotencyConflict。保存境界で状態とreceiptを一緒に更新する必要がある。

この例は一予約・一プロセスのメモリ実装で、再起動すると記録が消える。DBの代用ではない。本番では状態とreceiptを同一transactionで保存し、競合を検出するadapterを使う。三業務とSQLiteの例は、リポジトリの`examples/authoring/README.md`と`docs/authoring-three-businesses.md`へ進む。

## 検証

準備したプロジェクトで`npm run verify`を実行すると、成功、認可失敗、取得失敗、既キャンセル、保存回数、純粋な核、内部traceを確認する。型検査は`npm run check`で別に行う。

リポジトリ側の`npm run test:authoring:quickstart`は、この配布物だけで全手順を実行し、手順3のルール変更がHookやProviderを変えずに適用されることも確認する。保守者AIによる検証であり、人間の初見評価ではない。

業務間のイベント接続は、リポジトリの`docs/declarative-connections.md`へ進む。needsによる依存取得と、emits / Onによる保存後の配送をまとめて試せる。
