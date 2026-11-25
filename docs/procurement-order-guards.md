# 注文3操作の共通検証をruntimeへ接続する

[購買アプリ](../src/experiments/procurement/application.ts)の注文変更・取消・完了を、
共通検証と個別更新の2つの普通の関数で宣言する。

```ts
amend: { load: context.order<AmendInput>, run: [checkOrder, amendCheckedOrder] },
cancel: { load: context.order<VersionInput>, run: [checkOrder, cancelCheckedOrder] },
complete: { load: context.order<VersionInput>, run: [checkOrder, completeCheckedOrder] },
```

checkOrderはLoaded<VersionInput, Order>と関連情報を受け取るgeneric関数で、
成功時に元の文脈へprivateな検証済みbrandを付けた型を返す。操作固有のsupplier等の型を保持するため、
checkOrderの型引数やResult接続用のラッパーは、操作の宣言へ追加していない。
[generic検証の推論](business-generic-checks.md)を既存の業務モデルへ適用した例である。

## 移した責務と維持した契約

従来は各業務関数内で共通guardを呼び、失敗ならreturnして現在のOrderを取り出していた。
現在のKoyuki版はその接続と失敗停止をruntimeへ委ね、更新関数は検証済み文脈を要求する。
検証を省いて更新関数を呼ぶコードは型検査で拒否する。

共通検証の拒否順序は、操作者の権限と所有者、対象と関連情報、版数の形式、版数の一致、現在の状態。
その後に、変更のsupplierや関連記録の有無、完了の請求・入荷数量一致等を個別に確認する。
保存計画・操作ID・要求と成功/失敗型・CASによる保存条件は維持した。

純粋な関数として直接呼ぶ既存のamendOrder/cancelOrder/completeOrderは互換の入口として残し、
共通検証と更新をつなぐ。plain/helper比較版はframeworkの実行を呼ばず、同じ2関数を手続き的につなぐ。
privateな型の証明はdomain内の検証成功を信頼する境界であり、runtime propertyの追加やcloneはしない。
Readonlyな取得文脈を検証から更新まで保つ前提があり、任意のgetter・外部からの変更・型アサーションまで
安全にする仕組みではない。DB側の変更との競合は引き続き保存adapterの検査が担当する。

## 観測される変更

3操作の成功traceはload / run:1（共通検証）/ run:2（個別更新）/ saveとなる。
共通検証の失敗ではrun:2とsaveを記録せず、個別更新の失敗ではsaveを記録しない。
比較用のplain/helperの診断もこの境界を明示し、観測をframeworkの再実行で生成しない。

[25操作の成功シナリオ](procurement-observation-comparison.md)は32操作であり、
この3操作が各1回ずつ現れる。注文3操作のみを分離した時点では、選択値観測は96から99記録へ変わった。
現在は[申請5操作・請求書2操作も分離](procurement-shared-guards.md)し、106記録と対応する観測エラーを比較する。

## 確認した範囲

[追加検査](../src/procurement-order-guard.test.ts)は、複数条件が不正な8ケースの拒否優先順位、
3操作の明示した期待保存計画、文脈の参照保持と非変更、brandを省いた型の拒否を確認する。
メモリとSQLiteでは注文を実際に作成し、共通検証・個別更新・保存の失敗と、変更・取消後の状態を検査する。
SQLiteは:memory:で、別プロセス競合や実運用の評価ではない。
既存の全25操作の3方式比較と観測検査も継続する。追加検査は実tarballのconsumerでも実行する。

今回適用したのは3操作であり、全25操作のguard分解や、任意の業務関数内の接続の自動除去ではない。
業務の拒否条件とその優先順位、取得順、保存条件は利用者が定義する。
独立利用者の書き心地・生産性や、講演全体の完全実現をこの変更で証明したとはしない。
