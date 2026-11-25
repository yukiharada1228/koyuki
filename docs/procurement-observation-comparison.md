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

## 残る範囲

比較したcaptureは通常の業務commandのload・一つのrule・saveに対するもの。
再送lookup、現在値の取得、複数rule・分岐・途中IOを含む全観測経路まで3方式で網羅したわけではない。
Koyuki本体にある他の観測テストと、この購買比較の対象を区別する。
永続監査・保持期間・全機密項目の自動選択は追加していない。

これで代表ケースについて、取得・業務・保存、基本trace、永続再送、Application、現在値取得、選択値観測の比較基盤がそろった。
全機能が普遍的に同等という完了判定ではなく、次は同じ仕様変更を適用した差分と、共通基盤を含む実装負担を評価する。
独立利用者の開発体験・生産性・実運用バグ率は未測定。
