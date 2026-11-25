# 3方式の永続再送を比較する

通常TypeScript/helper版に`baseline-replay.ts`を追加した。
KoyukiのwithReplay・business・Workflowを実行せず、基準実装側のdriverで同じ再送契約を実装する。
25操作を一つずつコピーせず、元のplain/helper定義へ呼出し専用の保存境界を結び付ける。

## 共有と独立の境界

3方式はdomain、load context、要求の正規化・Web Crypto fingerprint、SQLiteの実行記録と原子保存を共有する。
認証情報やDB保証を基準実装だけ弱くしない。
一方、入力snapshot、lookup、業務呼出し、保存結果の分類、失敗後の成功照会、reportの組立ては基準実装側で実装する。
型は共通のResult/Execution/ReplayReportを使用するが、型importでKoyukiの実行runtimeを使うことにはならない。
共有domain/identityのok/err等まで排除した依存ゼロ製品同士の比較ではない。

plain/helperの保存エラーをgenericにし、再送境界のCommitUnknownやReplayMismatchを潰さず伝播する。
元の通常呼出しは従来どおりのStorageError契約を保ち、入力・成功型の検査も継続する。
基準実装のdriver・段階通知・型の対応表は比較用の追加基盤であり、今後の実装量評価へ含める。

## 同じ契約を持つ処理

入力をcloneできなければ、業務を実行せずReplayInputNotCloneableを返す。
lookupの不一致・権限・JSON形式の検証失敗は業務呼出し前に停止する。
過去成功があればreplayedを返し、attemptはnull。現在の業務状態を取得し直して過去成功を計算し直さない。

未保存なら元のplain/helper操作を一度実行し、同じSQLite transactionで業務writesと成功記録を保存する。
呼出しが持つ保存結果からcommitted/replayedを分類し、競合で負けた計画のwritesを成功値として公開しない。
想定内の失敗後は成功記録を照会し、見つからなければ元の失敗を返す。業務処理の自動retryはしない。
想定外の例外はそのままrejectする。

runDetailedでは実行したload/rule/saveのtraceと試行planを持つ。
通常runのattemptはtrace:null/plan:nullで、Koyukiの通常再送契約に合わせる。
再送traceはsnapshot、lookup、command、resolutionの各段階と結果を記録する。

内部構成を完全に同じにしたわけではない。例えば基準driverは一呼出し内のprepared fingerprintを再利用する。
ここで比較するのは外部から観測する契約で、内部hash計算回数や処理時間の同一性ではない。

## 検証した範囲

`src/procurement-replay-comparison.test.ts`をKoyuki/plain/helperへ適用し、次を検査する。

- 25操作を同じ入力契約で登録する。
- 作成・申請後の過去作成結果、要求不一致、取得対象なし、保存競合、clone失敗、不正DTOについて、report全体と保存状態が一致する。
- 不一致等のエラー種別と、過去結果がversion 1・現在状態がversion 2であることも直接検査する。
- hostが明示的にCommitUnknownと返した保存成功を、一度のcommitと成功記録の照会で解決する。reportも一致する。
- 実行記録INSERTへの失敗注入で業務行もrollbackし、記録がmissingであること、修復後の明示的な再実行が成功することを検査する。
- 同じ要求の4並行呼出しで1回だけcommitted、残りは過去成功となり、業務行が一つであることを確認する。
- requestIdと操作固有入力が、独立driverの型でも必須であることを検査する。

SQLiteは各検査で新規DBを使い、配布tarballの独立consumerでも同じ検査を行う。
共有DB adapterの原子性を利用しているため、この比較が基準実装側でDB transactionまで独自実装したことを意味しない。

## 未完了の比較

全25操作の全再送・障害経路を網羅したという判定ではない。
複数モデル更新の再送、AlreadyExists競合等のKoyuki検査は存在するが、今回の3方式比較へはまだ全ケースを移していない。
Application・値のcapture・機密項目選択・観測例外の分離・永続監査は比較を続ける。
同じ仕様変更を適用した差分、実装量、型検査コスト、独立利用者の開発体験も未測定。
テスト所要時間や少数の並行呼出しを性能・耐久性・生産性の実測へ置き換えない。
