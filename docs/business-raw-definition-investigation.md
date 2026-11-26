# 設定全体を先に推論する候補の追加調査

前の[束縛・型計算の比較](business-pair-binding-investigation.md)では、設定を変数へ
束縛しても、withInputが保持する入力の相関をbusinessで受理できなかった。
今回は一時コピーへ専用のoverload候補を加え、設定全体Dを先に推論し、
その後でNoInfer内の接続検査を行う形を調べた。

```sh
node scripts/investigate-business-pair.mjs --raw-definition
```

[結果JSON](business-raw-definition-investigation.json)はcollector・compiler・lock・
fixture・候補ソースのhashと基準commitを含む。実製品のcoreは変更していない。

| 一時コピー | 既存ソースの型検査 | inlineの設定 | operationsを先行束縛 |
| --- | --- | --- | --- |
| 現行 | 成功 | 不受理 | 不受理 |
| 設定全体を先に推論するoverload | 成功 | 不受理 | 不受理 |
| 上記と、入力の組の補正・直接の関数型による検査 | 成功 | 不受理 | 不受理 |

全6試行で既存ソースへの追加診断は0。fixtureはContextのprivateフィールド、
入力・成功・失敗型の厳密一致を含み、欠落importや暗黙anyで失敗した結果ではない。
以前の--binding調査も対照として実行し、既存の受理/不受理の区別を維持する。

候補の組立中には、最後のoverloadに追加すると既存エラー位置が移動する問題、
先頭に追加してもoperation resolverの引数検査を省くと不正な定義を受理する問題を確認した。
記録した最終候補は元の最終overloadを維持し、resolver名・saveのcontextも検査する。
これらを省いて成功したように扱わない。

候補は再送なし・共通loadありの部分に限る。採用できる完全な新APIを作った記録ではない。
それでも対象の正例は通らないため不採用とする。TypeScriptの内部原因や
他の全ての改善案が不可能であることまで証明しない。

入荷処理の3つの文脈注釈、名前なしinlineや任意の多相変換の制約は残る。
設定の推論順序を変えるだけで解消したとは扱わず、今後の候補には新しい根拠が必要である。
独立利用者による評価・原音確認・講演全体の判定も変更しない。
