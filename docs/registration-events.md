# メールと人の確認を挟むイベント接続

開発版の実行例。講演[izV1h6o3hgQの64:39–66:24](https://www.youtube.com/watch?v=izV1h6o3hgQ&t=3879s)で述べられた、
登録→メール→確認イベント→次のworkflowという構想を検証する。
講演で実証済みの方法ではなく、Koyukiで具体化した設計。
公開alpha.5にこのサンプルとfromPromiseは含まれない。

## 状態と境界

| 現在の状態 | 入力 | 検証 | 成功状態・副作用 |
| --- | --- | --- | --- |
| 登録なし | 登録要求 | ID・メール・重複 | awaitingとEmailRequestedを同一トランザクションで保存 |
| outbox未配送 | workerのtick | lease取得 | メールadapterへ渡し、同じclaim所有者が完了記録 |
| awaiting | 人の確認要求 | tokenのdigest・状態 | confirmedをCAS保存 |
| confirmed | 再度の確認 | 状態検証で拒否 | 変更なし |

[domain.ts](../src/registration/domain.ts)のRegistrationは直和。
awaitingにはdigestとversion 1、confirmedには確認時刻とversion 2が必須。
Changeも、初回保存とイベント作成／確認保存とイベントなしの直和で表す。
private brandにより、検証前の構造をそのまま遷移へ渡せない。

[application.ts](../src/registration/application.ts)では二つのdefineUseCaseへ通常関数を宣言する。
秘密tokenはホストがWeb Cryptoで生成し、確認時に比較するdigestはSHA-256で求める。
状態保存とイベント作成は[SQLite adapter](../src/registration/repository.ts)が一つの短いDBトランザクションで行う。
メール送信や人の応答を待っている間、トランザクションやApplication sessionを保持しない。

[配送定義](../src/registration/delivery.ts)は、次の実行を既存のprocessへ委譲する。

```ts
return process<Tick>()
  .effect('claim-email', tick => repository.claim(tick.now, tick.leaseMs))
  .effect('send-email', send)
  .effect('ack-email', delivery => repository.acknowledge(delivery));
```

claim失敗なら配送しない。配送失敗なら完了記録しない。
例外を返す既存のメールSDKはfromPromiseで型付きのDeliveryUnavailableへ変換する。
後続へDeliveryを戻すadapterは、どのメッセージを完了記録するかを明示するためのもの。
純粋なdomainはメールSDK・SQLite・時計を参照しない。

processには直接run / runDetailedできる入口があり、完了記録のためだけの空のvalidate/evolveは不要。
配送traceはclaim-email→send-email→ack-emailの実行した段階だけを示し、mutationのplanはnullとなる。
状態遷移と保存を最後に実行する場合は、従来のcommitを引き続き利用できる。
詳細は[途中のI/Oを接続する](process.md)を参照。

## 障害時の契約

- 登録とoutboxの片方だけは保存しない。二つ目のINSERTをDB triggerで失敗させてrollbackを確認する。
- outboxのclaimは一つの原子的UPDATEで取得する。lease期限までは別connectionが同じイベントを取得できない。
- 期限後は別workerが再取得できる。claim tokenが変われば古いworkerの完了記録を拒否する。
- 配送が失敗したり、配送後にプロセスが終了して完了記録できなければ、期限後のtickで再試行する。
- 配送はat-least-once。配送先が永続的な重複排除を行う場合はevent.idをキーにする。
  サンプル内のSetによる重複排除テストは、この契約のモデルであり実際のメール事業者の保証ではない。
- leaseを越える遅い配送中に別workerが再取得すれば、配送が重なることがある。claim tokenは外部メールの送信を取り消せない。
- workerのスケジュール・再試行の待機・監視・不正イベントの隔離はホストの責務。
  この例では期限切れleaseの再取得を使い、heartbeat・backoff・最大試行数・dead letterは未実装。

サンプルは実際のメールを送信しない。MailSenderをテストadapterへ注入する。
認証済みユーザー管理、tokenの期限・再発行、メールアドレスの変更や重複規則、秘密情報の保管・削除は製品要件として別途必要。
この例を完成した会員認証製品とは位置付けない。

## 再現

```sh
npm run check
npm exec -- tsx --test src/registration.test.ts
npm run test:registration:package
```

8テストでDB再接続、別OSプロセス、rollback、再配送、送信後の完了記録失敗、
複数connection、古いclaim、確認の競合、不正データを検証する。
型検査では不正な状態2件と検証を飛ばす遷移1件を拒否。
package検証はリポジトリ外へtarballをインストールし、コアの相対importを公開koyuki importへ置き換える。
SQLiteを含むadapterは配布コアへ追加しない。
