# 日程変更の再送と成功結果の再現

既存の`useReplay`を使い、予約の日程変更へrequestId / receiptを接続した。新しいフレームワークAPI、独自の再実行エンジン、外部依存は追加していない。

## 呼び出し方

```ts
// 新しい業務要求を作るときに一度生成する。再送のたびに生成し直さない。
const request = { requestId: crypto.randomUUID(), id: bookingId, startsAt: newStartsAt };
const first = await app.execute(rescheduleBooking, request);
const retry = await app.execute(rescheduleBooking, request);
```

HTTP等のunknown入力は`parseRescheduleRequest`で検証する。予約ID・日時・非空のrequestIdを確認し、失敗なら業務処理へ進めない。

`RescheduleRequest = RescheduleInput & { requestId: string }`とidentityは[rescheduling-request.ts](../src/experiments/declarative-booking/rescheduling-request.ts)に分離した。domainの検証・遷移関数はrequestIdやreceiptを要求せず、従来のRescheduleInputだけで単独テストできる。

## 再送の契約

| 条件 | 結果と実行 |
| --- | --- |
| 未保存のrequestIdで正常な変更 | committed。状態・イベント・成功記録を一度保存 |
| 同じrequestId・予約ID・変更先日時・操作者 | 保存した当時のConfirmedをreplayedで返す |
| 同じrequestIdで予約ID・変更先日時・操作者が異なる | IdempotencyConflict。予約の取得・更新・通知は行わない |
| 別requestIdで現在と同じ日時を要求 | Unchanged。新しい業務要求として検証する |
| 同じrequestId・同じ内容の初回並行要求 | 一方だけcommitted、もう一方はreplayed。状態保存・イベント作成は一回 |
| 同じrequestIdで異なる内容の並行要求 | 一方だけcommitted、他方はIdempotencyConflict |
| 別requestIdの競合変更 | 変更前状態が一致した一方だけ成功し、他方はConcurrentChange |

既存receiptがあれば、予約load・時計・Workflow・saveを実行しない。receiptを読むI/Oは必要。同時に初回到着した要求は両方が計算を行う場合があるが、保存境界の再確認で二重保存・二重イベント作成を防ぐ。

別の変更が後から成功していても、再送には元の要求の成功結果を返す。現在の予約状態を古い結果へ書き戻すことはしない。表示に最新状態が必要ならQueryで読む。

## identityと認証

identityはrequestIdをkeyにし、操作の宣言オブジェクトのname・予約ID・日時・認証済みProviderの操作者IDからfingerprintを作る。nameを文字列で再入力しない。JSON配列の安定した文字列化を使い、Symbolやプロセス内の採番には依存しない。fingerprintは秘密鍵付き署名や認証の代わりではない。

操作者はリクエスト本文から採用しない。identity用の操作者IDもHookの構成時にProviderから捕捉する。サンプルのrequestIdの一意性は同じRepositoryの成功記録内で扱い、操作者が違っても同じkeyの別内容は競合とする。複数tenantへ展開するなら、そのスコープも保存境界で明示する。

## 状態・イベント・receiptを同時保存する

[SQLite](../src/experiments/declarative-booking/sqlite.ts)は`booking_rescheduling_receipts(request_id, fingerprint, data)`を追加する。

1. BEGIN IMMEDIATE。
2. 同じkeyのreceiptをtransaction内でも再確認する。あれば照合してreplayedまたはIdempotencyConflictを返す。
3. 変更前の論理フィールドを照合して予約を更新する。
4. 日程変更イベントをoutboxへ追加する。
5. 成功したConfirmedとfingerprintをreceiptへ追加する。
6. COMMIT。途中失敗ならすべてrollbackする。

事前lookupだけでは並行要求を防げないため、保存内の再確認が必要。メモリ版も比較・状態・イベント・receiptの置換の間でawaitしない。ただしメモリ版は再起動で消える。

復元したreceiptはConfirmedの状態・予約ID・所有者・日時を検証する。不正JSONや入力との不一致ならStorageFailedを返し、代わりに業務をやり直して上書きしない。

## 応答喪失と保存結果不明

呼び出し元へ応答が届かなかった場合も、同じrequestIdを再送すれば成功記録を利用できる。DBを再接続し、元の変更期限を過ぎていても、完了した要求を新しい業務として検証し直さない。

保存境界がStorageFailedなどの想定内失敗を返した場合、既存のuseReplayでreceiptを再確認する。保存済みならreplayed、未保存なら元のエラーを返す。これはWorkflowの再実行ではない。予期しないthrowをuseReplayが一律に握りつぶす設計には変更していない。

保存結果不明からreceiptで成功を確認した場合、元の実行からイベントを再発行しない。transactionで残ったoutboxを別途deliverし、通知を回復する。

## 配送との違い

要求の再送はイベントを追加しない。保存済みイベントの再配送は同じenvelopeを使う別の処理で、元の日程変更を実行しない。

通知失敗でもcommittedの業務結果を維持する。outboxの再配送・ack・外部送信の重複防止はホストの責務で、通知のexactly-onceを保証するものではない。receiptの保持期間を超えて削除したkeyには、元の再送保証は適用できない。

## 変更点と制約

日程変更操作の入力にはrequestIdが必須となり、成功値はExecution<Confirmed>のcommitted / replayedのUnionとなる。内部ルールのtraceは詳細レポートのattempt.traceへ入り、receiptだけの再送ではattemptがnullとなる。イベントの安定名・payload・業務ルールは維持した。

既存DBにはconstructorのCREATE TABLE IF NOT EXISTSで成功記録用テーブルを追加する。旧版で成功済みだがreceiptのない要求へ、後から対応関係を推測して補完することはしない。操作名を変更する場合も、fingerprintと保存済みreceiptの扱いを決める必要がある。

変更前状態の比較は論理値によるもので、全履歴のABA検出用の単調versionではない。常駐worker、保持期限、実メールの運用はホスト側で設計する。

## 検証

`src/authoring-rescheduling.test.tsx`で、メモリ・SQLiteの両方について同一要求・異なる内容の並行処理、過去の結果の再現、IDの再利用拒否、保存結果不明からの解決を確認する。SQLiteではreceipt INSERTの失敗で予約とoutboxもrollbackし、不正なreceiptから業務が再実行されないことを確認する。

応答喪失を模した呼び出しの後にDBを再接続し、期限を過ぎた時計と新しいアプリで再送する検査も含む。再送時のload・時計・saveはゼロ、イベント・通知の追加もゼロ。配布物では公開importだけで同じ実行とTS6/7の要求型・成功型・エラー型・生成宣言を検査する。

2026-11-27の検証結果: 型検査と全1315テストが成功。公開importだけの別プロジェクトでもTS7.0.2 / TS6.0.3の型検査・宣言生成・生成宣言consumer、39実行テストが成功した。型の精度低下・不正な型絞り込み、view更新・イベント配送を壊す負例も検出した。check:package / test:portableで、実行時依存ゼロ・31ローカルJSモジュール・Node型なしの宣言・Nodeグローバルなしの実行を維持した。npm公開やリモートCIの再実行は行っていない。
