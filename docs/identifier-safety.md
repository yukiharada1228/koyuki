# 識別子と接続の安全性

開発版 `koyuki/experimental` の公開APIと予約サンプルの見直し記録。公開済みalpha.5への変更ではない。

## 現行コードの文字列を役割で分ける

| 役割 | 実例 | 既存の保証と今回の扱い |
| --- | --- | --- |
| 業務上の識別子 | `Input.id`、予約の`owner`、`Actor.id`、`approvedBy` | 従来はすべてstringで取り違え可能。予約モデルに検証付き`BookingId` / `ActorId`を導入する |
| 状態・エラーの選択肢 | `draft` / `requested` / `confirmed`、`Forbidden` / `StorageFailed` | 既存のタグ付きUnion・Resultで検査できる。定数・enum・ブランドへ変更しない |
| 操作・Resource・イベントの宣言名 | `booking.approve.v1`、`current-booking`、`booking.confirmed.v1` | 接続はすでに宣言オブジェクト参照。文字列によるlookup APIは追加しない |
| traceの表示名 | `validate-approval`、`approve`、`resource:current-booking` | 人が処理を追うためのラベル。接続先を選ぶキーではなく、一意性やブランドを要求しない |
| 永続化・再送・外部連携の安定名 | `EventEnvelope.type`、outboxのevent type、操作名、requestId・fingerprint | 再起動後にも同じ文字列を保存する。Symbol・採番へ置き換えない。イベントUUIDは個々の配送物のIDでありevent typeとは別 |

操作名はtraceにも使われるが、再送境界へ渡す名前でもある。単なる表示名のつもりで変更しない。Resource名は現在は取得traceと同じ依存グラフ内の重複検査に使い、永続イベントのキーにはしない。

## 業務モデルが定義すること

[予約のdomain.ts](../src/experiments/declarative-booking/domain.ts)と[Quick Startのdomain.ts](../examples/authoring-quickstart/domain.ts)が、それぞれのモデルに閉じたID型と生成関数を持つ。[部品化比較の予約モデル](../examples/booking-composition/domain.ts)も同じ方針に更新した。各例は独立したサンプルであり、型を相互交換するための共通IDライブラリではない。

```ts
const id = bookingId('booking-1');
const actor = actorId('alice');
if (id.ok && actor.ok) {
  // app.execute(submitBooking, { id: actor.value }); // 型エラー
  // 正しい入力は { id: id.value }
}
```

生成関数はunknownを受け取り、空・空白だけの文字列や非文字列には、それぞれInvalidBookingId / InvalidActorIdのResultを返す。業務固有のID形式・長さ制限がある場合はここに追加する。検証後のブランド付与だけをモデル内の型アサーションに閉じ込め、呼び出し側に`as BookingId`を要求しない。フレームワーク共通のブランド生成APIは不要だった。

HTTPなどの予期される入力失敗には`parseBookingInput(unknown)`を使う。

```ts
const parsed = parseBookingInput(await request.json());
if (!parsed.ok) return new Response(parsed.error, { status: 400 });
const result = await app.execute(submitBooking, parsed.value);
```

JSON自体の解析エラーはHTTPホストで処理する。操作者はリクエスト本文から採用せず、ホストが認証したユーザーIDを`actorId`で検証しProviderへ渡す。文字列形式の検証は認証・認可を意味しない。

ブランドは実行時のタグではない。同じ形の生文字列が予約か操作者かを自動判定できず、開発者が誤った生成関数を明示的に呼ぶことやany・型アサーションによる迂回までは防げない。JSON/DBを通ると型情報は消えるため、`restoreBooking`とイベント`decode`でフィールドと状態を検証し直す。SQLite/outboxのJSON形式は変わらない。

## JSX・Context・Hooksで接続する

```tsx
const approveBooking = defineOperation('booking.approve.v1', {
  needs: { booking, actor },
  execute: approval, // 独立した予約domainのWorkflow
  useSave: useSaveBooking,
  emits: [emit(bookingConfirmed)],
});
<ActorContext.Provider value={authenticatedActor}>
  <Bookings.Provider value={repository}>
    <Operation operation={approveBooking} />
    <MailContext.Provider value={sender}>
      <On event={bookingConfirmed} operation={notifyBooking} />
    </MailContext.Provider>
  </Bookings.Provider>
</ActorContext.Provider>
```

操作・Resource・イベントを各々一度定義し、needs / emit / Operation / On / execute / projection / refreshQueryへそのオブジェクトを渡す。名前を再入力して接続しない。入力・成功値・エラーはResource、業務関数、saveの型から推論し、イベントpayloadもOnの入力へ引き継ぐ。業務ルール自体はHooksやJSXをimportしない関数として保つ。

