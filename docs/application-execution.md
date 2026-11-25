# Applicationから業務段階までを同じ実行として観察する

開発版のApplicationは、dispatchした業務操作にexecutionIdを割り当て、
待機・開始・既存の段階trace・Application完了を一つの観察経路へ公開する。
公開alpha.5には含まれない。

```ts
const session = await application.start({
  sessionId: crypto.randomUUID(),
  observeExecution: event => logger.write(event),
});
const stop = session.subscribeExecution(event => console.log(event));
await session.dispatch({ type: 'submit', input });
stop();
```

application、logger、inputはhost側の定義。
実際のコンパイル・実行例は[Application観察の検査](../src/application-execution.test.ts)にある。
業務関数、Resultの接続、reducerへログを追加する必要はない。
購読は診断イベントだけを受け取り、初回のモデルsnapshotは通知しない。
既存のsnapshot/subscribe/traceの契約は変えない。

## イベント

全イベントにexecutionId、Application上のoperation名、elapsedMsがある。

| kind | 意味 |
| --- | --- |
| queued | 入力を所有し、既知の業務操作を待機列へ渡した |
| started | 実行対象のcommandを開始した |
| step | 詳細reportが返した段階名とok/error/skipped。scopeはoperationまたはreplay |
| span-started | 対応するcoreの段階を実際に開始した。spanId・parentSpanIdを持つ |
| span-completed | 段階の終了。ok/error/defectとdurationMsを持つ |
| completed | Applicationの処理結果。ok/error/defect/rejectedと、得られた場合のrevision |

completedのokは業務成功と投影成功、errorは想定内の業務失敗、defectは実行例外・投影失敗等。
rejectedはstale revisionや現在のApplication状態で受理できない操作で、commandを開始しない。
従来のdispatchのResult.okはイベント処理の受理を示すため、業務結果とは区別する。

内部完了による投影が終わった後にcompletedを出す。これにより、commandの保存成功と
Applicationの投影失敗を、step:okとcompleted:defectとして区別できる。
ただし、内部の全Programイベントへspanを付けるAPIではない。

入力のsnapshotで拒否された要求、未知の操作、偽造した内部イベントは観察対象に含めない。
それらを記録するために未検証の入力のtypeやpayloadを読み取らない。
dismissは業務commandではないため、この観察イベントには含めない。

## 一度の実行からtraceを受け取る

operation/operations/replayOperation/replayOperationsは、commandのrunDetailedがある場合に保持する。
観察対象の要求ではrunDetailedを一度呼び、**runを追加で呼ばない**。
観察対象でない要求では元のrunを使う。詳細機能がないcommandでは開始と完了だけを記録する。
観察対象として待機列へ入れた要求は、途中で購読解除しても選択した詳細経路を完了する。

coreの詳細commandからはload・validate・require・evolve・saveが既存traceとして届く。
詳細loaderの内部IOと、選択された分岐の段階もそのtraceに含まれる。
replayではsnapshot/lookup/command/resolutionを分け、実行したattemptの段階だけをcommand前に並べる。
receipt取得だけで完了した再送に、loadや業務ルールを実行したという記録を足さない。

カスタムcommandのrunDetailedは、runと同じ業務結果・IO回数を持つというhost契約が必要。
型検査は入出力・エラーの互換性を検査するが、実装の意味や副作用の等価性までは証明しない。
詳細traceのgetter等がthrowしても、得られた業務Resultは置き換えない。
一方、詳細commandそのものがthrowした場合はApplicationの通常のcrashed経路へ進む。
途中でthrowしてreportが返らなければ、それ以前の全段階を復元して観察できるとは保証しない。

## 時間とIDの保証範囲

