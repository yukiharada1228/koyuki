# 配送中のleaseをホスト側で維持する

開発版サンプルの `renewingEmailWorker` は、遅いメール配送中にleaseを更新する。
純粋な業務関数と公開コアには、時計・DB・常駐workerを追加しない。

```ts
const worker = renewingEmailWorker(repository, sender, {
  everyMs: 5_000,
  now: () => Date.now(),
});
await worker.run({ now: Date.now(), leaseMs: 30_000 });
```

senderの契約は `send(event, signal): Promise<void>`。実際のprovider呼出しへsignalを渡す。
event.idを重複排除キーにする方針は従来どおりで、実providerとの接続はこのサンプルでは行わない。
このworkerも一回の試行を行う入口であり、tickのスケジュールと再試行はhostが決める。
従来の `emailWorker` は、固定leaseを使う比較用の入口として維持する。

## 所有権と実行の境界

1. claimは従来と同じSQLiteの原子的UPDATEで取得する。
2. 送信直前に実際の時計でrenewする。遅延したtickのleaseが既に切れていれば送信しない。
3. 配送を待つ間、hostのタイマーから順次renewする。同時に複数のrenewを走らせない。
4. 所有権喪失や更新失敗ならsenderへabortを通知し、acknowledgeへ進まない。
5. 送信完了後はタイマーを止め、進行中のrenewの結果を確認する。最後にもう一度renewが成功した場合だけacknowledgeする。

renewはevent.id・claim token・未配送・現在時刻より先のlease期限を条件にする。
期限切れの所有権を復活させず、別workerのclaimや完了済みのイベントを更新しない。
期限は既存値とのMAXを使い、短い更新要求で生きているleaseを縮めない。

`claim-email` / `send-email` / `ack-email` の接続と失敗停止はProcessが担当する。
個々のrenewはhostのsend adapter内のI/Oであり、各renewの永続履歴が自動生成されるという意味ではない。
取得したdeliveryは前回追加した名前付きeffectでtickへ接続し、手動のResult取り出しは行わない。

## 検証した範囲と残件

`registration-lease.test.ts` の10件は実SQLiteと独立した二接続を使い、次を検査する。

- 元の期限を越える遅い配送でも、更新した期限内は別connectionが取得できない。
- 期限ちょうどの更新、古いclaim、配送済みのclaimを拒否する。
- 所有権喪失時のabort通知、後からrejectするprovider promiseの処理、ackへの非進行。
- 送信失敗、時計の例外、SQL triggerによるrenew失敗でイベントを完了しない。
- 古いtickから送信を開始しないこと、送信が期限後に終わった場合の拒否。
- 停止時の待機解除、既定のWebタイマー、classで実装した時計のreceiver保持。
- 送信完了と更新例外が重なっても、タイマーの停止を理由に更新の失敗を無視しない。

時間経過の大半は注入した時計と待機で制御し、実時間の短いsleepに成否を依存させない。
配布物のconsumerで既存の9件と合わせて19件を実行する。

heartbeatは停止や二重配送を完全には防がない。event loopの停止・プロセス終了・時計のずれ・
DBの長い待機で更新できない場合がある。全workerの時計は同じ基準で運用する必要がある。
senderがabortを無視した場合やproviderが既に受理した場合、送信を取り消せない。
送信後のack失敗も再配送につながるため、exactly-onceを保証しない。

注入するwaitはabort時に速やかに完了する契約。既定実装はWeb標準のsetTimeoutとAbortSignalを使う。
everyMsは1〜2,147,483,647の整数でleaseMs未満とし、タイマーの範囲を超える設定を拒否する。
providerの配送期限、永続scheduler、backoff、最大試行数、dead letter、監視・秘密情報の保管運用は別の残件。
独立利用者の評価、一般の型推論の制限、講演全体の部分充足という判定も維持する。
