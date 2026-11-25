# 宣言した取得の各read位置で停止を比較する

[代表失敗の比較](procurement-failure-observation.md)へ、同期のErrとPromiseで解決するErrを加えた。
[検査](../src/procurement-failure-observation.test.ts)は同じ32操作の逐次シナリオを使い、
通常TS・helper・Koyukiをメモリ/SQLiteで比較する。実行エンジンやframework APIは変更していない。

## 対象は24操作・32種類のread位置

申請作成のloadは入力と操作者の文脈を作るだけでrepositoryを読まない。
検査でもreadが0回であることを確認し、この操作に取得エラーを作り出さない。
残る24操作については、操作名とreadの順番を組にして32種類の位置を区別する。

| 操作 | 一回の正常loadのread数 |
| --- | ---: |
| request.create | 0 |
| その他のrequest、order、payment、inventory、invoice.register | 1 |
| receipt.receive、invoice.match / approve / void | 2 |
| receipt.return / correct | 3 |

これらの回数はソースの宣言に基づく固定の期待値であり、実行結果からそのまま生成して正解にするものではない。
正常な保存計画を作ってcommit前で拒否する試行から、具体的なread/relatedの順序を取得し、
固定の回数と照合した後、その各read位置へ失敗を注入する。
元シナリオでは操作を繰り返すため、32種類の位置は39回実行される。
同期・非同期それぞれについて39試行と、操作名/順番の32組が揃うことを確認する。

## 何を注入するか

指定したreadの直前で、実adapterへ渡す代わりに次のいずれかを返す。

- 同期のErr({ kind: 'Conflict' })。
- Promise.resolveした同じ形のErr。

Promiseのrejectやthrowではなく、明示的なResult失敗である。
stockのNotFoundは空の在庫として受理する業務仕様があるため、NotFoundを無条件に取得失敗とは扱わない。
今回のConflictは、どのreadでもloadの失敗として伝播させる期待値である。

失敗したreadを含む位置までの呼出しだけを許し、その後のread/relatedを呼ばないことを確認する。
事前に成功したread/relatedは取り消さない。traceはload/errorのみ、planはnull、commitは0回で、全6モデルは不変。
各失敗後に元の入力を正常実行し、失敗を挟まないシナリオと全正常結果・最終状態が一致することも検査する。

## 観測と対照例

選択観測、入力射影のthrow、結果射影のthrowという3モードを使い、業務のConflictを観測エラーへ置き換えない。
各取得失敗の観測はloadの1境界。同期39回と非同期39回で78境界が加わり、
従来の不正入力・保存前Conflictの174境界と合わせ、現在の一実行は252境界となる。
失敗の試行は142回（32不正入力＋32保存前Conflict＋78取得失敗）。
commit試行は64回のままで、追加した取得失敗によるcommitはない。

正しいConflictを返していても、その後に余計なrelatedを呼ぶloaderを混ぜると、
最初のrequest.editで呼出しの検査が失敗する対照例も追加した。
結果と保存状態が同じなら通る検査にはしていない。
従来の、Conflictの前に誤って書き込むadapterを検出する対照例も残す。

## 限界

同じg1内の、成功シナリオで通る取得順を対象とする。全入力・全分岐・全tenantや任意のloaderの網羅ではない。
relatedはResultを返さない契約のため、そのthrow/reject、readのthrow/rejectも今回の注入には含めない。
例外をResult失敗へ勝手に変換したり、存在しないActionReportを得たとしたりしない。
直接commandを呼ぶ比較であり、Applicationのcrashed表示・並行実行・永続再送・実DBの障害検証は別範囲。
SQLiteは:memory:を用い、この8検査をrootと開発版tarballのconsumerで実行する。
講演全体の完全実現や独立利用者のDX評価を完了したとはしない。
