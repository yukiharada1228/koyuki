# 現在値取得付きApplicationの3方式比較

[再送後の現在値取得](procurement-current-projection.md)を独立plain/helper Applicationにも接続した。
`baselineCurrentApplication`は既存の独立session driverへcurrent取得callbackを渡す。
従来baselineApplicationはcallbackなしで動き、過去値を投影しない方針を維持する。
KoyukiのApplication/Program/replayOperationsは基準実装の実行には使わない。

## 共有する境界と独立する処理

3方式はdomain、要求識別、SQLiteのcurrent read transaction、純粋なapplyCommittedを共有する。
replayed後に現在値を取得する制御と、取得結果を検査して状態へ反映する処理は基準実装側にも実装する。
一つのsession状態機械を再利用し、現在値取得のために25操作やqueueをコピーしない。

保存成功はcommitted、過去記録はreplayedのまま扱い、取得を新しい業務commitと偽装しない。
対象キーの不足・重複・別group・想定外ID・過去の保存version未満をProjectionUnavailableで拒否する。
想定外の取得例外はcrashedとし、既知の表示を維持する。

従来版と現在値取得版は型付きの公開factoryを分ける。
独立driver内部の状態は現在値取得エラーも表せるが、callbackなしの公開factoryにはそのエラーを追加しない。
保存・実行要求・権限の契約を基準実装だけ簡略化しない。

## 比較した代表シナリオ

`src/procurement-current-comparison.test.ts`の4シナリオをKoyuki/plain/helperへ適用する。
dispatch結果・snapshot・revision・通知・session traceを比較し、実tarballのconsumerでも実行する。

1. CommitUnknownからの復旧。空のViewへ保存行が表示され、その後の再送でもcommitは1回のまま。
2. 古いdraftの成功記録から現在のsubmittedを表示する。取得不能・不正patch・例外を順に注入し、表示を保ったままdismiss後に再取得できる。
3. 返品後に再入荷・再照合された4モデルを、過去返品の再送から現在versionへ更新する。
4. 最初のcurrent取得をgateで止めてrunningを確認し、後続入力の待機中変更を受けず、さらに後ろのstale要求をIO前に拒否する。

不正patchには不足・重複・別group・想定外ID・version 0を含む。
シナリオ2は既存version 2の表示が失敗で消えないことと、再取得時に新しい業務commitが起きないことも直接検査する。
シナリオ3は発注version 5・請求version 4・在庫version 3を確認する。
過去の更新対象に含まれない新規検収は発見しないため、全体同期ではない点も3方式で同じである。

既存の現在値を取得しないApplication比較も継続し、切替えによる回帰を検査する。

## 残る比較

これは新しい取得方針の代表ケースでの契約一致であり、任意のport・全25操作の全状態を網羅した保証ではない。
3方式は同じcurrent read transactionを利用するため、別DBのsnapshot保証まで比較したわけではない。
全体初期取得・ページング・他session同期・ブラウザ描画・任意の外部observer隔離は対象外。
値のcapture・観測失敗・仕様変更差分・追加基盤を含めた実装量と、独立利用者の開発負担の評価は継続する。
テスト時間から性能や生産性の優位性は主張しない。

## 後続機能との境界

この比較は従来のsnapshot/subscribe/trace/dispatchを対象にする。
[Application実行観察](application-execution.md)のsubscribeExecutionは独立driverへ実装しておらず、
比較用の型から除外している。観察の実装量や開発体験まで等価とする根拠にはしない。
