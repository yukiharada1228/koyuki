# 休暇申請のHTTP API

Koyuki alpha.5を、公開入口`koyuki`から使うHono＋SQLiteサンプル。
HonoとNodeサーバーはアプリケーションの依存で、Koyukiコアの実行依存は追加しない。
Node.js 22.13以上（開発・検証環境は26.12.0）が必要。

## 起動

リポジトリのルートから：

```sh
npm ci
npm run build
cd examples/leave-http
npm ci
LEAVE_OWNER_TOKEN=owner-demo-token LEAVE_MANAGER_TOKEN=manager-demo-token npm start
```

`127.0.0.1:4321`で起動し、`.data/leave-http.sqlite`へ保存する。
従業員`owner`の5日分の台帳を初回だけ作る。再起動時には残日数をリセットしない。
`PORT`、`LEAVE_DB`で変更できる。owner/managerのトークンは別の空白なし文字列を設定する。
上記はローカルデモ用の資格情報。実環境ではホストの認証に差し替える。

```sh
# 3日分を申請して仮確保
curl http://127.0.0.1:4321/accounts/owner/leaves/leave-1/submit \
  -H 'Authorization: Bearer owner-demo-token' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: submit-1' \
  -d '{"expectedVersion":1,"days":3}'

# 管理者が承認
curl http://127.0.0.1:4321/accounts/owner/leaves/leave-1/approve \
  -H 'Authorization: Bearer manager-demo-token' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: approve-1' \
  -d '{"expectedVersion":2}'

# 最新の台帳と残日数
curl http://127.0.0.1:4321/accounts/owner \
  -H 'Authorization: Bearer owner-demo-token'
```

取り下げは`POST /accounts/:employee/leaves/:leaveId/withdraw`。
本文は`{"expectedVersion":現在のversion}`。本人のpendingだけ取り下げられる。
承認後は取り下げられない。このデモは全休・年度単位の簡易モデルで、日付や半休・繰越は扱わない。

## HTTP契約

| 操作 | 本文 | 成功 |
| --- | --- | --- |
| POST …/submit | expectedVersion、days（正の安全な整数） | 200、Execution<Account> |
| POST …/approve | expectedVersion | 200、Execution<Account> |
| POST …/withdraw | expectedVersion | 200、Execution<Account> |
| GET /accounts/:employee | なし | 200、accountとbalance |

POSTの本文はJSONで、上記以外のフィールドを拒否する。body上限4096bytes。
actor、role、employee、leaveId、requestIdを本文に埋め込まない。
操作者は認証、対象はURL、要求IDは`Idempotency-Key`から決める。

成功例：

```json
{"ok":true,"value":{"kind":"committed","value":{"employee":"owner","granted":5,"version":2,"leaves":[{"id":"leave-1","days":3,"kind":"pending"}]}}}
```

同一要求の再送は`kind: "replayed"`で、保存時点の成功値を返す。
別操作がその後に進んでいる場合もあるため、現在の台帳を表示するときはGETで再取得する。
要求IDはこのDB全体で一意。異なる操作・入力・操作者に同じIDを使うと409。
同じ要求を再送するときはURL・本文・要求IDを維持する。
すべての応答は`Cache-Control: no-store`。

| 失敗 | HTTP |
| --- | --- |
| 入力・JSON・要求IDが不正 | 400 |
| 未認証・資格情報が無効 | 401 |
| 非アクティブ、他人の台帳、承認権限なし | 403 |
| 台帳がない | 404 |
| version競合・同じIDの別要求・不可能な遷移 | 409 |
| 本文が大きすぎる | 413 |
| JSON以外 | 415 |
| 残日数不足 | 422 |
| 保存先が利用できない・保存データが破損 | 503 |
| 予期しない例外 | 500、内部の例外情報は返さない |

401・403の判定はreceipt照会より前に行う。
管理者は全台帳を参照・承認できるというデモ用ポリシー。組織・担当範囲は未実装。
`createLeaveHttp(repository, authenticate)`のauthenticateをホストで実装し、
業務とscopeの認可方針も実際の組織に合わせる。本文のユーザー情報は信用しない。

## 実装の境界

- domain.ts：既存休暇の状態・検証済み証拠・純粋な遷移。不変条件は変更していない。
- repository.ts：既存SQLiteのCAS、データとreceiptの原子的保存、復元。
- application.ts：defineUseCaseGroupで共通接続を宣言し、3操作を接続。
- http.ts：Honoによる認証、アクセス制御、入力変換、エラー→HTTP応答。
- server.ts：Node/SQLite/デモ資格情報の組み立て、永続ファイル、終了処理。

domainとrepositoryはalpha.2固定の比較基準`examples/leave`から同じ内容を持ち込んだもの。
このサンプルを単独のconsumerとして検証するために配置している。
applicationの接続だけを新APIへ移し、業務の変更とは分けている。

HTTPは要求ごとに認証済みactorへコマンドを束縛し、runDetailedを呼ぶ。
複数ユーザーで一つのインプロセスApplicationセッションを共有しない。
永続状態はSQLiteを正とする。

任意の`onReport`で再送と実際の業務処理のtraceを観察できる。
通常・再送・要求失敗・元の保存失敗を含む記録で、HTTPに詳細や個人情報をそのまま返さない。
callbackの同期例外・Promise拒否はHTTP結果を変えない。非同期observerの完了は待たず、
プロセス終了時の配送を保証しないため監査ログやoutboxの代わりには使わない。

型付き保存失敗は既存の再照会方針で解決する。
保存後に予期しない例外が起きた場合は500になることもあり、500は「保存されなかった」の保証ではない。
同じ要求IDでの再送は保存済みreceiptから回復できる。HTTPアダプターは自動再試行しない。

## 検証

ルートから：

```sh
npm run check:leave:http
npm run test:leave:http
npm run test:leave:http:package
```

15テスト：3操作と参照、過去の応答と最新状態の区別、認証失効と偽装、入力不正、
失敗のHTTP変換、unknown commitのtrace、observer失敗、
2接続の同時競合／同一要求、接続の再生成、実TCP、前提条件での停止、
実サーバーのプロセス再起動、保存後のthrowからの回復。

package検証では作業ツリー外へソースをコピーし、packしたKoyukiをインストールして
型検査と同じHTTPテストを実行する。フレームワーク内部への相対importは使わない。

Honoの[アプリAPI](https://hono.dev/docs/api/hono)と
[Body Limit](https://hono.dev/docs/middleware/builtin/body-limit)を参照して実装。
今回の開発体験の評価は[FINDINGS.md](FINDINGS.md)に記録する。
