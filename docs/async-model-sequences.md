# 非同期比較でも同じ反例を縮める

開発版koyuki/testingのsampleModelAsyncは、非同期の実装比較を待ちながら、
sampleModelと同じ生成・seed・操作削除の処理を使う。
events・step・invariant・acceptsは同期の参照仕様のまま、checkだけがbooleanまたはPromise<boolean>を返す。

```ts
import { sampleModelAsync } from 'koyuki/testing';

const implementation = async (before: number, amount: number) => before + amount;
const result = await sampleModelAsync({
  initial: [0], seed: 42,
  limits: { cases: 10, length: 20, shrinkAttempts: 100 },
  events: () => [1, 2],
  step: (before, amount) => ({ state: before + amount, output: before + amount }),
  check: async (before, amount, expected) => await implementation(before, amount) === expected.output,
});
console.log(result.kind);
```

比較は一つずつawaitする。同じモデル・seed・booleanの比較結果なら、同期版と
生成列、反例、縮小状態、回数が一致する。checkがrejectすれば、元のcauseを保った
phase:checkのdefectとなり、その比較を黙って再試行しない。
同時に複数のsamplerを動かしても、乱数や現在の状態をglobal変数で共有しない。
既存のsampleModelの戻り値は同期のままである。

## 外部状態を隔離するのはテスト側

checkには比較対象のbefore・event・expectedを、それぞれ所有したコピーで渡す。
一方、DB・接続・メール等の外部状態を自動でrollbackしたり、初期化したりはしない。
checkは各before状態を独立に再現してから比較し、必要なfixtureをfinally等で片付ける。
生成中も縮小中も同じcheckが呼ばれるため、直前の候補のDB状態をそのまま使う契約ではない。
checkが外部I/Oを含む場合、callbackの終了・隔離・後片付けは利用側の契約である。
timeout・強制キャンセル・実運用への副作用の取り消しは提供しない。

[タグの検査](../src/tag-model-sequences.test.ts)はこの契約の実例。
各比較で新しいメモリ/SQLite fixtureを作り、beforeに指定したラベル・versionを
正しい経路で復元する。その後に対象操作を実行し、結果と保存状態を独立仕様に照合し、
finallyで閉じる。破棄された候補の書込みを次の候補へ混入させない。

通常のadapterではsampledとなる。古いversionを無視する故意のwrapperを挟むと、
両adapterでcreate→stale renameの反例が出る。
各1操作の削除では同じ不一致が残らないことを、実際に候補を比較して確認する。
fixtureを開いた数と閉じた数も一致することを検査する。
これは保存adapterの実際の欠陥の報告ではなく、故意の変更を検出する検査である。

## 保証の限界

sampledは全状態の証明ではない。one-deletion-minimalは、受け付ける各1操作の削除で
同じ理由の反例が残らないという意味であり、全候補での最短ではない。
上限に達すればlimited、モデルや比較が壊れればdefectとして区別する。
[payloadの候補](event-payload-shrinking.md)はshrinkEventで指定できる。初期状態の縮小やテスト雛形の生成は未提供。
SQLiteのfixtureは:memory:で、ファイル永続化や別接続競合まで証明しない。
同期/非同期の一致、非同期例外、同時実行、所有コピー、実adapterの反例を
[unit検査](../src/model-sequences.test.ts)とタグの検査で確認し、実tarballにも同じ検査を含める。
