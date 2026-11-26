# businessの入力保持を補う候補の調査

genericなwithInputをbusinessの関数列へ置くと、loadが返す具体的なContextを途中のinput/valueへ保持できない例が残る。
[元の再現例](../scripts/fixtures/business-input-pair.ts)には、直接呼び出す型の正例と、具体的なContextを注釈した回避策、
入力・最終Resultの厳密一致を含む。同じ例を現行6f312eeで再検査した。

今回はwithInput自体の署名を変えず、businessの中間成功型StageOutputだけを一時コピーで変更した。
input/valueという形の成功型に対して、直前の具体的な入力をinputへ補う候補を作る。
補った戻り値を実際の関数が保証するというRuleへの代入検査も条件にした。

| 候補 | 既存ソースの型検査 | operationsを直接宣言 | operationsを先に束縛 |
| --- | --- | --- | --- |
| 現行 | 通過 | 不受理 | 不受理 |
| mapped typeでinputだけ置換 | 通過 | 不受理 | 不受理 |
| input/valueのReadonlyな型 | 通過 | 不受理 | 不受理 |
| 元の成功型とinputの交差型 | 通過 | 不受理 | 不受理 |

operationsの先行束縛にはas constだけを使い、Contextの追加注釈や型アサーションによる接続保証は加えない。
各probeで既存ソースへの追加診断は0で、欠落import・暗黙anyによる失敗もなかった。
この3候補では問題の例が通らないため、いずれもcoreへ採用しない。
単純な中間型の置換やoperationsの先行束縛だけでは、この例の推論を解消できたといえない。
原因をTypeScriptの特定の内部処理と断定したり、他の改善も不可能と結論したりはしない。

## 再現

```sh
node scripts/investigate-business-pair.mjs
```

[調査器](../scripts/investigate-business-pair.mjs)は、クリーンなソースを一時フォルダーへコピーし、
各候補で既存ソース全体を型検査してから、同じprobeを追加する。
作業ツリーのcoreは変更せず、一時コピーを終了時に削除する。
既存ソース・欠落import・暗黙anyの診断がprobeで新たに出た場合は、通常の不受理記録として扱わず終了する。
[結果JSON](business-pair-specialization-investigation.json)には、基準commit、compiler、collector・候補・fixture・lockのhashと診断を保存する。
基準commitと同じソース・依存を用意し、記録したcollectorを使う必要がある。後続commitでの再実行は別の観測である。

この調査は保守者による静的検査であり、runtimeや独立利用者の開発体験の試験ではない。
[具体的な前段があるWorkflow](workflow-context-inference.md)や、[制約内でのgenericな先頭Workflow](workflow-generic-first.md)の正例は引き続き使える。
購買の3つの文脈注釈、名前なしinlineの別例、独立利用者の試用、講演の全内容の完全実現は未完了のまま残す。

[後続の設定束縛と関数型判定](business-pair-binding-investigation.md)では、設定全体を束縛した場合と
単独の型計算を区別した。型計算が成立してもbusiness全体の宣言は通らず、候補をcoreへ採用していない。
