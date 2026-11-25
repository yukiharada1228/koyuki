# 同期保存アダプターの共通transaction境界

`createSyncTransaction`は、同じ接続のbegin/commit/rollbackを接続する。
業務関数やイベント定義にtransactionの手順を書かず、saveアダプターの内部で利用する。
Web標準のJavaScriptだけを使い、DB driverを内蔵しない。

```ts
import { createSyncTransaction, type Result } from 'koyuki';

// dbはホスト側で所有する同期接続。接続ごとに境界を一つ作る。
const transaction = createSyncTransaction({
  begin: () => { db.exec('BEGIN IMMEDIATE'); },
  commit: () => { db.exec('COMMIT'); },
  rollback: () => { db.exec('ROLLBACK'); },
});

function save(change: Change): Result<State, SaveError> {
  return transaction.run(() => {
    const saved = updateState(change);
    if (!saved.ok) return saved;
    return writeHistory(saved.value);
  });
}
```

この断片のdb/Change/State/SaveError/updateState/writeHistoryはホスト側の定義。
実例は[タグ](../src/tags/sqlite.ts)、[経費](../src/expenses/sqlite.ts)、
[経費receipt](../src/expenses/sqlite-replay.ts)。既存の業務関数・イベント宣言は変更していない。
`business`等のsaveへそのアダプターを渡せる。新しいTarget専用設定は不要。

## 確定と失敗

- Result成功ならcommitし、元のResultを返す。失敗ならrollbackし、同じ失敗を返す。成功・失敗のunionを保持する。
- workの例外はrollback後、`TransactionFailure`としてthrowする。phaseはwork、outcomeはrolled-back、causeは元の例外。業務エラーへ変換するかはhostの責任。
- begin失敗はphase:begin / outcome:not-started。未取得のtransactionをrollbackしない。**beginがthrowした場合、所有したtransactionを残さないことはdriverの契約**。
- commit失敗ではrollbackを試みるが、outcomeはunknown。応答喪失等で実際には確定済みの可能性を否定しない。この境界を以後使用不可にする。receipt照会や接続の再作成はhost側で判断する。
- rollback失敗もoutcome:unknownとして以後使用不可。例外causeはrollback失敗そのもの。
- 接続を再作成せず、使用不可となった境界だけを作り直して使い続けない。

既存のタグ・経費adapterは例外を従来のRepositoryUnavailableへ変換する。
そのエラーは「確実に未保存」を意味しない。公開エラー型の互換性を維持しているため、
保存結果不明の詳細が必要なhostは境界のTransactionFailureを直接扱う契約を別途用意する。

## 接続の所有と観察

work・driver hookは同期callback専用。Promiseを返すworkやdriver hookは型検査で拒否する。
既存の名前付きdriver methodを渡す場合、hookの戻り値型を`undefined`と明記する。
`void`ではTypeScriptがasync関数も代入可能にするため、意図的に受け付けない。
型を偽装して非同期処理を開始した場合、その後の処理を停止・rollbackできるとは保証しない。

同じ境界へのネスト・transaction実行中の観察callbackからの再入はbusyで拒否する。savepointは提供しない。
driverは接続を専有させ、別の境界や生SQLのBEGINで迂回しないこと。
この規則は同じインスタンス内の保護であり、DBをまたぐロックではない。
別接続・別プロセスの競合はDBのロックと既存CAS検査で解決する。

第2引数のobserveは、値を含まないstarted/committed/rolled-back/failedイベントを受け取る。
観察側のthrowと、返されたPromiseのrejectは診断の失敗として処理し、IOの回数やResultを変えない。
rolled-backはrollback呼出しが正常に完了した記録であり、commit失敗後の確定有無の証明ではない。
認証情報、入力、成功値、例外causeは観察イベントへ含めない。
通知は同期に開始し、返されたPromiseの完了は待たない。transactionの同期性は変わらない。
callbackの非同期部分をtransaction内へ延長したり、そこで行うIOをrollbackの範囲へ加えたりはしない。
永続監査や非同期subscriberの寿命管理は別のhost契約となる。

以前はasyncな観察callbackのrejectが未処理となる場合があった。
[SQLiteを使う回帰検査](../src/transaction.test.ts)では、開始・commit・rollbackの通知をrejectさせても、
元の成功/失敗Resultのidentityと、commit済みの1行・rollbackした未保存行の状態を保つことを確認する。
同期例外や再入busyの既存契約も維持する。

アダプター固有の開始設定はrunの第2引数で渡せる。タグではDEFERRED/IMMEDIATEを使う。
この値はdriverへ渡すだけで、coreがSQLや分離レベルを解釈しない。

