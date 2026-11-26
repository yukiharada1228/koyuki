# 入荷・返品・数量訂正を文脈の重複注釈なしで接続する

実際のreceipt-pipelineとApplication宣言では、在庫のための文脈型を重ねて指定する3つの注釈を削除した。
入荷・返品に続き、数量訂正も普通の関数を名前付き段階として直接接続する。
型引数で同じ在庫文脈を指定し直す方法ではない。業務関数の通常の型宣言まで不要にする保証ではない。
講演全体の完全実現、任意のgeneric推論、独立利用者の開発体験は引き続き未確認である。

## 実際の業務宣言

```ts
receive: [
  { name: 'run:1', rule: receiveDecision },
  { name: 'run:2', rule: includeReceivedStock },
],
return: {
  load: context.receipt<ReasonInput>,
  run: [checkReceipt,
    { name: 'run:2', rule: returnDecision },
    { name: 'run:3', rule: includeChangedStock }],
},
correct: {
  load: context.receipt<CorrectInput>,
  run: [checkReceipt,
    { name: 'revalidate-correction', rule: correctedQuantities },
    { name: 'correct-receipt-plan', rule: correctionPlan },
    { name: 'run:3', rule: includeChangedStock }],
},
```

これは[application.ts](../src/experiments/procurement/application.ts)の抜粋で、単独実行用のコードではない。
[別の取得方式](../src/experiments/procurement/context-application.ts)でも同じ訂正の段階を接続する。
名前付き段階は既存のname/ruleオブジェクトを使い、元の関数型をそのまま保持する。
step(name, rule)を通した場合にあらゆるgenericな相関を保持できるという保証ではない。

receiveDecisionとreturnDecisionはそれぞれwithInput(receiveOrder)、withInput(returnCheckedReceipt)。
[domain.ts](../src/experiments/procurement/domain.ts)の2関数は、必要なドメインの項目を制約とするTを受け取る。
stockやreceiptDepletionをドメインの引数制約へ追加していない。関数の本体と検証順序は維持する。

[訂正の接続用関数](../src/experiments/procurement/receipt-pipeline.ts)も、既存のreceiptCorrectionInputの入力型を
Parametersで再利用する。再検証と最終計画への投影に必要な業務上の型だけを宣言し、在庫型をimportしない。
受け取った追加の文脈をgenericなTで保持し、withInputが成功値と元の入力を組にする。
計画の投影はinputを引き継いだ新しい組をfreezeする。元の入力への参照を維持し、入力や前段の計画を書き換えない。

接続用のreceiveStockDecision/returnStockDecision/correctDecision/correctStockDecisionの4 Workflowを削除した。
従来の具体的なWorkflowは比較テスト内だけに残し、数量訂正を単一の互換関数へ隠してはいない。
数量検証のprivateなReceivedChangeを最終計画の投影が要求する契約も維持する。
withInputの署名・実行本体、coreの実行本体、新しい公開APIやruntime依存は追加・変更していない。

## 成功型と元の文脈を保つ条件

businessが入力のvalueにある計画と、後続のgeneric関数が返す計画の対応を確認する。
Change<accepted>へ在庫計画を加えても、成功型をChange<Receipt>へ広げない。

数量訂正では、出力のinputに渡すのは前の組全体ではなく、そのinputメンバーである。
再検証のprivateな数量証明を最終計画から取り除く場合も、元の入力まで失う必要はない。
従来は、入力と出力が同一ではないと判断した時点でこの補正へ進まず、広い型を返していた。
現在は、同一性の検査で保持できない場合も、下記の契約で組のinputを検査する。

宣言済みの成功・失敗型を固定してから候補を作る。
候補は元の成功型の部分型であり、**実際の関数がその入力に対して候補を返すと保証する場合だけ**保持する。
次の関数が要求する型だけを根拠に状態やclassの事実を補わない。
通常関数が広い状態・入力を返す場合や、その関数を含む動的な候補は、狭い型を要する後続へ接続できない。
関数が追加する検証済み情報も候補から削除しない。

## 確認する契約

[business-input-pair.test.ts](../src/business-input-pair.test.ts)では、投影の状態型・失敗停止に加え、次を確認する。

- 中間の検証印を取り除く投影でも、元のprivateなclassを保存まで保持する。
- 元の入力への参照・組のfreeze・全エラー型・段階名・選択観測・保存回数を維持する。
- inputに追加された検証済み情報を削除しない。
- monomorphicな広い戻り型やunionから、存在しない文脈を推測しない。
- loaderにないclassの事実を組の引き継ぎによって捏造しない。

新しい元入力の厳密型の検査は、修正前の宣言でTS2344となり、修正後に成功することを確認した。
[訂正の比較](../src/procurement-correction-decomposition.test.ts)では、互換関数・旧来の注釈付きの平らな接続・
具体的なWorkflowのrun・公開Workflow・新しい直接接続の5方式で、独立した期待計画と失敗停止を比較する。
これは5人の独立利用者による評価ではない。

既存の購買検査でも、公開操作のaccepted/returned/accepted、詳細結果、広い過去の再送型、
検証済みcurrent/order、保存計画、メモリ/SQLiteの成功・失敗・例外・観測を維持する。
成功130境界・代表失敗274境界・I/O72位置178注入というシナリオは変更していない。
構成図のグループは4つのWorkflowから直接の段階へ変わるため、同じ構成オブジェクトとはしない。

ソース診断は、対象5ファイルで6 businessと2 Workflowの計8宣言・25操作ID・52ラベルを解決し、
診断・未解決は0。applicationだけでは7ラベルを解決し、41箇所が未解決のままである。
宣言数の減少は業務操作や観測の削除ではない。

リポジトリ全体は1,137件、配布物のconsumerは各compilerで793件を検査する。
配布物の15不正宣言と、生成関数を広い型へ戻す対照検査も継続する。

## 残る課題

配列内のwithInput直接呼出し、一般の多相変換、名前付きstep helperを介するgenericな相関は別の制約がある。
業務上の前提・順序・入力構築・計画の投影は引き続き利用者が宣言する。
独立利用者の試用と原音確認も未完了であり、保守者の検査を学習負担や生産性の優位性の実証とはしない。
