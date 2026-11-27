# ID検証の失敗をResultで扱う

講演の値オブジェクト・検証・関数合成の考え方に合わせ、予約例のID生成関数をResultへ統一した。独自の検証フレームワークは追加していない。

## 変更した契約

| 入口 | 成功 | 失敗 |
| --- | --- | --- |
| `bookingId(unknown)` | `BookingId` | `InvalidBookingId` |
| `actorId(unknown)` | `ActorId` | `InvalidActorId` |
| `parseBookingInput(unknown)` | `{ id: BookingId }` | `InvalidBookingInput`または`InvalidBookingId` |
| `restoreBooking(unknown)` | `Booking` | `CorruptBooking` |

すべてResultを返す。生成関数は空・空白だけの文字列と非文字列を例外で投げず、失敗の値にする。入力パーサーはtry/catchで生成関数の例外を変換する必要がなくなった。DB・イベントの復元では同じ生成関数で検証し、永続データの不正はCorruptBookingへまとめる。

Quick Start、宣言的な予約業務、JSX/通常関数の比較例を同じ方針へ変更した。各モデルのブランドは引き続き独立したもの。状態・エラーのUnion、安定イベント名、保存JSON形式、フレームワークの実行処理は変えない。

```ts
const id = bookingId(rawId);
if (!id.ok) return id;
return app.execute(submitBooking, { id: id.value });
```

ID生成自体も普通の業務関数として合成できる。

```ts
const identify = workflow('validate-booking-id', bookingId)
  .then('use-booking-id', useBookingId);
```

独立した複数項目の検証には既存のcollectを利用できる。Quick Startの起動データはこれを使い、どちらかが不正なら構成・業務実行へ進まず失敗のResultを返す。操作者は認証済みのホスト情報を使い、本文から取り出して認証の代用にしない。

## 破壊的変更

以前の`bookingId(value)` / `actorId(value)`は検証済みIDを直接返し、失敗時にTypeErrorを投げた。現在はResultを確認してvalueを取り出す。throw互換の別入口や、未検証の型アサーションは要求しない。

`parseBookingInput({ id: 1 })`は以前のInvalidBookingInputからInvalidBookingIdへ変わる。形が不正な`null`や`{}`はInvalidBookingInputのまま。エラーを握りつぶさず、入力の形とID値の失敗を型として区別する。

テストの既知の初期データにだけ`valid`補助を使い、誤ったテストデータはテストの欠陥として例外にする。アプリケーションの外部入力やドメイン生成関数では、この補助を使わない。

## 保証の範囲

文字列の形式検証はIDの存在・認可・認証の証明ではない。TypeScriptのブランドはJSONで消えるので復元境界で検証し直す。JSON解析の失敗、DBやネットワークの例外は、引き続きホストのI/O境界で扱う。任意のgetterやProxyが投げる例外までResultへ変換する汎用サンドボックスではない。

## 検証

- 空白・非文字列などの生成失敗が、例外ではなく型付きResultとなる。
- ID検証をWorkflowへ直接合成し、失敗なら後続関数が動かない。
- collectで予約ID・操作者IDの独立した失敗を両方保持する。
- HTTP相当の入口で不正要求を拒否し、取得・保存・イベント発行・通知がすべてゼロ。
- 正常入力は既存の業務へ進み、一度だけ保存する。
- BookingId / ActorIdの交換と、ResultそのものをIDとして渡すコードを型検査で拒否する。
- Quick Start・比較例・配布物のTS6/7と宣言生成でも、成功値・失敗型・ブランドを維持する。

2026-11-27の検証結果: 型検査と全1305テストが成功。公開importだけの配布物ではTS7.0.2 / TS6.0.3の型検査・宣言生成・宣言consumerと29実行テストが成功した。Quick Startの開始・trace・再送・仕様変更、予約のJSX/関数版比較も成功。保存型の精度低下・不正な型絞り込み・view更新や配送の削除に対する負例検査も維持した。実行時外部依存ゼロ・31ローカルJSモジュール・Node型なしの宣言検査と、Nodeグローバルなしのブラウザー実行が成功した。