## 検証と残る範囲

[transactionの検査](../src/transaction.test.ts)はResult・例外・開始失敗・commit失敗・rollback失敗・
再入・受信メソッド・型の拒否を検査する。実SQLiteの遅延外部キー制約でcommitが失敗したときも、
状態が残らないことをそのdriverで直接確認する。配布tarballのconsumerにも同じ検査を移して実行する。

既存のタグreceipt書込み失敗、経費履歴書込み失敗、経費receipt書込み失敗、
別接続・別プロセス競合の検査も共通境界へ接続した状態で継続する。
ブラウザー向けbundleではNode globalなしのfake driverで実行し、実行時依存と公開宣言を別途検査する。

[Issue #1](https://github.com/yukiharada1228/koyuki/issues/1)の同期adapter向け部分を実装した段階。
callback型の非同期DB向け共通境界は下記に追加した。Target全体の開始・確定・失敗の相関観察、
保持・削除、限定retry、自動的な分散transactionは実装していない。
これらの完成や、あらゆるDBの原子性を主張しない。

## callback型の非同期transaction

開発版の`inTransaction`は、begin/commit/rollbackをホストが管理するdriverへ接続する。
同期境界のhookをPromise化するAPIではない。Prismaのように、transaction callbackへ専用接続を渡すdriverを対象にする。

```ts
import { inTransaction } from 'koyuki';

return inTransaction(
  { transaction: callback => client.$transaction(callback) },
  tx => stockMovement(tx).run(input),
);
```

`client`と`stockMovement`はhost側の定義。[Prisma実例](../examples/prisma-stock/transaction.ts)では、
clientの作成・切断と既知のPrisma例外の業務向け変換をhostに残す。
業務関数、状態、イベント定義は変更しない。

`TransactionHost<C>.transaction`の契約は次のとおり。

- callbackは一つのtransaction内で一度実行し、成功値はcommit完了後に返す。
- callbackがthrow/rejectした場合はrollbackする。rollback完了後に**同じ例外を再throw**する。
- rollbackやcommit自身が失敗した場合は、その障害をrejectする。callbackの例外を返してrollback成功を偽らない。
- driverがcallback例外をwrapする場合は、host adapter側でrollback成功を確かめられる範囲でこの契約に合わせる。coreは任意のcauseチェーンを検索して中止を復元しない。
- callback内のIOは渡された接続へ束縛する。別接続・HTTP等の副作用はこのtransactionの原子性に含まれない。

coreはResult失敗を各呼出し専用の中止マーカーでthrowし、hostが同じマーカーを返した場合だけ、
元のResultを返す。別呼出しのマーカーや、rollback障害へ置き換わった例外は業務エラーとして飲み込まない。
予期しないwork例外やdriver障害は元のidentityのままrejectする。同期版のTransactionFailureへは変換しない。
commit失敗・切断失敗を「未保存」とは扱わず、自動retryもしない。

実行間で共有する中止状態はない。別接続を使う並行実行の管理、ネスト、接続の排他、
timeoutはhost driverの責任。同期境界のbusy保護とは契約が異なる。
coreからdriverのrollback完了を外部検証することはできないため、adapterの契約テストが必要。

[core検査](../src/async-transaction.test.ts)は中止・障害・並行実行の分離・型を検査する。
Prismaの実driverでは途中のCAS失敗、履歴書込み失敗、callback例外、遅延制約によるcommit失敗等を検査する。
[共通の成功監査](audit.md)はSQLiteサンプルへ接続した。全実行の相関・監査保持の運用・retry方針は依然として未提供。

### callback契約の違反検出

coreはcallbackを同じ呼出しで二度実行しない。driverによるcallbackの自動再試行も二度目の業務処理の前に拒否する。
hostはcallbackの実行を一度完了し、返された成功Resultを同じidentityで返す必要がある。
callbackを実行せず成功する、完了前に返る、失敗を握りつぶす、成功値を差し替える、複数回呼ぶ場合は
`TransactionHostFailure`でrejectする。outcomeはunknownで、reasonが違反の種類を示す。
既に記録した違反はhostがその例外を握りつぶしても取り消さない。

transaction終了後に保持したcallbackを呼ぶことも拒否し、新しい業務処理は開始しない。
ただし、hostがworkの完了前に戻った場合など、既に開始したIOをこの検査でキャンセルすることはできない。
後からcallbackが呼ばれて検出した違反で、既に返したPromiseの結果を変更することもできない。
検出はdriverのrollback・commitの実施や接続の隔離を証明しない。利用するhostの契約テストは引き続き必要。
Prisma実例には自動的なcallback再試行を追加していない。
