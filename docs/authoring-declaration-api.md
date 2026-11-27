> 依存取得とイベント配送まで任せる場合は、[needs / emits / Onの宣言形式](declarative-connections.md)を推奨します。以下の関数factoryによるload/execute/saveの入口は、個別の取得やProcessを直接組み立てる場合にも利用できます。

# 操作を一度宣言し、登録と実行で共有する

対象は開発版 `koyuki/experimental`。npm公開済みalpha.5のAPIを変更したものではない。React互換性や再描画の追加を目的にせず、既存の関数型の核と実行エンジンを維持する。

## 推奨する書き方

```tsx
import {
  h, defineOperation, Operation, createApplication, useContext,
} from 'koyuki/experimental';

const approval = defineOperation('expense.approve.v1', () => {
  const expenses = useContext(ExpenseRepositoryContext);
  const actor = useActor();
  return {
    load: (input: Input) => expenses.load(input, actor),
    execute: approveExpense,
    save: change => expenses.save(change),
  };
});

// Repositoryと操作者を渡すProvider内で登録する。
function ApproveExpense() {
  return <Operation operation={approval} />;
}

const app = createApplication(<Expenses repository={repository} actor={actor} />);
// 結果だけ必要なら app.execute(approval, input) を選ぶ。
const report = await app.executeDetailed(approval, input);
```

executeとexecuteDetailedは、どちらも取得・計算・保存を実行する。結果とtraceの両方が必要ならexecuteDetailedだけを呼び、report.resultを読む。実行済みの結果を調べるためにもう一度呼ばない。

defineOperationは、操作の名前と同期のカスタムHookを保持する。宣言時にはHookを呼ばない。OperationをProviderの内側で評価するときに初めてHookを呼び、既存の実行エンジンへ接続する。load・業務関数・saveは明示的な実行まで呼ばない。部品やHook内に利用者が直接書いた副作用まで防ぐ機能ではない。

Hookの返す定義にはnameを書かない。名前はdefineOperationの一箇所にあり、内部の保存・trace名にも使われる。名前の二重指定は型検査で拒否する。Contextは実行時に再参照せず、同期評価中に確保したRepository・操作者をクロージャで渡す。

approveExpenseは従来の `workflow(...).then(...)` による通常の業務関数の合成であり、Hooksなしでも実行できる。Processによる途中I/Oや詳細load、再送のreplay設定もそのまま定義へ渡せる。replayがある場合はExecution/ReplayReportを推論し、保存には原子的なreceiptを返すadapterを要求する。

## 破壊的変更と移行

| 削除した入口 | 現在の入口 | 移行 |
| --- | --- | --- |
| useOperation / operationKey / replayOperationKey / JSXのhandler prop | defineOperation + Operationへの登録 | 名前とHookを一つの宣言へ集約 |
| app.dispatch | app.execute | 呼出し名を変更。互換aliasなし |
| app.inspect | app.executeDetailed | 呼出し名を変更。captureの第3引数は引き続き利用可能 |
| OperationKey / DeclaredOperation型 | BusinessOperation型 | 宣言から推論するため通常は明示不要 |

この変更はexperimentalのcreateApplicationが対象。別の入口であるcoreのdefineApplicationの操作名まで一括変更していない。inspectは純粋なWorkflow側にも存在するため、そちらの意味も変更しない。

宣言した操作の `.use` は、別のカスタムHookで再利用できる同期Hook。例の旧useExpenseApproval等の互換exportも削除した。通常の登録・実行では別名を作る必要はない。React互換性のためのAPIは追加していない。

## 経費・休暇・登録での比較

比較基点は `47012ba67707a5b9ca0bf2463bddfad9c1b430ef`。再送版経費・再送版休暇・会員登録の3ファイル、4操作の実ソースを比較した。[計数とhash](authoring-declaration-comparison.json)を残す。

| ソース内の記述 | 変更前 | 変更後 |
| --- | ---: | ---: |
| 手書きのoperationKey呼出し | 4 | 0 |
| useOperation呼出し | 4 | 0 |
| JSXでのhandler接続 | 4 | 0 |
| defineOperation呼出し | 0 | 4 |
| JSXのOperation登録 | 4 | 4 |
| 操作名の文字列 | 4 | 4 |

操作名は以前も文字列として一度だけ定義されていた。今回なくしたのは、名前の定数をHookとキーへ引き渡す記述、別のキー作成、handlerの接続である。宣言とJSX登録の2箇所で、その同じ値を実行にも使う。業務部品とProviderの宣言は残り、ソース全体から全宣言が消えたとはしない。

入力・成功・エラー型の型引数、Hookの戻り型注釈は追加していない。状態・業務関数の通常の型、Repositoryの契約、再送identityを作る関数は残る。業務の順序・信頼境界・保存の原子性を推測で補わない。これは保守者AIの具体例の評価であり、人間の初回利用の分かりやすさや開発速度の実証ではない。

## 検証

- 全ソース型検査と関連45件の実行テスト。宣言時I/Oなし、Providerの捕捉、失敗停止、個別ルールのlive span、capture、再送の省略、旧入口が公開されていないことを確認。
- 全1270件の実行テスト。
- 実tarball上でTypeScript 6/7のNode型なしの型検査・宣言生成・宣言だけを読むconsumer。操作の入力・エラー・capture・再送reportを維持。
- 不適合な段階、認可の欠落、不適合なsave、Executionを返さない再送保存、非同期の定義Hook、名前の二重指定を型検査で拒否。
- 同じ配布物で経費・休暇・登録のSQLite統合を実行。DB再接続・同時要求・rollback・Provider分離を維持。
- 新しい宣言・自動登録・executeDetailedをNode globalなしのVMで実行。公開runtimeは29 module、外部依存ゼロのまま。

これらは今回のAPI整理の証拠であり、講演の原音未確認や全内容の完全反映の判定を変更するものではない。

## 操作名とHookの契約

同じアプリ内では、別の宣言や別のProviderでも同名の操作登録を拒否し、`DuplicateOperation:名前`を投げる。重複側のHookは評価しない。別のアプリ間では同名を許可する。実行時の照合は引き続き宣言オブジェクトによるため、同名の別オブジェクトをexecuteへ渡しても登録済み操作を呼べない。

`.use()`は呼ぶたびに現在のProviderから新しいハンドラーを組み立てる。状態保持・キャッシュ・再描画は行わず、登録もしない。通常の利用ではOperationへの登録だけでよい。組み合わせる場合は返されたハンドラーをProcessに渡すと、内部のルールまでtraceが残る。

```ts
function useApprovalAndNotification() {
  const approvalHandler = approval.use();
  return process<Input>()
    .effect('approve', approvalHandler)
    .effect('notify', notifications.send);
}
```

これは承認の保存後に通知する逐次処理であり、二つの保存を一つのtransactionにするものではない。通知の失敗で承認を巻き戻さない。原子性が必要なら一つのsave内で状態とoutboxを保存する。再送が必要な承認には、replay設定のある操作のハンドラーを使い、通知側にも適切な再送境界を設ける。`handler.run`だけを通常の非同期関数として渡すより、ハンドラー全体を渡す方が内部traceを引き継げる。
