# 購買評価アプリのSQLite host

25操作の評価アプリへ`SqliteProcurement`を追加した。
コアの公開APIや依存は変更せず、Nodeの`node:sqlite`は評価用hostだけで使用する。
このadapterを任意のWeb runtimeで使えるとは扱わない。

## 保存と復元

`src/experiments/procurement/sqlite.ts`が`ProcurementRepository`を実装する。
constructorでtrusted groupを固定し、read/list/commitをそのgroupに制限する。
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
transaction内の現行行を使い、メモリadapterと共通の同期検査で期待versionと一意性を確認する。
発注・検収・請求・在庫などのwritesをすべて保存してCOMMITする。
途中の書込み失敗はROLLBACKする。既知の一意制約・busy競合はConflictとして返し、それ以外の例外は再throwする。
Resultの失敗伝播だけでrollbackしているのではなく、このDB transactionが原子性を提供する。

この初期実装は保存時にgroup内の全行を読み、共通検査へ渡す。取得量・メモリ量・書込みロック時間はデータ量に依存する。
group全体の在庫集約も同じversionを共有する。大規模運用向けの取得効率や高並列性能は未検証であり、
関連行だけの照会とSQL制約への置換、集約境界の見直しは比較評価に残る。
read/listの複数回呼出しはsnapshot transactionではない。保存時のversion検査が古い計画の確定を拒否する。

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

DBを開き直した全25操作の再実行や、別OSの同時writer・高負荷・停電復旧を網羅した試験ではない。
全25操作の業務シナリオはメモリ版の34テストで検査し、このSQLite版では上記の永続化固有の境界を検査する。

実行要求IDに対するreceiptはまだなく、保存成功後の応答消失を安全に再送できるという保証は追加していない。
永続監査履歴・Applicationの複合結果投影・通常TS/helperとの同条件比較も引き続き対象とする。
