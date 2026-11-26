# 入荷・返品を文脈注釈なしで直接接続する

入荷と返品では、在庫のための文脈型をwithInputのcallbackへ重ねて指定する必要がなくなった。
数量訂正の一つの注釈は残る。任意のgeneric推論や、講演全体の完全実現という判定ではない。

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
```

これは[application.ts](../src/experiments/procurement/application.ts)の抜粋で、単独実行用のコードではない。
receiveDecisionとreturnDecisionはそれぞれwithInput(receiveOrder)、withInput(returnCheckedReceipt)。
名前付き段階は既存のname/ruleオブジェクトを使い、元の関数型をそのまま保持する。
step(name, rule)を通した場合にあらゆるgenericな相関を保持できるという保証ではない。

[domain.ts](../src/experiments/procurement/domain.ts)の2関数は、必要なドメインの項目を制約とする
Tを受け取る。stockやreceiptDepletionをドメインの引数制約へ追加していない。
関数の本体、成功・失敗型、検証順序と保存計画は維持する。
withInputの署名や実行本体も変更していない。

接続のためのreceiveStockDecision/returnStockDecisionのWorkflowは削除した。
数量訂正のWorkflowと内側の二段階は維持し、単一の互換関数へ隠してはいない。

## 成功型を広げないための補正

businessが、入力のvalueにある計画と、後続のgeneric関数が返す計画の対応を確認する。
例えば、Change<accepted>へ在庫計画を加えても、成功型をChange<Receipt>へ広げない。

宣言済みの成功・失敗型を固定してから、valueのメンバーに基づく候補を作る。
候補は元の成功型の部分型であり、**実際の関数がその入力に対して候補を返すと保証する場合だけ**保持する。
次の関数が要求する型だけを根拠に状態を補わない。
通常関数が広い状態を返す場合や、その関数を含む動的な候補は、狭い状態を要する後続へ接続できない。
関数が追加する検証済み情報も候補から削除しない。

## 確認する契約

[business-input-pair.test.ts](../src/business-input-pair.test.ts)の追加2件で、次を確認する。

- 名前付きgeneric投影から保存までacceptedの状態型と全エラー型を保持する。
- 計画の失敗・在庫の失敗は後続と保存を停止する。
- 実行名と保存回数を独立した期待値と比較する。
- 投影が追加した検証済み情報は残し、monomorphicな広い戻り型は勝手に狭めない。
- 広い投影やそのunion候補から、狭い状態を要する後続への接続を拒否する。

既存の購買検査でも、公開操作のaccepted/returned/accepted、詳細結果、広い過去の再送型、
検証済みcurrent/order、保存計画、メモリ/SQLiteの成功・失敗・例外・観測を維持する。
成功130境界・代表失敗274境界・I/O72位置178注入というシナリオは変更していない。
構成図のグループは二つのWorkflowから直接の段階へ変わるため、同じ構成オブジェクトとはしない。

ソース診断は、対象5ファイルで6 businessと4 Workflowの計10宣言・25操作ID・52ラベルを解決し、
診断・未解決は0。applicationだけでは4ラベルを解決し、42箇所が未解決のままである。
宣言数の減少は業務操作や観測の削除ではない。

リポジトリ全体は1,134件、配布物のconsumerは各compilerで790件を検査する。
配布物の15不正宣言と、生成関数を広い型へ戻す対照検査も継続する。

## 残る課題

数量訂正は、成功した入荷計画を元の訂正文脈と組にして次へ渡すため、まだ具体的な文脈注釈が一つ必要。
それを別の型引数やラッパーへ移しただけで削減済みとは数えない。
配列内のwithInput直接呼出し、一般の多相変換、独立利用者の試用、原音確認は別の残件である。
今回の保守者による検査は、学習負担や生産性の優位性の実証ではない。
