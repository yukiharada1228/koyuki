# 再送付きbusinessのcallback推論調査

調査開始時のAPIには、saveとreplay.lookupを同じ宣言内に書くと、saveのexecution引数へ
型注釈が必要になる組み合わせがあった。文字列操作名と数値操作名の両方で再現した。
これは実行時の再送失敗ではなく、宣言時の型推論の制限である。
名前付きの保存関数でGroupExecutionの型を指定する既存の書き方は利用できる。

## 再現可能な検査

```sh
node scripts/investigate-replay-context-inference.mjs
```

スクリプトは一時ディレクトリへsrcをコピーし、インストール済みTypeScriptで
現行宣言と4候補を比較する。作業ツリーの実装は変更しない。
元の全src型検査の成功を先に確認し、追加した例について操作名・要求型・
公開成功型・失敗型の厳密一致を検査する。
genericなidentity saveを再送用として誤って受け入れない拒否例も含む。

[保存結果](replay-context-inference-study.json)にはcompiler版と元のbusiness.tsのSHA256を記録した。
現行宣言とNoInferの置き場所を変える2候補では、追加例が失敗した。
replay必須の専用overloadを先頭へ加える2候補では、追加例と既存の型検査が成功した。
保存結果のacceptedはこの検査集合での成功を意味し、公開APIへの採用判定ではない。

## 開発版への採用と検証範囲

開発版にはreplay必須の専用overloadを採用した。実行エンジンは変更していない。
[回帰検査](../src/business-replay-context.test.ts)を実tarballの独立consumerにも含め、
文字列・数値操作名、要求型、全段階の失敗型、generic identity saveの拒否を検査する。
現在のRuleがdraftだけを生成する場合も、保存契約が許す過去のapprovedを再送できる。
任意設定のreplayは通常実行との型のUnionを維持し、有効・無効の両方を実行する。
Node型なしの配布宣言検査と既存の接続ミス診断も採用の検査対象に含める。
型注釈の省略と引き換えに入力・成功・失敗型をanyやunknownへ広げる変更は採用しない。

この調査は講演の中心にある書き心地を改善するための実装調査であり、
講演の全内容の完全実現や独立利用者による開発体験評価の証拠ではない。
保存JSONは採用前の宣言に対する履歴であり、スクリプトを変更後のsrcで再実行すると
currentも成功する。採用前の再現にはcommit b15175dのスクリプトとsrcを使用する。
