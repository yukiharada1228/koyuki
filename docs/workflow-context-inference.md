# 具体的な前段がある場合のgeneric関数の接続

Workflowの直接接続と数量訂正の移行後に、型推論の対応範囲を再点検した。
新しいAPIやcoreの型宣言は追加していない。既存のthenで使える場合と、依然として通らない場合を分ける。

## 追加のcallback注釈なしで通る条件

業務上の前段が、後続に必要な具体的な文脈を既に保証する場合である。
[検査](../src/business-workflow-context.test.ts)では、currencyという通常の業務関数がContextを受け取り、
通貨を検証して同じContextを返す。quoteはamountだけを必要とするgeneric関数である。

```ts
const quoted = withInput(quote);
const flow = workflow('currency', currency)
  .then('quote', quoted)
  .then('finish', pair =>
    ok(`${pair.input.currency}:${pair.input.host()}:${pair.value}`));
```

quoteの位置は、withInput(quote)のinline呼出しでも、withInput(value => quote(value))でも通る。
いずれも接続用callbackへContextを繰り返し注釈しない。
通常関数の引数・戻り値、モデルの型まで不要になったという意味ではない。
中間段階が`Result<Readonly<{ input: Context; value: number }>, ...>`と厳密に一致することも検査する。
最後に文字列を作れることだけで成功とせず、anyや広いBaseへ変わっていないことを確認した。
businessでの要求・成功・宣言した全エラー型、通貨不正と金額不正での停止、成功時の保存も検査する。
monomorphicな関数がBaseだけを返す場合は、Contextのhostメソッドを保持したことにはできない。

## 残る制限

- 具体的な前段なしでgenericなquotedをWorkflowの先頭へ渡す例は、現在も不受理。
- businessの普通の関数列で、genericな入力の組の対応を中間型計算へ渡す元の例も不受理。
- 名前なしinlineのdefineTransitionと、多相identityを名前付きStepにする元の例も不受理。
- 具体的なContextを注釈した名前付きStepは、対応済みの範囲として引き続き受理される。

前段が具体的な文脈を持つという条件は、任意のgeneric関数の型を適用できることとは異なる。
購買の3つのwithInputは、Workflowの最初の型や入荷だけの関数にはない在庫文脈を指定する必要があるため変更していない。
この正例を理由に、3つの文脈注釈まで削減できたとはしない。

## 来歴と再現

[生の9報告](workflow-context-inference.json)へ、collectorの結果を保存した。
最初の5報告はa7e188caba726edb28e96342c32c6071d473171d、追加4報告は2b3bf1fb377bf2596803ba3d3595f53e90fee5aeを基準とする。
両commit間のsrc/framework・tsconfig・package/lockには差分がないことを確認する。
調査器と型fixture・検査は異なるため、同じソース全体での測定とは呼ばない。
全報告で既存の型契約の追加診断は0。runtimeテストの実行や、独立利用者の評価を表す項目ではない。

| probe | 判定 | 基準 |
| --- | --- | --- |
| inline | 不受理 | a7e188c |
| business-input-pair | 不受理 | a7e188c |
| business-input-pair-inline | 不受理 | a7e188c |
| business-input-pair-named-step | 受理 | a7e188c |
| generic-identity-named-step | 不受理 | a7e188c |
| workflow-input-pair-bound | 受理 | 2b3bf1f |
| workflow-input-pair-inline | 受理 | 2b3bf1f |
| workflow-input-pair-callback | 受理 | 2b3bf1f |
| workflow-input-pair-first | 不受理 | 2b3bf1f |

各報告はcommit、関係するソースのdirty状態、collector/probe/modelのhashとcompiler版を持つ。
dirty判定は調査器が指定したソース群の範囲であり、全作業フォルダーが空という意味ではない。
共通のminimal欄は元の言語上の再現例であり、その不受理を各probeの不受理と混同しない。
probeAcceptedと既存契約の診断を分けて読む。

```sh
node scripts/investigate-transition-inference.mjs --only current --probe workflow-input-pair-bound
node scripts/investigate-transition-inference.mjs --only current --probe workflow-input-pair-inline
node scripts/investigate-transition-inference.mjs --only current --probe workflow-input-pair-callback
node scripts/investigate-transition-inference.mjs --only current --probe workflow-input-pair-first
```

調査は一時コピーで行い、対象の作業ツリーを変更しない。再現時は対応する基準commitとcompilerを確認する。
3形式のruntime/型検査は開発版tarballのconsumerにも含める。
iz-24・qbf-19の記述負担に対する条件付きの対応例であり、未解消の推論制限・独立利用者の試用・原音確認は残る。
