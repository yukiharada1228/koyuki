# 3方式の基本traceと保存計画を比較する

購買の通常TypeScript版・helper版へ、基本traceと保存計画の記録を追加した。
KoyukiのActionReportと同じ形式で比較するが、基準実装はbusiness/Workflow/actionを実行しない。
これは[業務接続比較](procurement-comparison.md)の次の段階であり、全実行機能の比較完了ではない。

## 基準実装が追加したもの

plain/helperの各実行経路は、load・業務関数・saveが返したResultの成功／失敗をStageSinkへ通知する。
plainでは25操作それぞれ、helperでは共通action関数へ記述する。
`baseline-detail.ts`は呼出しごとに別の記録先とfactoryを作り、選択した一つの操作を実行する。
各呼出しが自分のtraceとplanを所有し、共有の「現在の操作」変数を使わない。

保存へ到達したときは、Repositoryに渡すChangeをcloneしてwrite planへ記録する。
loadや業務関数の失敗時はplanを作らない。save失敗時は試行したplanを残す。
step名は操作ID付きload、run:1、操作ID付きsave、statusはok/errorとする。
これにより、結果の一致に加え、どこで止まり保存を試みたかを比較できる。

通常のplain/helperの業務定義と記録付き呼出しは同じ処理を使う。
記録の共有helperを作ることを基準実装にも認め、記録コードを25回コピーするよう強制しない。
記録付きwrapperと段階通知は基準実装側の追加基盤であり、今後のコード量評価では除外しない。
Koyuki側では既存のrunDetailedを使い、この比較のための新しいruntime APIは追加していない。

## 確認したケース

| ケース | 比較する内容 |
| --- | --- |
| 申請作成成功 | 全3段階ok、結果と全保存計画が一致 |
| 取得対象なし | load:errorだけ、plan:null |
| 不正な明細で編集 | load:ok → run:1:error、plan:null、保存なし |
| 同じ申請の重複作成 | load:ok → run:1:ok → save:error、Conflictと試行planが一致 |
| load/saveの想定外例外 | Promiseがrejectし、正常な完了reportを捏造しない |
| 2つの同時呼出し | 呼出しごとの結果・trace・planがKoyukiと一致し、相互に上書きしない |

`src/procurement-trace-comparison.test.ts`で、Koyuki/plain/helperそれぞれを検査する。
基本4ケースはreport全体を比較し、期待する停止段階・planの有無も直接検査する。
型検査では入力必須項目とhelperの承認成功型Approvedが記録付きでも維持されることを確認する。
既存25操作のMemory/SQLite結果比較も継続し、実tarballの独立consumerでも実行する。

## 同等になっていない部分

ここで扱うのは、一つの業務関数を持つ現在の25操作における基本stage traceと保存planである。
全25操作の全失敗経路・複数rule列・分岐・途中I/Oをこのテストだけで網羅したとは扱わない。
値のcapture・機密項目の選択・観測失敗の分離・永続監査・保持期間はまだ3方式でそろえていない。
StageSinkは比較wrapperの内部記録に使い、任意の外部observer例外を隔離する契約を検証したものではない。

再送・不明commit照会・Applicationの同条件比較も未実施。
基準実装の追加基盤は再利用可能だが、保守コスト・導入負担・認知負担の増減はまだ測定していない。
テスト時間を性能benchmarkや生産性の指標へ変換しない。
