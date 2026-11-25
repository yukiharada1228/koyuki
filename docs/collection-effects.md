# 複数のI/Oの結果と失敗を集約する

開発版の`collectEffects(perform, { concurrency })`は、非同期Result関数を配列へ適用する実行境界。
2本目の講演29分台にある、店舗ごとのタスク送信結果をまとめる例に対応する。
同期の業務RuleへI/Oを混ぜるAPIではない。

```ts
const sendStores = collectEffects(sendStore, { concurrency: 4 });
const delivery = process<readonly StoreTask[]>()
  .effect('send-stores', sendStores);
const result = await delivery.run(tasks);
```

sendStoreは`(task, index) => Promise<Result<Sent, SendError>>`。
concurrencyは1以上の安全な整数を必須とし、定義時に検査する。1なら逐次実行。
宣言時に送信せず、呼び出すたびにその配列のI/Oを実行する。

## 結果・失敗・欠陥

- 同時実行数を指定値以下に保ち、入力位置順に開始する。完了順は保証しない。
- Resultの失敗があっても残りを実行し、全失敗を`{ index, error }`の配列へ入力順で集約する。
- 全成功なら入力順のreadonly成功値配列。空入力ならI/Oなしでok([])。
- performのthrow/rejectionは業務失敗に変換しない。新規開始を止め、開始済みI/Oがすべてsettleした後に最初に観測した例外を再throwする。
- 成功済みI/Oは取り消さず、失敗した要素も自動再送しない。

失敗時に成功値の一覧は返さない。送信済みの確認、再実行の重複排除、receiptやoutboxによる保存はadapterの責務。
この合成は一つのDB transactionや永続workflowにはならない。
店舗IDをエラーへ含めたい場合は、performが返すSendErrorにその業務情報を表す。
indexは元の入力位置を示す補助情報で、永続的な業務IDではない。

呼び出し時に配列の位置を浅くsnapshotし、成功配列・失敗配列と失敗wrapperをfreezeする。
要素・成功値・エラー本体はclone/freezeしない。実行中の参照の所有権は呼び出し側が扱う。
開始済みI/Oが終了しなければ全体も終了しないため、timeout/cancellationはadapter側で設計する。

講演のコードでは複数の非同期結果を配列へためてcombineする。
Koyukiでは並列数を明示する方式を選んだ。無制限な一括開始まで同じ挙動とは主張しない。
通常の手続き的コードをfromPromise / fromThrowableで包む選択肢も維持する。

[実行・型の回帰テスト](../src/collection-effects.test.ts)で、並列上限、完了順と結果順の違い、
失敗集約、開始済み処理の待機、後続Processの停止、複数呼び出し、所有権を検証する。
