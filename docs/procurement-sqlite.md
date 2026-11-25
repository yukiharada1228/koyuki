# 購買評価アプリのSQLite host

25操作の評価アプリへ`SqliteProcurement`を追加した。
コアの公開APIや依存は変更せず、Nodeの`node:sqlite`は評価用hostだけで使用する。
このadapterを任意のWeb runtimeで使えるとは扱わない。

## 保存と復元

`src/experiments/procurement/sqlite.ts`が`ProcurementRepository`を実装する。
constructorでtrusted groupを固定し、read/related/list/commitをそのgroupに制限する。
DBの主キーはgroup・kind・id。versionとpayloadの対応も検査する。
有効発注、有効請求、有効支払記録、支払参照番号の一意性をDB indexでも定義する。

JSONからEntityへ直接キャストせず、domainの`restoreEntity`で状態別の構造を検証する。
申請4状態、発注3状態、検収2状態、請求4状態、支払2状態、在庫1構造の16種類を対象とする。
必須属性・不要属性、正のversion、識別子、明細と合計、承認担当と承認者、数量、在庫と引当の関係などを確認する。
検証済み明細や申請のbrandはこの境界で再構築する。
保存値の検証は、その状態へ至った履歴の証明や、悪意あるDB書換えの検知ではない。
関連行が存在することや全モデル間の過去の整合性を、単一行の復元で完全検査しているわけではない。

不正JSON・不正状態・列とpayloadの不一致は`CorruptProcurementStorage`という例外で停止する。
NotFoundや業務ルール違反へ変換せず、呼出し側が欠陥・データ破損として扱う。
移行・隔離・修復の手段はまだ提供していない。形式versionの追加が必要な変更時には移行方針を別途設計する。

## 複合保存

書込み値を復元可能な形と確認してから`BEGIN IMMEDIATE`を開始する。
transaction内でChange.checksに宣言された主キーの行だけを読み、復元する。
その行をメモリadapterと共通の同期検査へ渡して期待version・書込みの対応を確認し、
読んでいない行との有効発注・請求・支払・参照番号の重複はDBの一意indexで拒否する。
発注・検収・請求・在庫などのwritesをすべて保存してCOMMITする。
途中の書込み失敗はROLLBACKする。既知の一意制約・busy競合はConflictとして返し、それ以外の例外は再throwする。
Resultの失敗伝播だけでrollbackしているのではなく、このDB transactionが原子性を提供する。

保存時のgroup全件読込みは廃止した。主キー照会は宣言されたcheckの件数以内で、同じ既存行は再利用する。
取得するEntity数はgroup全体の行数ではなく、その操作のcheckに依存する。B-tree探索やJSON復元の実行時間を一定と保証するものではない。
業務のloadはrelatedを使い、親IDに属する行だけを取得する。kind全件のlistは診断用に残すが、業務のRepository契約からは外した。
group全体の在庫集約も同じversionを共有する。高並列性能・負荷試験・通常TSとの比較は未実施であり、
一つの親に大量の履歴がある場合のページング、集約境界の見直しは評価に残る。
read/relatedの複数回呼出しはsnapshot transactionではない。保存時のversion検査が古い計画の確定を拒否する。

## 確認した範囲

`npx tsx --test src/procurement-sqlite.test.ts`で次を検証する。
同じテストを`npm run test:business:package`の実配布consumerでも実行する。

- 申請から承認・入荷・請求承認・支払記録まで保存し、DBを閉じて再度開く。
- 全6モデルを復元し、別OSプロセスから承認済み請求を読む。
- 最後の在庫UPDATEへDB triggerで失敗を注入し、発注・検収・請求が部分保存されないことを確認する。
- 別の2接続から同じ在庫versionを引き当て、一方だけ成功することと、引当後の返品拒否を確認する。
- 必須承認属性をDBから削除し、read/list/業務操作が破損を受け入れないことを確認する。
- 同じ業務IDを異なるgroupで保存し、trusted groupを越えた読取り・保存を拒否する。
- 全16状態構造の復元と、不正金額・数量・不要属性・重複ID・不正引当等の拒否を検査する。
- 宣言したcheckに既存の重複行が含まれなくても、DB indexが重複発注・請求・有効支払・参照番号を拒否する。重複請求による発注更新もrollbackする。
- 無関係な破損行を保存時に読まない一方、checkに含まれた破損行は復元を拒否し、書込み前に停止する。

別途[3方式の比較](procurement-comparison.md)でSQLite上の全25操作の成功経路を実行する。
DBを開き直した全25操作の再実行や、別OSの同時writer・高負荷・停電復旧を網羅した試験ではない。
全25操作の業務シナリオはメモリ版の35テストで検査し、このSQLite版では上記の永続化固有の境界を検査する。

[実行要求の永続再送境界](procurement-replay.md)を追加し、成功記録と業務writesの同時保存・応答消失時の照会を検証した。
[Applicationの複合結果投影](procurement-projection.md)は追加検証した。永続監査履歴・通常TS/helperとの同条件比較は引き続き対象とする。

## 全件読込みからの変更

以前はBEGIN IMMEDIATEの中でgroup内の全行を復元し、メモリ検査へ渡していた。
現在はチェック対象の主キー照会とDB一意indexへ分担する。
これは取得範囲の改善であり、速度向上率や大規模運用への適合性は測定していない。
無関係な破損データは無関係な保存を止めない。保存のたびに全DBの健全性を検査する機能ではなく、
復元する行と一意制約に関する境界である。全データ検査・修復は別途必要になる。

## 関連行を取得するRepository契約

業務のloadは`related(kind, parentId, actor)`を使う。
orderは申請ID、receipt/invoiceは発注ID、paymentは請求IDで絞る。
SQLiteはgroupと親IDのSQL条件で選択してから復元し、4種類の親参照に対応するindexを持つ。
値はbind parameter、列の選択は固定されたkind対応であり、入力文字列をSQL条件として展開しない。

returned/cancelled/voided等の履歴も同じ親の結果に含む。どの状態を数えるかはdomainへ渡す業務のloadで選ぶ。
これにより、別の親に属する同じkindの破損行を全件復元して業務を止めることを避ける。
対象となる関連行の破損は従来どおり拒否し、DB全体の破損修復を自動提供するものではない。

関連の4kindを型で限定し、通常／非同期portのどちらでも同じ業務宣言を使う。
メモリadapterはMapを走査して一致する行だけをcloneし、SQLiteはDB側で親IDを絞る。
メモリadapterの探索がindex化されたという意味ではない。
不正な別親の発注・検収・請求・支払がある状態で、別申請の作成から入荷・請求承認・支払記録・発注完了まで進めることを実配布consumerでも検証する。

親に属する行数やstock内のpositionsは増え得るため、取得量が常に一定とは主張しない。
実測した速度改善率や高並列運用への適合性はまだ示していない。