**stepはrunDetailed終了後の報告**で、timingはreported-after-run。
elapsedMsはdispatchが待機列へ入った時点から通知時点までの時間であり、段階ごとの所要時間ではない。
対応するcoreは、処理中にspan-started/span-completedを通知する。
取得・検証・遷移・保存、Processの詳細loaderとcommit、選択枝、replay、Applicationの投影が対象。
spanIdとparentSpanIdで親子関係を表し、完了時にok/error/defectとdurationMsを通知する。
durationMsは観察callbackも含む経過時間で、CPU時間ではない。
普通の関数の内部IOやPromise.allは自動分解せず、任意の非同期context伝播は提供しない。
静的なdescribeFlowのnode IDとの自動対応もない。
そのため、stepに並ぶelapsedMsの差をそのステップのIO時間として使わない。

時計は既定でWeb標準のperformance.now（利用できなければDate.now）。
clockオプションで差し替えられ、例外・非有限値・逆行は診断側で吸収する。
これは分散時計の同期や処理時間の厳密な計測を保証しない。

executionIdはsessionIdとsession内の観察対象要求の連番を組み合わせる。
既定のsessionIdは同じmodule instance内の連番。再起動・worker・複数のmoduleコピーをまたぐ相関には、
hostが一意のsessionIdを渡す。診断IDを永続receiptのキーや認証能力として扱わない。
並行sessionの観察状態は共有しない。

## 機密情報と購読の障害

記録するのはID、操作・段階の名前、status、時間、revisionだけ。
入力・出力・エラー内容・plan・認証情報・captureした値をイベントへ含めない。
ただし、hostが操作名・段階名・sessionIdへ機密情報を埋め込むことまでは防がない。

イベントはprimitiveだけのfreeze済みオブジェクト。
観察側がthrowしても処理を中断せず、返したPromiseの拒否も処理する。
購読解除後は後続イベントを通知しない。新規購読者への過去イベントの再配信はない。
通知先を保存せずに使えば、観察履歴をruntimeに蓄積しない。

同期listener自体の長い計算や、listenerが明示的に行う業務操作・外部IOまで無害にはできない。
loggerのbuffer・配送・保存・保持期間はhostの責任。
これは[状態と原子保存する成功監査](audit.md)とは別の、失敗を業務処理に伝播させない診断経路。

## 型と比較範囲

詳細機能の入力をrunより狭くしたり、異なる成功型・エラー型を返したりする登録は拒否する。
操作テーブルや直接のApplication宣言にも同じ検査をかける。
動的に選ぶcommandの入力は、[全候補が受け取れる契約](application-input-contract.md)として検査する。
高度なgeneric wrapperを書く場合は、OperationCommands<T>でテーブルの検査条件を次の呼出しへ引き継げる。
通常のオブジェクト宣言ではこの補助型を記述する必要はない。

調達の独立baseline Applicationは、従来のsnapshot/subscribe/trace/dispatchの比較範囲を維持する。
新しいsubscribeExecutionと等価な仕組みを実装したとは扱わず、比較用の戻り値型から明示的に除外する。
したがって、この機能を含む全実装負担の優位性を既存の比較結果から主張しない。

## 検査と残る要件

core、実tarballのconsumer、Node globalなしのbundleで検査する。
詳細loaderのIO・Rule・保存、失敗、選択枝、再送、stale revision、並行session、
receiver、購読解除、観察側のthrow/reject、時計障害、誤った配布型の拒否を対象にする。

[Issue #2](https://github.com/yukiharada1228/koyuki/issues/2)の相関観察の部分実装。
対応するcoreのlive timing・親子spanは実装した。裸のProgram全体への共通API、永続的なtrace保存、
HTTPや別サービスまでの分散相関はまだ提供していない。完全な実行trace基盤の完成とはしない。

対応するcoreのlive spanは、reportが返らない例外でも開始済みの段階をdefectとして閉じる。
カスタムcommandの内部段階は自動計測しない。既存のstepは従来どおり事後の報告。
実行観察と選択値captureは別の経路で、入力・出力の自動収集やcapture対象の拡張は行わない。
直接のWorkflow.inspect(capture)でcallbackがthrowする場合の従来契約も維持する。
処理中の通知・親子関係・例外・二重実行防止は[live spanの検査](../src/live-execution.test.ts)で確認する。
