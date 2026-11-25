# 選択値の観測を3方式で比較する

通常TypeScript/helper版の診断処理へcaptureを追加した。
基準実装側で選択・clone・例外分離・記録所有権を実装し、KoyukiのcreateObservationやbusiness runtimeは実行しない。
WorkflowCapture/ObservationReport等の型は共有し、結果・trace・planに加えて観測値と観測失敗も比較する。

## 基準実装へ追加した処理

各段階の実行前に入力射影を呼び、実行後にResult射影を呼ぶ。
plainは各操作、helperは共通actionで段階hookを接続する。
診断wrapperは呼出しごとの記録先を用意し、射影された値をcloneする。
入力射影が失敗した段階ではResult射影を呼ばず、業務処理そのものは継続する。

射影・cloneの失敗はstep/phase/CaptureFailedだけへ変換する。
例外文面や元データをそのまま観測失敗へ含めない。
観測配列と各記録はfreezeし、選択した値は呼出し元のオブジェクトから分離したsnapshotとなる。
captureを指定しない通常reportへobservations等の項目は追加しない。
型付きrunDetailedの追加引数から選択値の型を推論し、元の入力・成功・失敗型も維持する。

射影は純粋なcallbackとして使うことを前提とする。
callbackが渡された元値を意図的に変更する場合の副作用防止や、callbackの純粋性を型だけで証明する機能ではない。
ここでの失敗分離は、検証した射影・clone例外が業務結果を失敗へ置換しないという範囲である。

## 比較した代表ケース

`src/procurement-observation-comparison.test.ts`の4シナリオをKoyuki/plain/helperへ適用する。
report全体を比較し、次の期待値も直接検査する。

- 非選択部分にfunctionやprivateな文字列がある入力から、選択したclone可能な値だけを記録する。選択元を後から変更しても記録は変わらない。
- 入力射影が例外になった3段階ではResult射影を呼ばず、業務保存は成功する。観測失敗へprivateな例外文面を出さない。
- 保存後のResult射影がfunctionを返してclone不能になっても、保存済みの成功結果を保ち、saveのCaptureFailedだけを記録する。
- 業務関数がInvalidInputを返す場合はload/ruleだけを記録し、saveを実行しない。
- 2つの同時呼出しで、それぞれのcaptureが他の呼出しへ混ざらない。

選択値の型、freezeされた記録、実保存件数も確認し、実tarballの独立consumerで同じコードをコンパイル・実行する。
例外の分離だけでなく、保存件数が変わらないことを検査する。

## 25操作の共通シナリオへの拡張

[追加の検査](../src/procurement-observation-scenario.test.ts)では、
[通常実行の比較](procurement-comparison.md)と共有する25操作・32回の成功シナリオを使う。
通常TypeScript、helper、Koyukiのそれぞれに、メモリとSQLite :memory:を適用する。
SQLiteは実driverだが、ファイルの再起動や別プロセスの比較ではない。

各呼び出しのload・Rule・saveから、呼び出し番号と選択した対象のkind/id/state/versionを記録する。
操作者や任意フィールドを全収集する機能を追加したものではない。
全32回について、次を直接検査し、report全体も独立した通常TypeScriptの詳細実装と比較する。

- load・業務段階・saveのtraceが成功し、順序も一致する。[共通検証の10操作](procurement-shared-guards.md)と[入荷・在庫の3操作](procurement-receipt-pipeline.md)はrun:1とrun:2、それ以外はrun:1となる。
- 選択記録は3件で呼び出し番号が混ざらず、最後の成功値の対象情報が業務結果と一致する。
- 各操作でcommitは1回だけ。最終の6モデルと32件の戻り値が、観測なしの通常実行と一致する。
- Repositoryのread/relatedの対象と呼出し順も、観測なしの通常実行と一致し、診断用の再取得を増やさない。
- 全段階の入力射影がthrowしても、業務結果と保存状態を保つ。Result射影は一度も呼ばない。
- 全段階のResult射影がthrowしても、保存済み成功を失敗へ置換しない。
- 射影の失敗は対応するstep/phase/CaptureFailedだけになり、例外の文面は残さない。

成功時は1シナリオ110記録、観測失敗時は110件の観測エラーを確認する。
[注文3操作の分離](procurement-order-guards.md)で96から99となり、[申請・請求書](procurement-shared-guards.md)の7操作も分離して106となり、[入荷・在庫の接続](procurement-receipt-pipeline.md)でさらに4境界が加わって現在は110となる。
同じコードを実tarballの独立consumerでも型検査・実行する。
この追加は新しい観察APIの導入ではなく、既存APIの検証範囲の拡張である。

## 引き続き残る範囲

比較したcaptureは25操作の成功シナリオと、上記代表的な業務失敗における
通常の業務commandのload・一つのrule・saveに対するもの。
再送lookup、現在値の取得、複数rule・分岐・途中IOを含む全観測経路まで3方式で網羅したわけではない。
Koyuki本体にある他の観測テストと、この購買比較の対象を区別する。
永続監査・保持期間・全機密項目の自動選択は追加していない。

これで代表ケースについて、取得・業務・保存、基本trace、永続再送、Application、現在値取得、選択値観測の比較基盤がそろった。
全機能が普遍的に同等という完了判定ではなく、次は同じ仕様変更を適用した差分と、共通基盤を含む実装負担を評価する。
独立利用者の開発体験・生産性・実運用バグ率は未測定。


## 後続の代表失敗の比較

[全25操作の代表的不正入力とcommit前Conflict](procurement-failure-observation.md)も比較する。
32回ずつの失敗に対する174境界で、射影失敗を含め、停止・全6モデルの非変更・その後の正常実行を照合する。
上記の110境界は正常操作の観測であり、この174境界と混ぜて全失敗・全経路の完成件数とは扱わない。
