# 最初の業務操作を作る

React経験者向けのalpha.6 Quick Start。純粋な業務関数 → Operation → JSXの実行スコープ → Guard → trace → 再送の順に試す。

alpha.6のnpmパッケージに含まれる`koyuki/experimental`を使う。alpha.5以前にはこの入口は含まれない。Reactは不要。Hooksは構成時に依存を取得する仕組みで、Reactの再描画・useState・useEffectは提供しない。

## 1. 独立プロジェクトで実行する

Node.js 22以上とnpmが必要。リポジトリのv0.1.0-alpha.6タグのチェックアウトで実行する。

```sh
npm ci
npm run prepare:authoring:quickstart:registry -- ../my-bookings
cd ../my-bookings
npm install
npm run check
npm start
```

成功すると`{ ok: true, value: { kind: 'cancelled', id: 'booking-1', owner: 'alice' } }`が表示される。既存フォルダーは上書きしない。npmから取得したalpha.6と公開importのみで動き、元リポジトリへの相対importはない。`REGISTRY.json`に対象版とregistryのintegrityを記録する。未公開の変更を試す場合は`prepare:authoring:quickstart`でtarballを使う。この場合だけ`DEVELOPMENT.json`へ作成元コミットとtarballのhashを記録する。

## 2. 業務関数を読む

`domain.ts`はbooked / cancelledのUnion、BookingId / ActorId、検証付き生成関数、認可→キャンセルを合成するWorkflowを定義する。DB・Hooks・JSXなしで実行できる。

```ts
cancelBooking.run({ booking, actor });
```

`booking`と`actor`は検証済みの値。元の予約は変更せず、新しい状態またはResultの失敗を返す。ID生成関数もResultを返し、利用側の無検証の型アサーションを必要としない。`actorId`は認証ではなく、認証済みホスト情報を型付きのIDへ変換する関数である。

## 3. 取得・保存と業務部品を読む

`app.tsx`の`cancellation`は`needs`で予約と操作者を受け取り、`execute`で業務関数を実行し、`useSave`で保存関数を取得する。`BookingOperations`がJSX登録をまとめる。

`createBookingApp(repository)`はRepositoryを供給する再利用可能な業務ツリーを返す。操作者はここへ埋め込まず、`main.tsx`で実行スコープを作る。

```tsx
const business = createBookingApp(repository);
const session = business.scope(children => (
  <Actor.Provider value={authenticatedActor}>{children}</Actor.Provider>
));
await session.execute(cancellation, input);
```

`scope`ごとにHooksを評価し、別の操作者のハンドラーを作る。共有Contextを書き換えない。構成時に取得・保存は始まらず、実際のI/Oは`execute`で始まる。通常の登録で`.use()`を直接呼ぶ必要はない。

外部入力から実行する入口は次のようになる。`h`と`Actor`はJSXのためにimportする。

```tsx
import { h } from 'koyuki/experimental';
import { parseBookingInput, actorId } from './domain.js';
import { Actor, createBookingApp, cancellation } from './app.js';
const business = createBookingApp(repository);
async function cancelRequest(body: unknown, authenticatedUserId: unknown) {
  const input = parseBookingInput(body);
  if (!input.ok) return input;
  const actor = actorId(authenticatedUserId);
  if (!actor.ok) return actor;
  const session = business.scope(children => (
    <Actor.Provider value={actor.value}>{children}</Actor.Provider>
  ));
  return session.execute(cancellation, input.value);
}
```

Repositoryと認証済みユーザーはホストが供給する。本文から操作者を採用しない。予約IDへ操作者IDを渡す誤りは型検査で拒否する。Unionの状態名やエラー名を一律にブランド化する必要はない。

## 4. 業務ルールを変更する

「lockedという予約はキャンセル不可」に変更する。`domain.ts`の`authorize-cancel`で、所有者確認の後、状態判定の前に追加する。

```ts
if (booking.id === 'locked') return err('CancellationLocked');
```

同じ関数の失敗型にも`'CancellationLocked'`を追加する。`main.tsx`の初期データと実行対象のIDを両方lockedにして試す。

```sh
npm run check
npm start
```

`CancellationLocked`の失敗となり、保存しない。Operation・Provider・保存の接続は変更不要。これは一つのルール変更の例であり、状態型や保存契約まで変わる仕様変更でも無変更になる保証ではない。

## 5. 入口の認可を部品として追加する

```sh
npm run access
```

`access.tsx`は同じ`BookingOperations`をGuardで包み、許可・拒否それぞれの実行スコープを作る。拒否時はRepositoryのload/saveを始めない。Guardは業務関数の所有者検証を置き換えない。

Guard拒否は`ExecutionDenied`例外としてrejectし、業務Resultと区別する。実行通知・イベント配送では`denied`となり、想定外の不具合の`defect`とは異なる。HTTPなどへの変換はホストで行う。権限Contextは要求時のスナップショットであり、外部の権限変更を自動購読するものではない。

## 6. 内部ルールを追う

```sh
npm run trace
```

`trace.tsx`の`executeDetailed`は実行・保存を一度行い、結果と内部ルールのtraceを返す。読み取り専用の確認ではない。mainとは別のメモリ状態を使う。手順4でルールを変えても、trace側のIDはbooking-1なので成功する。

## 7. 成功済み要求を再送する

```sh
npm run replay
```

`replay.tsx`も業務ツリーとActorの実行スコープを分離し、同じ純粋なWorkflowへrequestIdと成功記録を加える。初回はcommitted、同じ要求はreplayed、同じrequestIdで対象が違えばIdempotencyConflictとなる。

基本の`memoryBookings`は並行更新・再起動への保証のない小さなデモ。再送例は一予約・一プロセスで状態とreceiptを同時更新するが、これも再起動すると消える。本番では競合検出と状態・イベント・receiptの同一transactionが必要である。

## 検証と次の例

```sh
npm run verify
```

成功・拒否・未検出・重複実行・保存回数・純粋な核・内部traceを検査する。操作は`cancellation`の参照を登録と実行で共有し、名前の再入力をしない。同名操作は構成時に拒否する。予約IDと操作者IDの取り違え、未検証文字列、余分なactor入力は`npm run check`の負例で検査する。

このリポジトリのルートでは`npm run test:authoring:quickstart`が準備から実行、認可ガード、ルール変更まで検証する。公開されたalpha.6を検証するには`npm run test:authoring:quickstart:registry`を使う。

次にリポジトリの`docs/execution-scopes.md`、`docs/declarative-connections.md`、`docs/expense-budget-study.md`へ進む。予算付き経費精算のSQLite例はNode.js 26を使用する。独立プロジェクトへコピーしたこのREADMEからは、これらを元リポジトリで参照する。
