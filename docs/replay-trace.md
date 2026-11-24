# 再送を含む実行記録（alpha.3）

`withReplay(...).runDetailed(input)`は、再送境界と実際の業務実行を区別して返す。
この追加APIはnpmの `koyuki@0.1.0-alpha.3` に含まれる。

```ts
const report = await commands.submit.runDetailed(input);
report.result;  // 最終的なResult<Execution<Output>, ...>
report.trace;   // 再送境界が実際に通った処理
report.attempt; // 業務コマンドの実行記録。実行しなければnull
```

経費の実コードは[src/expenses/replay.ts](../src/expenses/replay.ts)。
現在はdefineUseCaseの試作入口から接続し、元TargetのrunDetailedを再送境界まで維持している。

## レポートの構造

`ReplayReport<O, E, RE>`のOは業務出力、Eはコマンドの失敗、REは成功記録照会の失敗。

| フィールド | 内容 |
| --- | --- |
| result | 最終結果。新規保存・再送・業務失敗・照会失敗・入力clone失敗を区別する |
| trace | 下表のReplayTraceの配列。実行順に記録する |
| attempt | コマンドを呼ばなければnull。呼んだ場合は元のresult・trace・plan |

| kind | 追加情報 | status |
| --- | --- | --- |
| snapshot | なし | ok / error |
| lookup | phase: before / after-error | found / missing / error |
| command | なし | committed / replayed / error |
| resolution | なし | lookup / skip |

`command.status === 'replayed'`は、最初の照会では記録がなく、保存処理の中で既存の成功記録が返った場合。
この場合はコマンド自体は呼ばれている。最初の照会で返した再送とは区別できる。
`resolution`はコマンド失敗後にresolveAfterを評価した場合だけ追加する。成功後に照会することはない。

## 保存済みの結果だけを返した場合

```json
{
  "trace": [
    { "kind": "snapshot", "status": "ok" },
    { "kind": "lookup", "phase": "before", "status": "found" }
  ],
  "attempt": null
}
```

load・検証・require・遷移・saveは呼ばない。そのため、それらのtraceやplanを作らない。

## 新規実行の場合

境界のtraceはsnapshot→lookup(missing)→command(committed)。
元コマンドのrunDetailedがあれば、attempt.traceは実際のload・検証・require・遷移・saveの記録になる。
業務検証が失敗した場合は、その地点までのtraceと、resolution(skipまたはlookup)を返す。
例えば休暇の残日数不足では、attempt.traceにload・authorize-submit・require-daysだけが含まれる。

## 保存結果が不明だった場合

保存側がRepositoryUnavailableなどを返し、resolveAfterが再照会を許可したとき：

```json
[
  { "kind": "snapshot", "status": "ok" },
  { "kind": "lookup", "phase": "before", "status": "missing" },
  { "kind": "command", "status": "error" },
  { "kind": "resolution", "status": "lookup" },
  { "kind": "lookup", "phase": "after-error", "status": "found" }
]
```

最終resultはreplayed。attempt.resultは元の失敗を保持する。
保存の応答を得られなかった事実と、成功記録を確認できた事実を混同しない。
再照会がmissingなら元の失敗、照会自体が失敗したらその照会エラーを最終結果にする。
元のコマンドは再実行しない。

## 互換性と制限

- 既存runは元コマンドのrunを一度呼ぶ。runDetailedを新たに使う経路へ切り替えない。
- runDetailedは元コマンドのrunDetailedを一度呼ぶ。runとの両方は呼ばない。
- runしか持たないコマンドも使える。その場合、attemptは存在するがattempt.traceはnull、planもnull。
  「コマンド未実行」のattempt:nullと「実行したが内部は未観測」のtrace:nullを区別する。
- 詳細版と通常版で同じ業務の意味を持たせるのは元コマンドの契約。KoyukiのTargetは同じ判断・保存を使う。
- 想定外の例外は従来どおりrejectする。部分的なレポートへ変換しない。
- 認証、再送前のアクセス制御、原子的な保存、fingerprint、Viewの再取得方針は従来どおり利用側の責任。
- 時刻・期間計測・永続監査ログ・Application購読へのtrace通知は追加していない。
- レポートには業務出力・エラー・planが含まれる。自動的には送信・保存しない。ログへ出す場合は公開範囲を決める。

## 検証

```sh
npm ci
npm run check
npm test
npm run test:leave:development
```

本体331テストには共通境界の詳細記録6テストと経費への適用2テストを追加。
休暇は公開alpha.2の既存サンプルを変更せず、packした開発版を作業ツリー外にインストールして、
既存14テスト＋詳細記録2テスト・型チェック・デモを確認する。
`npm run test:leave:package`は引き続き公開alpha.2の検証。
