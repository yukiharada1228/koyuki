# withInputの入力保持をRule aliasでも比較できるようにする

a3ad25dでは、withInputの戻り型をRule aliasから同じ構造の関数型へ直接書き替えた。
実行本体・関数の引数・成功値と失敗値・pairのfreezeは変更していない。
新しいAPIやruntime依存を追加する変更ではない。

## 修正した問題

genericなwithInputを具体的なContextへ適用できるかを、conditional typeで検査する。
TypeScript 7.0.2では、直接の関数型との比較は通るのに、同じ意図のRule aliasとの比較は通らなかった。
戻り型を直接の関数型で宣言すると、両方の比較で元の文脈が保持される。

| 7.0.2での単独検査 | 修正前 | 修正後 |
| --- | --- | --- |
| literal関数型による入力保持 | 受理 | 受理 |
| Rule aliasによる入力保持 | 不受理 | 受理 |

通常record、公開フィールドのclass、privateフィールドのclassのすべてで同じ結果を確認した。
privateフィールドの有無だけを原因とする仮説は支持されない。
compiler内部の原因や、どちらのcompilerが仕様上正しいかを断定するものではない。

## 根拠と検証

- cd03072の[6.0.3](with-input-context-shapes6-before.json)・[7.0.2](with-input-context-shapes7-before.json)：同じ12形式で文脈の形を比較。
- 1bea178の[関数署名の比較](with-input-signatures7.json)：引数だけの展開では改善せず、戻り型の展開で単独のRule比較が通る。businessの中間型補正との併用も別に検査した。
- a3ad25dの[修正後7.0.2](with-input-context-shapes7-after.json)：3種類とも単独の両比較が通る。
- 同じa3ad25dの[差し戻し対照](with-input-regression-control7.json)：modelのhashが修正前と一致する候補へ戻すと、新しい入力保持の契約がTS2344で失敗する。現行のbaselineは成功。
- `business-workflow-context.test.ts`へ、publicなRule aliasでの入力保持と、広い通常関数の出力を勝手に狭めないコンパイル時の契約を追加。

前者の契約は修正前にTS2344で失敗し、修正後に成功することを確認した。
既存の3つのWorkflowの実行検査は、privateな文脈の同一性・失敗停止・保存・traceを引き続き確認する。
全体1,127件、6.0.3と7.0.2のpack済みconsumer各783件、不正定義15件と既存の対照検査で確認する。
runtimeを二つ実装した件数でも、独立利用者の評価でもない。

```sh
npm run check
npm test
npm run test:business:package
npm run test:business:typescript6
```

collectorの過去の結果は各JSONのsourceGitCommitで再現する。
現在のcollectorは関数署名の比較にも対応し、既存契約で拒否された候補はそのbaselineを記録してprobeを省略する。
省略を受理と解釈しない。

## 残る問題

businessの関数列でgenericなinput/valueの相関を保持する正例は、修正後の7.0.2でも通らない。
recordへ替えるだけでも解消しない。単独の型比較の修正を、宣言全体の解決とは扱わない。
中間型を補正する候補は未採用。購買の3つの文脈注釈、一般のgeneric推論、独立利用者の試用は残る。
講演対応のpartialも維持する。
