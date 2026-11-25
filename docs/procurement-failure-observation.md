# 全25操作の代表的な拒否と観測を比較する

[追加検査](../src/procurement-failure-observation.test.ts)は、既存の32操作の成功シナリオで、
各成功操作の直前に代表的な不正入力とcommit前のConflictを挟む。
同じg1内の逐次シナリオで、全25操作の名前を固定の一覧と照合し、Koyuki・通常TS・helperをメモリ/SQLiteで比較する。
これは既存実装の検証範囲の追加であり、framework APIや実行エンジンは変更していない。

## 当初の2種類の失敗

| 失敗 | 注入方法 | 明示した期待値 |
| --- | --- | --- |
| 不正入力 | 申請作成はlinesを空配列、それ以外はexpectedVersionを-1へ変更 | InvalidInput。load成功→run:1失敗で停止し、planはnull、commitを呼ばず、全6モデルが不変 |
| 保存前Conflict | 元の正常入力で計画を作り、実adapterへcommitする前にConflictを返す | loadと全業務段階が成功→save失敗。予定されたwrite planを持ち、commitを一回だけ試行し、全6モデルが不変 |

対象IDや他の入力は元の成功シナリオのままなので、対象の取得は成功する。
いずれの拒否でも、読込の対象・順序・回数が直後の正常操作と同じであることを照合する。
失敗後に元の正常入力を実行し、全32回の正常結果と最終状態が、失敗を挟まない通常TSのシナリオと一致する。
元の入力自体を変更しないことも検査する。

一実行につき32回の不正入力と32回の保存前Conflictを検査する。
保存の試行は64回で、そのうち32回が注入したcommit前の拒否、32回が実adapterでの正常保存となる。
この回数を、64個の独立した業務仕様や、全エラー種別を網羅した件数とは扱わない。

## 観測処理も失敗させる

以下の3方式それぞれで、選択値の観測、全入力射影のthrow、全結果射影のthrowを比較する。

- Koyukiの実business宣言とrunDetailed。
- frameworkの実行を使わず手続き的につなぐ通常TSと、その診断adapter。
- 汎用helperで手続き的につなぐ比較版と、その診断adapter。

不正入力の観測は32回×2境界で64記録、保存前Conflictの観測は成功シナリオと同じ121境界。
この2種類の失敗観測は合計185境界となる。射影をthrowさせる場合も、同じ185境界で位置付きCaptureFailedを確認する。
現在は[各read位置の取得失敗](procurement-read-failure-observation.md)も加え、合計263境界を比較する。
[申請・承認・発注の分離](procurement-request-planning.md)で、従来の174/252境界から7境界増えた。
入力射影の失敗後は結果射影を呼ばず、業務のInvalidInput/Conflictを観測失敗へ置き換えない。
privateな例外文面を観測エラーへ含めず、観測境界やread/commitが重複しないことを検査する。
純粋なRule本体の呼出し回数を別にinstrumentした検査ではない。
trace、予定されたplan、選択値、観測エラー、全正常結果、保存状態、読込記録、commit回数を3方式で比較する。

## 検査自体の対照例

追加の対照例では、保存前Conflictを返すという注入契約に反して、先に実adapterへ書く実装を混ぜる。
すると最初の申請作成で、全6モデルの比較が変化を検出して失敗する。
結果がConflictであることだけや、3方式が同じ結果を返すことだけで通る検査にはしていない。
この対照例はメモリadapterで行い、任意の誤実装を必ず検出するという保証にはしない。

## 保証しない範囲

これは選んだ不正入力と、明示的にcommit前へ注入したConflictの比較である。
実DBのcommit途中の障害、commit後の応答喪失、結果不明のcommitに対して、Errなら常に未保存と結論してはいけない。
それらは[再送比較](procurement-replay-comparison.md)や[共通保存境界](transactions.md)等の別契約と検査で扱う。
SQLiteは:memory:を用い、全6モデルの状態を検査する。全DB内部テーブルの検査や、別プロセス・高並列試験ではない。

[各read位置の同期/非同期Result失敗](procurement-read-failure-observation.md)は後続で追加済み。全エラー種別、すべてのRuleの失敗、全load分岐、throw/reject、並行競合、永続再送、Applicationの表示を含む全経路の比較は未完了。
独立利用者の開発体験・実運用・講演全体の完全実現を証明するものではない。
現在の8検査はrootと開発版tarballをinstallしたconsumerで実行し、npm公開は行わない。

[I/Oのthrow/reject](procurement-io-exceptions.md)も、別の検査で追加した。
上のResultによる拒否と異なり、直接commandのPromiseは元の例外でrejectし、ActionReportを得たとはしない。

[在庫4操作の分離](procurement-stock-planning.md)で保存前Conflictの観測がさらに4境界増えた。
不正入力64境界と取得失敗78境界、試行回数とI/O回数は変わらない。
