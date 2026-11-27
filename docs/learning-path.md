# 普通のTypeScriptから業務部品へ

手元で動かす最初の入口は[Quick Start](../examples/authoring-quickstart/README.md)。このページは、そこで使う概念を導入する順序を説明する。

最初に全APIを覚える必要はない。単純なCRUDなら、普通の関数とRepositoryだけで十分な場合もある。

## 1. 業務関数を書く

入力状態と成功状態、起こり得る失敗を型で定義する。DB・JSX・Contextは登場させない。

```ts
function validateAmount(amount: number): Result<number, 'InvalidAmount'> {
  return Number.isSafeInteger(amount) && amount > 0 ? ok(amount) : err('InvalidAmount');
}
```

ここは普通のTypeScript。`Result`・`ok`・`err`は`koyuki`からimportする。金額の単位や上限、認可、どの状態を許すかは業務側の定義である。

## 2. 必要になったら合成する

```ts
const calculate = workflow('validate-amount', validateAmount)
  .then('add-tax', amount => ok(amount + Math.floor(amount / 10)));
```

隣接する関数の入出力の整合性を型で確認し、失敗後の段階を実行しない。Workflowは純粋性の自動証明器ではない。呼び出す関数がI/Oを行えば、その副作用は残る。ここまでをRepositoryやApplicationなしでテストできる。

## 3. 取得・計算・保存を宣言する

既存の業務関数に、`defineResource`で入力を供給し、`defineOperation`の`needs`・`execute`・`useSave`で接続する。実際の例は[予算付き経費精算](expense-budget-study.md)の`application.tsx`。取得・業務拒否・保存失敗のResultの伝播を、操作ごとに手で書かずに済む。

`useSave`は構成時に保存関数を返すHookであり、構成時に保存するものではない。Operationは普通の業務関数も受け取れるので、一つの関数を必ずWorkflowで包む必要はない。

## 4. JSXで業務を組み立てる

Repository・認証済みActor・設定をContextで受け、Providerで適用範囲を示す。業務コンポーネントが複数のOperationを登録する。実行は明示的な`execute`で行い、JSXの評価だけで業務I/Oを開始しない。

同じ業務ツリーを異なるActorで使う場合は[実行スコープ](execution-scopes.md)を利用する。HooksはReact互換の再描画機構ではなく、スコープ構成時に依存を捕捉するもの。Providerに共有可変オブジェクトを渡して後からActorを書き換えない。

## 5. 必要な運用契約を足す

競合検出、状態・outbox・成功記録の同時保存、永続イベントの配送とackは、Repositoryやホストとの契約である。Resultを返すだけでrollbackするわけではない。[予算例の保存契約](expense-budget-study.md)とテストを、自分のアダプターへ適用する。

`execute`は業務結果のResultを返す。Guardによる入口の拒否は`ExecutionDenied`でrejectし、実行通知と配送記録は`denied`。未想定のthrowもrejectするが記録は`defect`である。ホスト側でこれらをHTTPレスポンスなどへ変換する。フレームワークがHTTPステータスを自動決定するわけではない。
