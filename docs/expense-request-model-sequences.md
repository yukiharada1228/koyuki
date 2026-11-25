# 経費の要求ID付き再送を独立仕様から生成する

[要求モデル](../src/expenses/request-model-testing.ts)は、既存のexpenseReplayCommandsと
ReplaySqliteExpensesを対象に、通常の業務操作と要求ID付き再送の列を生成する。
期待する業務結果は既存の独立した経費参照仕様から計算し、成功receiptの規則も別に記述する。
実装のfingerprint・receipt照会・返却結果から期待値は作らない。

| 条件 | 期待する出力と現在状態 |
| --- | --- |
| 新しいIDの業務操作が成功 | committed、新しい状態を保存 |
| 成功済みの同じ要求 | replayed、過去の成功値を返す。現在状態は変えない |
| 後続操作が成功した後に古い要求を再送 | 過去の成功値を返すが、DBをその過去の状態へ戻さない |
| 同じIDで操作・対象・版数・操作者ID/役割/有効性を変更 | IdempotencyConflict、状態は変えない |
| 同じIDで理由・編集金額・領収書を変更 | 該当する操作ではIdempotencyConflict、状態は変えない |
| 成功receiptのない要求の版数が古い | 正の版数ならSaveConflict。0ならInvalidRequest |
| 業務の権限・状態・入力条件を満たさない | 独立した業務仕様に従い拒否。成功receiptは追加しない |

モデルのrequestは操作に必要な入力だけを含む。この範囲では要求を構造で比較し、
hashの実装や無関係な追加プロパティに依存しない。
操作者はhost引数として渡し、payloadから役割を採用する経路は追加しない。
定義versionは既定のexpenses.v1で固定する。

## 実行と再現

比較のたびに新しい:memory: SQLiteを作り、操作履歴から現在状態とreceiptを再構築する。
削除した反例候補でも同じ手順を使い、finallyで閉じる。
失敗時の縮小では、存在しなくなったreceiptや操作に適用できない変更の参照をacceptsで除く。
業務の権限拒否や不正な編集を適用範囲外にはしない。

[到達確認](../src/expense-request-model.test.ts)は、3 seed・各4試行・32操作、
合計384辺で同一要求、要求の変更、古い成功の再送などが含まれることをassertする。
別の生成列は、申請→差戻し→編集→再申請→上長承認→経理承認の後に、
各receiptの同一再送と適用可能な全入力変更を試す51辺である。
各比較は出力とSQLiteの全経費行を別々に照合する。過去の出力と現在のDBを同じ状態だと仮定しない。
これらの辺数は比較した操作数であり、履歴再構築も含めたSQL実行数やコミット数ではない。

replayedをcommittedとして扱う故意のhost不具合を挟むと、申請→同一要求の再送の
2操作を反例として得る。1操作削除に対する最小性と予算打切りを区別し、全候補での最短列とはしない。
同じ契約から雛形生成した3テストを、実tarballのconsumerでも型検査・実行する。

```sh
node --import tsx --test src/expense-request-model.test.ts
npm run build
npm run --silent generate:model-test -- --contract ./src/expenses/request-model-testing.js > generated-expense-request-model.test.ts
node --import tsx --test generated-expense-request-model.test.ts
```

逐次実行・単一経費・有限の生成候補が対象で、応答喪失・並行競合・定義version変更・
保持期限・監査行数・Application表示をこの生成器で網羅したとはしない。
それらの既存の個別検査は維持する。sampledは生成した範囲での一致であり、任意の再送の証明ではない。
