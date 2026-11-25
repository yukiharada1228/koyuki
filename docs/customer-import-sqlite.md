# 顧客照合後の直和分岐をSQLiteで検証する

[顧客取込の業務関数](../src/examples/customer-import/domain.ts)と
[既存Process/Workflowの接続](../src/examples/customer-import/application.ts)を、
[SQLiteのhost adapter](../src/examples/customer-import/sqlite.ts)へ接続する。
SQLiteの依存はサンプルadapterに置く。実配布consumerではkoyukiのルートimportを使用する。

識別規則は、信頼できるgroup内の小文字化済みemailの完全一致。
実製品のあいまいな名寄せ・予約取込仕様を再現したものではない。

| 入力・判定 | 保存時に守る条件 | 競合時 |
| --- | --- | --- |
| 未特定→作成 | group + emailの一意制約、IDの主キー、version 1 | Conflict |
| 特定済み→更新 | ID・group・email・期待versionの一致、次versionへ1増加 | Conflict |
| 特定済み→変更なし | 保存済みの名前・email・versionが判定時の値と一致 | 不一致ならConflict |

変更なしでも再読込みで整合性を点検する。別の書込みの前に得た古い値を、現在の成功結果として返さない。
更新・作成はそれぞれ一つのSQL文で完結する。複数集約全体のtransactionではない。

## 検査

[src/customer-import-sqlite.test.ts](../src/customer-import-sqlite.test.ts)で以下を検査する。

- 閉じたDBを再接続し、さらに別OSプロセスで読み直しても同じ顧客を復元できる。
- 2接続が同じ未特定の状態を読んでから作成すると、片方だけが成功する。
- 2接続が同じversionを読んでから更新すると、CASで片方だけが成功する。
- 古い変更なし判定は、更新後の顧客を過去の値に戻したり古い成功として返したりしない。
- 同じemailでもgroupは分離し、trusted groupと異なる要求・保存を拒否する。
- 不正な保存値を拒否する。想定した一意制約以外のstorage例外は握り潰さない。

これは2接続の読込みと書込みを制御して競合を再現する検査。
同時負荷下のスループットやすべての並列実行順序を測定したものではない。
別OSプロセスの検査は保存後の読込みであり、複数writerの同時実行試験ではない。

```sh
npx tsx --test src/customer-import-sqlite.test.ts
npm run test:business:package
```

## 境界

trusted groupは認証済みのhost contextから渡す想定で、このサンプルに認証基盤は含めない。
Repositoryは保存値を復元時に検証する。ID採番にはWeb CryptoのrandomUUIDを使う。
再試行、receipt、監査履歴、複数操作の原子性は追加していない。
同じ要求を繰り返した際の変更なし判定は、receiptによる再送制御と異なり、照会と業務関数を再実行する。
SQLiteの一意制約失敗はConflictへ変換する。ロック・接続・schema等のその他の例外分類はhost側の追加課題。
他DB、migration運用、長時間の負荷、元製品の予約割当・取込全体は未検証。
