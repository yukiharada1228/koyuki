# 明示した安全条件で段階を再試行する

開発版の`retryEffect`は普通のasync Result関数を包む、任意の境界。
公開npm alpha.5には含まれない。withReplay自体の挙動は変更しない。
例外を自動的に一時障害へ読み替えず、Resultの失敗をhostが分類した場合だけ再試行する。

```ts
import { retryEffect, type RetryAttempt, type Result } from 'koyuki';

// hostの読み取り専用port。Unavailable時に業務変更を適用していない契約。
declare function read(input: { id: string }, execution: RetryAttempt): Promise<Result<string,
  { kind: 'Unavailable' } | { kind: 'Forbidden' }>>;

const guardedRead = retryEffect(read, {
  maxAttempts: 3,
  decide: error => error.kind === 'Unavailable'
    ? { kind: 'retry', safety: 'not-applied', delayMs: 100 }
    : { kind: 'stop' },
});
const controller = new AbortController();
const result = await guardedRead({ id: 'item' }, { signal: controller.signal });
```

普通の一引数関数も渡せる。第2引数を受けるportはattempt（1始まり）とsignalを利用できる。
Processのeffectやbusinessのloadには一引数の関数としてそのまま渡せる。
signalは呼出しごとの第2引数。Processがsignalを自動注入する機能は追加していない。
receiverが必要なport methodはhostがbindして渡す。

## 再試行の条件

retryの判断には毎回safetyを必須とする。

- `not-applied`：その失敗では対象の副作用が適用されていないというhostの保証。
- `idempotent`：同じ要求を再実行しても重複しないというhostの保証。例は状態とreceiptの原子保存。
- `stop`：そのResultをそのまま返す。

これらの文字列が冪等性を作るわけではない。maxAttemptsやエラー名だけから安全性を推測しない。
権限不足・業務拒否・version競合を一律にretryへ分類しない。
成功、stop、試行上限では元のResultをそのまま返し、成功値をコピーしない。
最後の試行の失敗に対してdecideは呼ばず、そのResultを返す。
callbackやportのthrow/rejectは元の例外でrejectし、再試行しない。

maxAttemptsは最初の実行を含む1以上のsafe integer。
delayMsは0以上2,147,483,647以下の整数で、Web標準のtimerで待機する。
不正な上限は構築時に、不正なretry判断はその段階でthrowし、それ以降のIOへ進まない。
指数backoff・jitterはhostがdecideで計算できるが、既定の自動方針はない。

## 要求の所有と中断

最初のawaitより前に[要求snapshotの契約](replay-request-snapshot.md)でDTOを所有する。
各試行へ別のコピーを渡すため、呼出し元やportの変更で次の要求ID・内容が変わらない。
対応外のclass・関数・accessor等はRetryInputNotCloneableで、IOの前に拒否する。
opaqueなdomain値を黙って別形式へ変換する境界ではない。

開始前にsignalがabortedならRetryInterrupted（attempts: 0）を返す。
待機中の中断ではtimer/listenerを解除し、次の試行へ進まない。
失敗後の中断結果にはattemptsとlastErrorを含める。signal.reasonは収集しない。

実行中のportを強制終了したり、結果より先に中断を返したりはしない。
signalはportへ渡すが、実行中の成功は確定済みの可能性があるため、その成功を返す。
実行中の失敗は完了後にRetryInterruptedへ含める。portがrejectすれば例外はそのままrejectする。
中断はrollback・未保存の証明ではない。応答喪失はreceipt等で解決する。
portが終了しなければ待ち続ける。試行上限はportの実行時間や分散実行を制限しない。

## 保存済み結果の再取得との接続

retryEffectでwithReplay付きcommandのrunを包む場合も、安全条件を明示する。
retryEffectは同じDTOを維持し、各呼出しのwithReplayがreceiptを照会する。
[SQLiteの検査](../src/expense-replay.test.ts)では、commit後の応答喪失とその後の照会失敗を注入し、
2回目の呼出しは既存receiptを返す。業務更新・履歴・receiptは各1件。
同じ検査に権限不足・version競合・idempotency競合を再試行しない例もある。
外部配送・外部API・別DBまで含むexactly-onceを保証するものではない。

receiptの期限・削除・定義versionの変更と移行方針は引き続きhostの責任。
削除後も同じIDで安全に再実行できると無条件に仮定しない。
未解決の要求を再試行できる期間中は、それを判定するreceiptやtombstone等を保持する必要がある。
この保持・削除の運用機構自体は未提供。

## 観察と検査

retryEffectは普通の関数で、Process等のtraceでは外側の段階を報告する。
各試行・待機の独立したlive spanやrunDetailedはまだ提供しない。
要求・結果の自動ログや永続schedulerも追加しない。
[検査](../src/retry.test.ts)は試行上限、所有権、中断、実行中の成功保持、例外、並行要求、型の維持を対象とする。
実tarballのconsumer・Node型を要求しない宣言・Node globalなしのbundleでも検査する。
