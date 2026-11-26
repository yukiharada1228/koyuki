# 購買のI/O例外をApplicationまで検査する

[追加検査](../src/procurement-application-io-exceptions.test.ts)では、購買25操作を32回実行する既存シナリオに、
Applicationを介する例外処理の検査を加えた。coreの実装・公開APIは変更していない。
[直接commandの検査](procurement-io-exceptions.md)で扱ったI/O位置を、同じ固定の期待回数と照合する。

## 検査する契約

read・related・commitの実adapterを呼ぶ直前に、同期throwとPromiseのrejectを注入する。
一シナリオあたり72種類の位置で178回の例外を試す。
メモリ/SQLiteそれぞれで実行観測あり・なしを検査する4ケースであり、712種類の業務仕様という意味ではない。

- dispatchは受理され、状態がrunningからcrashedへ移る。例外を業務Resultのfailedへ置き換えない。
- 以前のApplicationデータを保ち、成功時の投影を呼ばない。今回のviewはbusyを解除し、UnexpectedExceptionの種類を示す。
- 例外位置より後のI/Oを呼ばず、このfixtureでは全6モデルを変更しない。
- crashed中の再dispatchを拒否する。dismissもI/Oや再実行を行わず、以前のデータを持つreadyへ戻る。
- その後の明示的な正常dispatchだけが一回保存し、一回投影する。全結果・最終モデルが、例外を挟まないシナリオと一致する。
- 実行観測ありでは、同じ実行IDのspanが全て閉じ、例外になったload/saveはdefectになる。
  commit前の例外では、既に通過した業務段階はokのままである。completedもdefectとなる。
- 返されなかったActionReportのstep通知を作らない。実行メタデータには例外messageを含めない。

最後の秘匿範囲は実行メタデータだけである。既定のcrashed.state.error.messageには例外messageが入ることも明示的に検査する。
今回のviewは種類だけを公開するが、全アプリケーションのviewが機微情報を隠す保証ではない。
直接commandへ同じ例外を伝播する契約と、ApplicationがcrashedのDTOへ変換する契約を区別する。

## 実装と検証の範囲

異なる入力型の操作を固定シナリオから選ぶ検査境界だけで型を消去する。
実businessの宣言は通常の型検査を受ける。各正常呼出しを囲む検査sessionには、選んだcommandをexecuteとして登録し、
以前のデータと成功回数・結果を持つ小さな投影を使う。
25種類を一つの本番UIへ統合した試験や、実モデルの全view・投影の試験ではない。
通常TS/helperとのApplication全経路の新しい三方式比較でもない。

```sh
node --import tsx --test src/procurement-application-io-exceptions.test.ts
npm run test:business:package
```

rootの検査と、実際にpackした開発版をinstallしたconsumerの検査へ同じ4ケースを含める。
失敗したdispatch・dismiss・正常dispatchのI/O回数も明示的に検査するため、状態だけを表示して裏で再実行する実装は受理しない。

commitの例外は実adapterを呼ぶ前に注入するため未保存と期待できる。
DB内部のcommit途中・保存後の応答喪失・結果不明のcommitへ、この非保存の結論を広げない。
永続再送・並行実行・Rule本体の例外・任意のview/投影の例外を全て網羅したわけではない。
独立利用者の開発体験や、原音の再確認、講演全体の完全実現を証明する検査でもない。
