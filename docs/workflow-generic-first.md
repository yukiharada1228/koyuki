# generic関数をWorkflowの先頭へ置く

開発版のworkflowの型宣言を拡張した。generic関数の宣言した制約を入力型として扱える場合に、
その関数やwithInputを追加の文脈注釈なしで先頭へ置ける。実行本体は変更していない。

```ts
type Base = Readonly<{ amount: number }>;
function quote<T extends Base>(value: T): Result<number, 'Declined'> {
  return value.amount > 0 ? ok(value.amount * 2) : err('Declined');
}
const flow = workflow('quote', withInput(quote))
  .then('total', pair => ok(pair.input.amount + pair.value));
```

flowの入力はBase、成功型はnumber、失敗型はDeclinedである。
quoteを直接渡す形式、withInputを変数へ束縛する形式、そのinline呼出しを検査する。
先頭のgeneric検証がprivateな証明を追加する場合も、次の業務関数へその証明を渡せる。
businessへ接続した場合の要求・保存型と失敗停止も確認する。

## 宣言した制約を越えない

上記のinput/valueの組が約束するinputはBaseであり、currencyやhostメソッドは追加されない。
実行時に追加属性を持つ値を渡しても、それらを戻り値の型へ自動復元するものではない。
[具体的な前段を持つ場合](workflow-context-inference.md)とは条件を区別する。
購買の入荷・返品・訂正で必要な3つの文脈注釈は残す。

元の文脈付き推論を優先し、それが成立しない場合に実際の関数型から入力・成功・失敗を計算する。
宣言した入力をすべての関数候補が受け取れることも検査する。
同じ入力の候補は全成功/失敗型を保持するが、互いに異なる入力しか受け取れない候補を、
単に入力型のUnionとして呼べることにはしない。
非同期関数・Resultではない戻り値・privateな前提証明の欠落も拒否する。
通常のParameters/ReturnTypeによるworkflow自体の型参照は従来の署名へ維持する。
任意の型レベル変換・値との対応・業務仕様の正しさを証明したものではない。

## 変更前後の検査

[生の比較記録](workflow-generic-first-inference.json)には、同じ正例を使う変更前後の比較と、
既存の9つの推論例の再検査を保存する。
[調査器](../scripts/investigate-workflow-first.mjs)はcommitのソースをgit archiveで一時フォルダーへ展開する。
利用者の作業ツリーをcheckout/resetせず、両方の既存型契約が通ることを先に確認し、
その後に同じ[正例](../scripts/fixtures/workflow-generic-first.ts)を追加して比較する。
依存定義が一致する場合だけ現在の依存を共有し、compiler・collector/probe・source archiveのhashを記録する。

```sh
node scripts/investigate-workflow-first.mjs \
  --before 08e87ed4f97f71ee3390aa59cbafff2d963c9d6b \
  --after cc1f3b8250edaa4f9d4b07547e27f3dacff64064
```

正例は入力Base、中間のReadonlyなinput/value、成功/失敗、businessでの結果を厳密に照合する。
変更前は不受理、変更後は受理で、既存ソースの追加診断は0だった。
静的な型検査であり、runtimeテストや独立利用者の評価を実行した記録ではない。

[専用検査](../src/workflow-generic-first.test.ts)は、成功・失敗停止・入力参照・組のfreeze、
businessと候補関数のUnion、generic検証からのprivate証明も扱う。
型検査では追加属性の捏造、証明の混同、非同期/非Result、不適合候補を拒否する。
配布物consumerとNode globalなしの実行、既存の生成100/500操作の検査も継続する。

## 未解消の範囲

再検査した9例のうち、元の名前なしinline、businessのgenericな入力の組、多相identityの例は不受理のままである。
以前のworkflow-input-pair-firstは、BaseにないContextの属性を要求するため、今回の対応後も不受理となる。
その不受理を、Baseだけを使う今回の正例の不受理と混同しない。
9例の再検査と比較後の追加証明検査は異なるcommitに基づくが、framework実装と設定・依存定義の差分がないことを記録する。
独立利用者の試用、原音確認、全講演の完全実現は未完了のままとする。
