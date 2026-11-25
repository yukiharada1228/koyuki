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

同期callback専用。Promiseを返すworkやdriver hookは型検査で拒否する。
既存の名前付きdriver methodを渡す場合、hookの戻り値型を`undefined`と明記する。
`void`ではTypeScriptがasync関数も代入可能にするため、意図的に受け付けない。
型を偽装して非同期処理を開始した場合、その後の処理を停止・rollbackできるとは保証しない。

同じ境界へのネスト・観察callbackからの再入はbusyで拒否する。savepointは提供しない。
driverは接続を専有させ、別の境界や生SQLのBEGINで迂回しないこと。
この規則は同じインスタンス内の保護であり、DBをまたぐロックではない。
別接続・別プロセスの競合はDBのロックと既存CAS検査で解決する。

第2引数のobserveは、値を含まないstarted/committed/rolled-back/failedイベントを受け取る。
観察側のthrowは無視し、IOの回数やResultを変えない。
rolled-backはrollback呼出しが正常に完了した記録であり、commit失敗後の確定有無の証明ではない。
認証情報、入力、成功値、例外causeは観察イベントへ含めない。
observeは同期通知であり、永続監査や非同期subscriber管理ではない。

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
非同期DB向けの共通境界、Target全体の開始・確定・失敗の相関観察、共通監査形式、
保持・削除、限定retry、自動的な分散transactionは実装していない。
これらの完成や、あらゆるDBの原子性を主張しない。
