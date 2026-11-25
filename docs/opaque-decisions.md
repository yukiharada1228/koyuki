# 業務の決定値と診断用の計画を分離する

開発版のrendererを指定しないbindMutation / defineCommand / businessでは、
純粋な関数が生成した成功値をそのままsaveへ渡す。
診断用の計画をJSONとして表現できることを、業務の実行条件にしない。
追加の宣言APIや実行時依存は導入していない。

## 実際のSymbol属性を持つ検証済みの値

```ts
import { business, ok, err, type Result } from 'koyuki';
const validated: unique symbol = Symbol('validated');
type Validated = { readonly amount: number; readonly [validated]: true };
const validate = (amount: number): Result<Validated, 'InvalidAmount'> =>
  Number.isSafeInteger(amount) && amount > 0
    ? ok({ amount, [validated]: true }) : err('InvalidAmount');
const stored: number[] = [];
const app = business({
  name: 'amount',
  load: async (amount: number) => ok(amount),
  save: async (value: Validated) => { stored.push(value.amount); return ok(value.amount); },
  operations: { change: [validate] },
});
const report = await app.change.runDetailed(2);
// result: ok(2)
// plan: { kind: 'write', operation: 'amount.change', inputStatus: 'unavailable' }
```

型だけに付けるphantom brandと異なり、この例では本当にSymbol属性がある。
以前は保存ノードの照合がSymbolInputで拒否していたが、通常経路ではその制約を取り除いた。
saveが受け取るのはcloneしたDTOではなく、業務関数の実際の成功値である。
private fieldやメソッド、関数、循環参照もこの引き渡しでは失わない。
実際のDB保存形式・シリアライズ・副作用の意味は引き続きadapterが決める。

## 診断情報の扱い

通常の有限数・文字列・boolean・null、plain objectと密な配列の列挙可能なdata属性は、
従来と同じwrite計画のinputとしてsnapshotする。save中に元の値が変わっても計画は変わらない。
共有参照はstructuredCloneのsnapshot内で維持し、計画の変更で実際の決定値を変更できない。

診断用のplain dataとして安全に扱えない場合はinputを省略し、inputStatus: unavailableを返す。
Symbol属性を落とした部分的なinputや、クラスのメソッドを失ったinputを成功snapshotとして返さない。
getter、非列挙属性、特殊なオブジェクト、循環参照、疎な配列等もこの形式になる。
標準のdata descriptorを調べてからコピーし、通常のオブジェクトのgetterを呼ばない。
Proxyのtrapなど、任意のユーザーコードの無副作用性を保証する仕組みではない。
診断の検査・cloneで例外が起きても、例外文や元の値を計画へ埋めず、saveは実行する。

型は既存のActionReport.plan: unknownのまま。取得不可でも業務結果・段階traceは返す。
API利用者は、すべての計画にinputがあるとは仮定せずinputStatusを確認する。
必要な値はrunDetailedのcaptureで明示的に選択できる。Symbol属性の有無をbooleanとして
観測する等、booleanや数値などのDTOへ投影すればよい。captureの失敗も業務結果とは分離される。

## 実行経路と残る境界

rendererなしでは外部の保存ノードを選択できないため、workflowの成功値を直接saveへ渡す。
rendererを指定した既存のView経路は、登録済みの保存能力・決定値の一致を引き続き確認する。
別のbindingのノード、偽造したノード、変更した決定値を許可する変更ではない。
この明示的なView経路には従来のJSON照合の制限が残る。

replayのrequest snapshotは別の[要求データの契約](replay-request-snapshot.md)を持ち、情報を失うコピーは照会前に拒否する。
host固有のfingerprint・永続receiptの形式は変更しない。
JSONの要求からSymbol付きの決定を作り、saveでDTOへ変換して再送する例を検証する。
一方、関数付きの要求などstructuredCloneできない入力は、replayのsnapshot時点で従来どおり拒否する。

Applicationのイベント・状態の所有境界もstructuredCloneのまま。
Symbol属性やクラスのメソッド・private fieldが、その境界を通って同じ形で残る保証はない。
Applicationや永続adapterへ渡す部分には必要なDTOを用意する。
今回の改善を、全層で任意のオブジェクトを自動永続化・復元できる保証にはしない。

## 検証

[opaque-decisions.test.ts](../src/opaque-decisions.test.ts)の18テストで3つの入口を検査する。
opaque値の参照・機能の保持、getterを呼ばないこと、診断の例外とclone失敗、
通常のsnapshotの独立性・共有参照、保存の期待失敗・予期しない例外、選択値観測、
再送のsnapshot、明示的なrendererの制限を対象とする。
実tarballの独立consumerにも同じ検査を含め、Node globalsなしのbrowser bundleでも
Symbol属性とprivate field付きのクラスをsaveへ渡すことを確認する。

```sh
npm run check
npx tsx --test src/opaque-decisions.test.ts
npm test
npm run test:business:package
npm run check:package
npm run test:portable
```
