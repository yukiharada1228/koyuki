# 申請の作成・編集も普通の関数列で宣言する

購買の実経路から、作成・編集の接続だけを担当していた2つのWorkflowを取り除いた。
業務の検証、明細の解析、計画の生成をApplicationの操作配列へ直接並べる。
これで購買Applicationと、そのrequest/receiptの補助モジュールに、接続用のWorkflow構築は残らない。
Workflowという既存APIを廃止する変更ではない。

```ts
create: [
  step('authorize-creation', checkRequestCreation),
  step('parse-lines', parsedRequestInput),
  step('create-request-plan', creationPlan),
],
edit: {
  load: context.request<EditInput>,
  run: [checkBuyerRequest,
    step('require-draft', checkRequestEdit),
    step('parse-lines', parsedRequestInput),
    step('edit-request-plan', editPlan)],
},
```

[request-pipeline.ts](../src/experiments/procurement/request-pipeline.ts)には、普通の関数とwithInputだけを置く。
明細解析の共通関数は「input.linesがある」ことだけを要求し、作成・編集の権限には依存しない。
withInputが元の文脈を成功値と併せて返し、businessが接続・失敗の伝播・保存を担当する。
作成と編集で別々に解析callbackを書く必要もなくした。

計画関数の入力は、それぞれ作成権限と編集可能な状態のprivateな証明を要求する。
単に解析へ成功しても、その証明を生成したことにはならない。
権限の検証やdraft状態の検証を省いたbusiness宣言は、型検査で拒否する。
この部分は型アサーションや広いanyを加えて通したものではない。

## 確認したこと

- [作成の検査](../src/procurement-request-creation.test.ts)と[編集の検査](../src/procurement-request-edit.test.ts)で、既存の独立した期待計画、拒否の順序、入力の非変更、メモリ/SQLiteの非保存を継続して比較する。
- 作成・編集で共通の解析関数を使っても、元の文脈・追加フィールド・privateフィールドを持つ値の同一性を保持する。組だけをfreezeする既存契約も確認する。
- 以前のWorkflow構築はテスト内の比較用にだけ残す。実Applicationがその比較用Workflowを呼んでいるわけではない。
- 購買25操作の3方式比較、成功130境界・代表失敗274境界、I/Oの72位置・178回の例外注入を維持する。操作やtraceの段階名を削って省略したことにはしない。
- 選択した5ソースの静的診断は、6宣言・25操作ID・52段階名を解決し、未解決と診断は0。Application単独では13段階名を解決し、39箇所は選択していないimport先の確認が必要になる。

リポジトリ全体は1,145件、実tarballの配布consumerはTypeScript 6.0.3/7.0.2それぞれ801件を検査する。
配布物の15不正宣言と、既存のfinance/order/receipt/storage対照検査も継続する。
上記の検証省略はconsumerへコピーした検査コードでも型エラーとして確認する。

型推論のための追加の文脈注釈、新しいframework API、coreの実行処理・依存関係の変更はない。
業務関数の通常の入力型、入力の投影、操作の順序、保存adapterの契約は引き続き開発者が指定する。
任意の多相変換、名前なしinlineの推論制限、独立利用者の評価、直接音声の確認を解消した変更ではない。
[講演に対する全体判定](lecture-acceptance.md)は部分充足のままである。
