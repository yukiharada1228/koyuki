# タグの変更スナップショットの再保存を生成する

[独立仕様](../src/tags/replay-model-testing.ts)は、タグ作成・名前変更に加え、
保存済みの変更スナップショットをもう一度保存する操作列を生成する。
既存のタグadapterが持つreceipt境界を検査し、新しい要求ID付きAPIは追加しない。

| 操作 | 独立仕様の期待 |
| --- | --- |
| 同じスナップショットを再保存し、対象がその版のまま | 同じ保存結果を返し、状態・版数を増やさない |
| 後の変更で対象の版が進んだ後に古いスナップショットを再保存 | SaveConflict。最新状態を巻き戻さない |
| 同じ変更のlabelを変えて再保存 | SaveConflict。保存状態を変えない |

期待値には、既存の独立したタグ参照仕様と、独立に記述したreceiptの規則を使う。
repositoryのreceipt・fingerprint・返却結果から期待値は作らない。
実IDはadapterごとに異なるため論理slotへ対応付け、ID・group・label・icon・version・sortOrderを比較する。

各比較では新しいfixtureを作り、モデルが保持する操作履歴からタグと変更スナップショットを
再構築する。反例の削除候補でも同じ手順を使い、比較後は必ず閉じる。
`accepts`は、削除によって参照するスナップショットがなくなった候補を除く。
業務上の拒否や古いversionを生成から除外する用途には使わない。
履歴を保持するため、列長に応じて再構築・コピーの負担が増える。大規模な無限履歴の検査ではない。

[到達と反例の検査](../src/tag-replay-model.test.ts)は、3 seed・各4試行・32操作、
adapterごとに384操作を比較し、表の3種類の再保存が実際に含まれることをassertする。
内容の変更を取り落とす故意のadapter不具合では、作成→変更して再保存の2操作を反例として得る。
縮小中もfixtureの生成・closeが対応することを確認する。
変更したスナップショットは、意図的な型アサーションでbrandを迂回する負例であり、通常の業務APIの書き方ではない。

同じ契約から[雛形生成](model-test-template.md)で出力した6テストを、
実tarballのconsumerで型検査・実行する。

```sh
node --import tsx --test src/tag-replay-model.test.ts
npm run build
npm run --silent generate:model-test -- --contract ./src/tags/replay-model-testing.js > generated-tag-replay-model.test.ts
node --import tsx --test generated-tag-replay-model.test.ts
```

対象は一つのfixture内で逐次行う、確定した変更の再保存である。
元のHTTP入力からの再ロード・要求ID・操作者の変更・応答喪失・並行競合・監査行数・保持期限を
この生成契約で検証したとはしない。要求ID付きの経費再送や既存の障害注入検査とは区別する。
sampledは指定した試行範囲での一致であり、すべての再送経路の証明ではない。
