# Program単体の実行観察

開発版defineProgramのsessionは、Applicationと同じExecutionOptionsと
subscribeExecutionで待機・更新・副作用・完了を観察できる。
業務のupdateやeffectへログ処理を追加する必要はない。

```ts
const session = await program.start({
  sessionId: crypto.randomUUID(),
  observeExecution: event => logger.write(event),
});
const stop = session.subscribeExecution(event => console.log(event));
await session.dispatch(message);
stop();
```

program・logger・messageは利用側の定義。実行可能な例は[回帰検査](../src/program-execution.test.ts)。
これは追加の任意観測であり、従来のstart()・snapshot・subscribe・trace・dispatchも使える。

## 観測単位

- start時の初期化と初期commandは、operationが@initの一つの実行として通知する。
- dispatchしたイベントごとにexecutionIdを割り当て、待機中のqueuedと実行開始のstartedを分ける。
- program.dispatchを親として、program.update:イベント名、program.accept、各command名の開始・終了を通知する。
- program.acceptは状態のsnapshot受理。commandの成功後に受理が失敗しても、commandを再実行しない。
- completedのokは更新・後続command・最終snapshotの成功、errorは公開イベントのupdateが返したResult失敗、rejectedはstale revision、defectは例外等を示す。

commandの戻りイベントがupdateで拒否された場合は、従来どおりRejectedCommandMessageを
throwする。updateの段階はerror、実行全体はdefectと記録する。
失敗したdispatchの後も待機列を継続する。処理済みI/Oを取り消したという意味ではない。
初期化が失敗した場合はstartがrejectし、sessionは返らない。

stage名・status・時間だけを観測し、モデル・入力・commandの戻り値・例外本文は収集しない。
イベント名とcommand名自体は利用側の命名なので、機密値を名前へ埋め込まない。
入力snapshotに失敗したdispatchは、未検証のイベント名を読まず、観察対象にも含めない。
observerのthrow/rejection、clockのthrow・非有限値で業務結果を置き換えない。

## Applicationとの関係と限界

Applicationは独自の業務操作単位の実行観察を維持する。内部Programへこの設定を
自動転送しないため、同じ操作の開始・完了を重複通知しない。
Program単体のcommand.execute内部はopaqueであり、任意の関数内部を自動で分解しない。
永続履歴・分散相関・全値のdump・schedulerは提供しない。
observerが付いていない間は実行イベントを保存しない。後からの購読へ過去の履歴は再送しない。

回帰検査では、待機中のcommandのlive span、親子関係、実行回数、初期commandの欠陥、
Result失敗・stale・throwの区別、observer失敗と解除、待機列の実行ID分離を確認する。
同じ検査を実tarballの独立consumerでも実行する。
