# 最初の業務操作を作る

Koyukiは、純粋な業務判断と、取得・保存・アプリケーションの実行を接続する。
まずタグ作成で流れを確認し、経費精算で状態分岐と再送へ進む。

## 推奨する入口

| やりたいこと | 最初に使うAPI |
| --- | --- |
| 成功・想定内の失敗を返す | `ok` / `err` / `Result` |
| 検証・前提条件・遷移を宣言する | `step` と `{ validate, require, evolve }` |
| 取得→判断→保存を実行する | `defineTarget(...).on(...)` |
| 保存に要求IDなども渡す | `defineRequestTarget(...).on(...)` |
| 複数操作と実行状態・Viewを管理する | `defineApplication` / `operation` |
| 保存済み要求の再送を扱う | `withReplay` / `replayOperation` |

純粋な判断だけ試すなら`transition`を使える。
`workflow`、`defineAction`、`defineCommand`、`bindMutation`、`defineProgram`は、
低水準の組み合わせや実験用に残す。最初のアプリで全APIを覚える必要はない。
JSXは推奨構成の前提に含めない。

## 空のプロジェクトから始める

Node.js 22以上を用意し、空のディレクトリで次を実行する。

```sh
npm init -y
npm pkg set type=module
npm install koyuki@0.1.0-alpha.2
npm install -D typescript tsx @types/node
```

[最小サンプルのmain.ts](../examples/quickstart/main.ts)と
[tsconfig.json](../examples/quickstart/tsconfig.json)をそのディレクトリへコピーする。

```sh
npx tsc --noEmit
npx tsx main.ts
```

最終出力：

```json
{"tags":[{"id":"tag-1","name":"Koyuki"}],"busy":false,"error":"DuplicateTag"}
```

成功、空の名前の拒否、重複した名前の拒否を順に実行する。
最後のエラーはサンプルが意図的に作る業務エラーであり、実行失敗ではない。

リポジトリから試す場合は次でもよい。

```sh
cd examples/quickstart
npm install
npm run check
npm start
```

## 利用者が書く部分

サンプルでは`CreateTag`が未検証入力、`ValidInput`が検証後の入力、`Tag`が保存対象。
`TagName`はbrand付きで、単なるstringを代入できない。実行時の検証はvalidateが行う。

| 入力 | 操作 | 成功 | 失敗 |
| --- | --- | --- | --- |
| idと名前 | validate | 空でない検証済みの名前 | InvalidTag |
| 検証済み入力 | evolve | Tagを生成 | なし |
| Tag | save | 保存されたTag | DuplicateTag |

```ts
const created = {
  validate: step('validate-tag', validate),
  require: [] as const,
  evolve: step('create-tag', (input: ValidInput): Result<Tag, never> => ok({ ...input })),
};
```

loadは外部入力の取得、saveは保存を担う。サンプルは取得を必要としないためloadで入力を返す。
Koyukiはload→validate→require→evolve→saveを順に実行し、失敗したら止める。
呼出し側でResultを毎回確認して次の処理へ渡すコードは不要。

Applicationでは操作成功時にタグ一覧へ追加する関数と、公開するViewを定義する。
実行中・失敗・成功後の状態、失敗時の既存データ維持、dismissによるエラー解除はruntimeが管理する。
`dispatch`の返り値だけで業務成功を判定せず、`snapshot().view`またはstateを確認する。

メモリ保存は単一プロセスの例。DB版の一意制約・トランザクション、認証・認可は利用者が設計する。
HTTP境界で受け取るunknownの構造検証も別途必要。TypeScriptの型は外部入力を検証しない。

## 型エラーの読み方

[意図的に間違えた定義](../examples/quickstart/diagnostics/invalid.ts)は通常のサンプルの型チェックから除外し、
配布パッケージの検証スクリプトで個別にコンパイルしている。

| 間違い | 確認できた診断の要点 | 直す場所 |
| --- | --- | --- |
| runにnameを渡さない | Property 'name' is missing | 呼出し入力 |
| saveはnumberを受け取るがevolveはTagを返す | Type 'Tag' is not assignable to type 'number' | saveの入力型か遷移の出力型 |
| stringの検証結果をnumberの遷移へ接続 | Type 'string' is not assignable to type 'number' | 隣接するstepの入出力 |
| 未検証stringをTagNameへ代入 | Type 'string' is not assignable to type 'TagName' | validateを通す |

保存型の不一致は`.on(created)`に報告され、StepやNoInferを含む長い型が出る。
まず診断末尾の具体的な型の組み合わせを見る。専用の短い診断は現時点では提供していない。

## 次に読むもの

1. [経費精算](../examples/expenses/README.md)：直和型で申請・承認待ち・承認済み・却下を分ける。
2. [再送の実行境界](replay.md)：要求情報、原子的な成功記録、古い応答をViewへ反映しない方法。
3. [差し戻しと再申請](expense-correction.md)：複数周回と、利用側に残る定義。

経費の基本サンプルは比較用にalpha.1を固定している。
再送・修正のデモはリポジトリで`npm ci`後に実行する。経費のSQLite検証にはnode:sqliteが必要。

## 再現性の確認

ルートの`npm run test:quickstart`はpackしたパッケージを作業ツリー外へインストールし、
型チェック、実行結果、4種類の誤定義が拒否されることを検証する。
`npm run test:quickstart:registry`はnpmの公開済みalpha.2から同じ手順を再現する。
