# 申請と請求書の共通検証を通常関数列へ移す

[購買アプリ](../src/experiments/procurement/application.ts)の申請5操作と請求書2操作へ、
[注文3操作](procurement-order-guards.md)と同じ接続を適用した。
現在、全25操作のうち次の10操作が共通検証と個別更新の2段階を宣言する。

| 操作 | 共通検証 | 更新関数の要求する証明 |
| --- | --- | --- |
| request.edit / withdraw | checkBuyerRequest | buyer |
| request.reject / return / reassign | checkApproverRequest | approver |
| order.amend / cancel / complete | checkOrder | 注文の共通検証済み |
| invoice.approve / void | checkInvoice | 請求書の共通検証済み |

```ts
reject: { load: context.request<ReasonInput>, run: [checkApproverRequest, rejectCheckedRequest] },
reassign: { load: context.approval, run: [checkApproverRequest, reassignCheckedRequest] },
approve: { load: context.invoice<VersionInput>, run: [checkInvoice, approveCheckedInvoice] },
```

必要な入力・操作者・policyや親注文を含む文脈をgeneric検証が保持する。
検証の型引数、Resultの取り出し、失敗時のreturnを操作宣言へ追加していない。
取得方法と入力型の宣言は従来どおり残る。framework APIやdomain用builderは追加していない。

## 役割を混同しない証明

申請のprivate brandにはbuyerとapproverの別を含める。
購入担当者の検証が成功したことを、承認担当者の検証が成功したこととしては渡せない。
反対方向や、証明を省いた請求書更新も型検査で拒否する。
このbrandは検証済みという型の信頼境界であり、frameworkが権限を決めたりruntimeの認証を代行したりしない。
元のreadonly文脈の同じ参照を返す。保持中の外部変更や型アサーションへの限界は注文の契約と同じである。

既存の単体呼び出し用editRequest等は、共通検証と更新をつなぐ互換の入口として残す。
Koyukiアプリはその入口を呼ぶ代わりに、2関数の接続をruntimeへ任せる。
plain/helper比較版では2段階を自分で実行し、frameworkによる実行は使わない。
詳細loaderを使う別構成の請求書操作も同じ2段階へ揃える。

## 拒否の順序と観測

申請は、操作者の役割・所有者の条件、対象ID、版数形式、版数一致、承認中なら割当先の順。
例えば別の承認担当者が版数0を送った場合はInvalidInput、古い版ならConflict、正しい版ならDeniedとなる。
その後に、操作ごとの状態・理由・次の承認先等を検査する。この順序を変更していない。
請求書も、finance権限、対象と親注文、版数形式、版数一致の後に個別の状態や理由を検査する。
操作ID、保存計画、成功/失敗型、CASによる保存条件は維持する。

10操作の成功traceはload / run:1 / run:2 / saveで、共通検証で失敗すればrun:2とsaveを実行しない。
[全25操作の成功観測比較](procurement-observation-comparison.md)の32操作では、この10操作が各1回ずつ現れる。
記録数は、注文3操作だけを分けた時点の99から、現在は106となる。観測入力/結果の射影失敗も106境界で比較する。

## 検査と残る範囲

[追加検査](../src/procurement-shared-guards.test.ts)で、複数条件が不正な場合の拒否順序、
役割ごとのbrand拒否、申請の却下・担当変更と請求書取消の明示した期待保存計画、参照保持・非変更を確認する。
メモリ/SQLiteでは実際の申請から注文・請求書を作成し、共通検証と個別検証の失敗による保存停止、
請求書取消に伴う親注文の版数更新を確認する。実tarballを使うconsumerでも同じ検査を行う。
既存の全25操作の3方式比較と、二段階承認等の仕様変更検査も継続する。

全25操作の一括分解ではない。入荷と在庫の保存計画を組み合わせる処理などは、取得順・失敗順と
業務上の集約判断を含むため、共通guardの呼び出しと同じ置換としては扱っていない。
今回の有限な検査で全不正入力・全障害経路・実運用を網羅したとはしない。
独立利用者のDX評価、講演全体の完全実現も未確認のままである。
