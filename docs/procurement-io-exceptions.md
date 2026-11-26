# I/Oの例外をResult失敗と区別して比較する

[追加検査](../src/procurement-io-exceptions.test.ts)は、既存の32操作の逐次シナリオで使う
read・related・commitの各位置へ同期throwとPromiseのrejectを注入する。
通常TS・helper・Koyukiをメモリ/SQLiteで比較する。実行エンジンとframework APIは変更していない。

## 対象となる位置

[固定の検査用データ](../src/experiments/procurement/failure-testing.ts)に25操作名とread/relatedの期待回数を記述する。
これはbusiness宣言を反射して正解を作るものではなく、両方の失敗検査から共有する独立した期待値である。
正常入力の保存計画を作り、実adapterのcommit前でConflictを返す予行から具体的な呼出し順を取得する。
固定の期待回数と照合したうえで、位置ごとに例外を注入する。

| I/O | 操作名と順番で区別する位置 | 32操作シナリオでの回数 |
| --- | ---: | ---: |
| read | 32 | 39 |
| related | 15 | 18 |
| commit | 25 | 32 |
| 合計 | 72 | 89 |

同期throwと非同期rejectのそれぞれで89回を試し、全72位置が揃うことを確認する。
申請作成にはreadがないがcommitはあるため、今回の例外比較には全25操作が含まれる。

## 明示した期待値

選択したI/Oを実adapterへ渡す直前で、同じErrorオブジェクトをthrowまたはrejectする。
直接commandのrunDetailedは、そのオブジェクトと同一の例外でrejectし、ResultやActionReportを返さない。
例外位置までの呼出しだけを許し、それ以後のI/Oと実commitを行わず、全6モデルが変わらないことを検査する。
各例外の後に元の正常操作を行い、失敗を挟まないシナリオと全結果・最終状態が一致することも確認する。

ここでは予期しない例外をResultのConflictへ自動変換する契約にはしていない。
既知のproviderエラーをadapterの明示的な方針でResultへ変換する設計を禁止するという意味ではない。
対照例では、そのような方針を指定していないfixtureの例外をloaderが黙ってConflictへ変えると、
最初のrequest.editで検査が失敗することを確認する。

## 観測処理の失敗を重ねる

選択観測、入力射影のthrow、結果射影のthrowという3モードで比較する。
取得中の例外ならloadの入力射影まで、commitの例外ならloadと業務段階の結果射影までが呼ばれる。
例外になった段階について、存在しないResultを射影したり偽の成功/失敗記録を作ったりしない。
元のI/O例外が、観測射影の例外に置き換わらないことを同一性で確認する。

観測callbackの呼出し記録は、この検査が所有する外部の配列へ段階名とphase・成功booleanだけを残す。
返却されていないActionReportや、そのobservations/observationErrorsを取得できたとは扱わない。
元のI/O例外は直接呼出し元へ伝播するため、そのmessageまで秘匿されたという保証でもない。
Applicationのcrashed表示や機微情報の公開方針は別の契約と検査である。

一実行では178回の例外を注入し、入力射影370回と、モードに応じた結果射影192回または0回を確認する。
[申請作成の分離](procurement-request-creation.md)で、直前の362/184回から各8回増えた。
申請作成2回のcommitで、同期throw/rejectそれぞれに2つの業務段階が追加される。I/O位置と注入回数は変わらない。
[申請・承認・発注の分離](procurement-request-planning.md)で、従来の334/156回から各14回増えた。
追加した段階を通る7回の保存について、同期throwと非同期rejectの両方で境界が一つずつ増えるためである。
これを178種類の独立した業務仕様や、全例外分岐を網羅した件数にはしない。

## 保存境界と限界

commitの例外も実adapterへ渡す前に注入するため、このfixtureでは未保存と期待できる。
実DBのcommit途中の例外、保存後の応答喪失、結果不明のcommitまで未保存と結論してはいけない。
予行32回、commit位置への例外64回、正常32回でcommitの試行は128回。そのうち実adapterの正常commitは32回だけである。
既存の[保存境界](transactions.md)と[再送](procurement-replay-comparison.md)の検査は別途継続する。

同じg1内の成功シナリオで通るI/Oが対象で、全入力・全分岐・全tenant・任意のErrorやthenableの網羅ではない。
業務Rule本体、Application、並行実行、永続再送、実DB内部からの例外の全経路は未比較。
SQLiteは:memory:を使い、この7検査をrootと開発版tarballのconsumerで実行する。
独立利用者の開発体験や、講演全体の完全実現を証明したとはしない。

[在庫4操作の分離](procurement-stock-planning.md)による段階追加で射影回数を更新した。
例外の位置・注入回数・元の例外の同一性・I/O停止という検査の対象は維持する。

[返品・訂正の共通検証](procurement-receipt-checks.md)も観測へ出した。射影回数だけを更新し、I/O位置と例外注入回数は維持する。

[数量訂正の実経路](procurement-live-correction.md)でも再検証と計画作成を分けたため射影回数を更新した。
I/O位置72種類と例外注入178回は維持する。

後続の[Application経由の検査](procurement-application-io-exceptions.md)では、同じI/O位置に対して
crashedへの遷移、保持データ、再実行の抑止、dismiss後の明示的な回復、実行メタデータを追加確認した。
この直接commandの三方式比較と、後続のApplicationによる四条件の検査は別の範囲である。
