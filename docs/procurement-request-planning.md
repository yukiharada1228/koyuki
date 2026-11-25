# 申請・承認・発注の共通検証を宣言へ移す

購買のrequest.submit、request.approve、order.placeにも、既存の共通検証を適用した。
framework APIと実行エンジンは変更せず、実際の業務宣言で接続を委譲する範囲を広げた。

```ts
submit: { load: context.approval, run: [checkBuyerRequest, submitCheckedRequest] },
approve: { load: context.request<VersionInput>, run: [checkApproverRequest, approveCheckedRequest] },
place: [checkBuyerRequest, placeCheckedOrder],
```

関数の成功値の取り出し、失敗時のreturn、次の関数の呼出しを、操作ごとに記述しない。
新しい共通検証やbuilderも追加しない。genericな検証関数がpolicy・入力・現在モデルを保持し、
後半の関数が要求するbuyer/approverのprivateな証明を渡す。

## 業務として残す判断

共通検証は役割・所有者・対象ID・版数と、承認待ちの場合の担当承認者を確認する。
後半の関数には、現在状態、承認者の指定、予算、二段階承認、発注先、重複発注の規則を残す。
frameworkが業務の判断内容や、どの順番で確認すべきかを推測する変更ではない。

承認操作では、元の実装が現在状態を確認した後に担当承認者を確認していた。
共通検証は承認待ちのときだけ担当者を確認するため、承認待ち以外の状態は後半で従来どおりWrongStateとなる。
版数の不正や競合が担当者不一致より先に返る順序も維持する。

従来のsubmitRequest・approveRequest・placeOrderは、一括で呼べる純粋関数として維持する。
これらの互換用関数内には検証結果を渡す接続が残るが、実business宣言は互換関数を通らず、2段階を直接実行する。
通常TS/helperの比較版も同じ2段階を手続き的につなぎ、Koyuki runtimeを流用しない。

## 直接確認した期待値

[追加検査](../src/procurement-request-planning.test.ts)は次を確認する。

- 複数の拒否条件を重ね、Denied → TargetMismatch → InvalidInput → Conflictと、操作固有のWrongState・担当者不一致の優先関係を固定した期待値で照合する。
- 単独承認、二段階承認のfirst-review → final-review → approvedと、発注の結果・保存対象・版数・期待するCAS条件を明示する。
- 共通検証が同じ文脈の参照を返し、元の文脈を変更しないことを確認する。
- メモリ/SQLite上で、共通検証・個別判断・保存前Conflictの各失敗を区別し、後続の保存が起きないことと全6モデルの非変更を確認する。
- 検証の省略やbuyer/approverの証明の混同を型検査で拒否する。

検証済みの文脈はreadonlyの契約で、検証と後半の判断の間に内容が変わらないことを前提にする。
型アサーション、外部からの未検証値、可変の別名参照まで安全にする機能ではない。
永続データの競合と原子性は、従来どおりrepositoryのCAS/transaction契約で扱う。
保存前Conflictの注入は、DBのcommit途中のrollback検査とは別である。

## 全25操作の比較への反映

共通検証を分離した操作は10から13となり、入荷・在庫の3操作も合わせると、2段階の宣言は16操作となる。
全25操作を2段階へ分割済みという意味ではない。

既存の32操作の成功シナリオでは、申請が4回、承認が1回、発注が2回現れる。
7境界が加わり、選択観測は110から117記録へ増える。read・related・commitの回数と保存結果は変わらない。
不正入力は64境界、保存前Conflictは117境界で合計181境界となり、選んだread位置のResult失敗78境界も含めると259境界となる。
I/O例外の89回の呼出し位置と72種類の位置は変わらず、throw/rejectで178回注入する。
段階追加に伴い入力射影は348回、結果射影はモードに応じて170回または0回となる。

正常・代表失敗・例外の3方式比較と、新しい検査を実tarballのconsumerでも実行する。
これらの件数を独立した業務仕様の数や、全分岐・全障害経路の網羅率として使わない。
互換関数や比較基盤も含めたコード量の削減、独立利用者の認知負担・生産性の改善は未測定である。