名前とオブジェクトの役割は異なる。同じアプリ内で同名の別イベントを作っても接続できず、構成エラーになる。プロセス再起動後の外部配送は、保存された安定名を登録済みイベントへ照合し、decodeに成功してから受け手を実行する。サンプルの`bookingConfirmedName`はdomainと保存アダプターが共有する一つの安定名であり、接続のための文字列再入力ではない。

## 構成時検査と保証範囲

以下は今回以前から存在する保証。作り直さず、回帰検証を追加・維持した。

- 操作・Queryはアプリ内で同名または同じ宣言の二重登録を拒否する。
- イベントはアプリ内の同名別宣言、受け手の欠落（externalを除く）、自動配送の循環を拒否する。
- Resourceは一操作・Queryの依存グラフ内で同名別宣言と循環を拒否する。同じ宣言の複数参照は一実行一取得。別操作や別Providerスコープの同名Resourceは許される。グローバルに同名禁止にはしない。
- 型の合わないneeds→業務関数→save、emitの射影→event→Onは型検査で拒否する。型検査を意図的に迂回した関数の意味・実装までは実行時に検証できない。
- 構成検査はcreateApplication時、load・業務計算・save・配送の前に行う。Hooks・Provider・Resource factoryは構成のために同期評価されるため、そこに業務I/Oを隠さない。

今回、空白だけの操作名・Query名を宣言時に拒否するよう補った。Resourceとイベントには既存の空名検査がある。非空の名前は自動trim・改名せず、そのまま安定名として保持する。

保存失敗時にイベントを配送しない。通知が失敗しても保存済み業務結果を失敗へ書き換えない。成功済み要求の再送は既存receiptでreplayedとなり、再保存・再発行しない。永続イベントの再配送自体はat-least-onceで、受け手の冪等性・状態とoutboxの同時保存・ack方針はアダプター側の責務。予約SQLiteサンプルがその境界を示す。

## 破壊的変更と検証

予約・Quick Startのモデル、操作入力、操作者Provider、MailのIDフィールドはstringからブランド型へ変更した。呼び出し元は検証付き生成関数か入力パーサーを使い、成功値を取り出す。生成関数もResultを返すため、直接IDとして渡さない。互換aliasや生stringのオーバーロードは追加しない。状態タグ・エラー名・既存の宣言オブジェクトAPI・保存JSON・安定イベント名は変更しない。

`npm run check`、`npm test`、`npm run test:authoring:quickstart`、`npm run test:connections:package`、`npm run test:booking:composition`で確認する。配布物検証では公開importだけの別プロジェクトでTS6/7の入力・出力・エラー推論、ID取り違えとイベント誤接続のコンパイル拒否、宣言生成と宣言のみのクライアント、実行、SQLite再接続・rollback・配送停止・通知失敗・再送を検証する。

2026-11-27の作業ツリーでの検証結果:

| 検査 | 結果 |
| --- | --- |
| `npm run check` / `npm test` | 型検査成功、1303テスト成功 |
| `test:connections:package` | TS7.0.2 / TS6.0.3、宣言生成・宣言クライアント、27実行テスト成功。型付きIDの正しい入出力・イベント接続と取り違え拒否を含む |
| `test:authoring:quickstart` | 独立配布物で開始・trace・再送・入力検証・業務変更成功。認可削除の負例も検出 |
| `test:booking:composition` | TS6/7・宣言生成、JSX/関数版の同一結果と24h/48h方針・操作者分離成功。固定方針の負例も検出 |
| `test:authoring:package` / `test:authoring:change` | 既存の三業務・SQLite・並行実行・永続再送・rollbackと期限変更検証成功 |
| `check:package` / `test:portable` | 実行時外部依存ゼロ・31ローカルJSモジュール・Node型なしの宣言検査、Nodeグローバルなしのブラウザー実行成功 |

配布物のview反映・Query再取得・イベント配送をそれぞれ削除する負例も失敗として検出した。npmへの公開とリモートCIの再実行はこの作業では行っていない。

後続の[保存後の型推論改善](authoring-save-inference.md)では、予約の申請・承認が保存を通しても状態別の成功型を維持するようにした。IDのブランドとエラー型も生成宣言で保持する。上表は識別子対応時点の記録であり、後続の検証結果は同文書を参照。

後続の[ID検証のResult統一](booking-validation-results.md)で、生成関数のTypeErrorを廃止した。parseBookingInputは形の不正とID値の不正を別のエラーで返す。
