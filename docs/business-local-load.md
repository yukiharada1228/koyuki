# 全操作が取得方法を持つなら共通loadは省略する

業務操作ごとに入力や取得方法が異なる場合、すべてを個別のloadで宣言できる。
この場合、使われない共通loadを書く必要はない。新しいbuilderや実行APIは追加しない。
公開alpha.5ではなく、ソースからbuildする開発版の機能。

```ts
import { business, ok } from 'koyuki';
const reports = business({
  name: 'reports.v1',
  save: async (value: number) => ok(value),
  operations: {
    total: {
      load: async (input: { amount: number }) => ok(input.amount),
      run: [(amount: number) => ok(amount)],
    },
    length: {
      load: async (input: { text: string }) => ok(input.text),
      run: [(text: string) => ok(text.length)],
    },
  },
});
const amount = await reports.total({ amount: 100 });
const length = await reports.length({ text: 'abc' });
console.log(amount, length);
```

この例は接続を示すもので、DB・認証・実際の集計仕様を実装したものではない。
入力・loadの成功と失敗・Ruleの隣接型・保存契約の検査は従来どおり維持する。
普通の非同期Result関数と、Process等の詳細loaderの両方を指定できる。
共通generic saveでの成功型の保持、capture、再送のsave/lookup contextにも同じ規則を適用する。

`operations: { submit: [validate, submit] }`のような配列形式の操作が一つでもあれば、
その操作の取得方法として共通loadが必要。その場合の省略は型検査で拒否する。
一つの個別loadを、他の操作へ暗黙に流用しない。空の操作テーブルではloadは不要。
型を通さないJavaScriptから共通loadなしの配列操作を渡すと、宣言作成時に
BusinessRequiresSharedLoadをthrowし、操作ID resolverや業務処理は呼び出さない。

全操作が個別loadを持つ場合、共通loadを指定してもそのプロパティは読まない。
配列操作がある場合は宣言作成時に共通loadを一度取得し、参照を保持する。
途中で設定を書き換えても、既存の操作の実行先は変わらない。

[検査](../src/business-operation-table.test.ts)は、異なる入力の普通/詳細loader、
generic saveの成功型、load失敗時の保存停止、capture、数値名の再送とcached時の非実行を確認する。
欠けた共通load、混在テーブル、unknown入力のRuleによる迂回、不正な隣接型も拒否する。
同じ検査を実tarballの独立consumerでも実行する。
[100/500操作の検査](business-scale.md)も共通loadなしの定義へ適用した。

この改善は不要な宣言を一つ除く。generic requireの推論制限や、独立利用者の開発体験の実証が
解消したという意味ではなく、講演全体への部分充足という判定は維持する。
