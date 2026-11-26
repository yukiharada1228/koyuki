# 制約付きgeneric関数をそのまま名前付き段階にする

開発版のstepの型推論を拡張した。workflowでは通っていた制約付きgeneric関数の直接指定が、
stepではunknownの入力として扱われて拒否される例を解消した。実行本体は変更していない。

```ts
type Base = Readonly<{ amount: number }>;
function quote<T extends Base>(value: T): Result<number, 'Declined'> {
  return value.amount > 0 ? ok(value.amount * 2) : err('Declined');
}
const quoted = step('quote', quote);
const paired = step('quote-with-input', withInput(quote));
```

quoted.ruleの入力はBase、戻り値はResult<number, 'Declined'>である。
paired.ruleの成功値はReadonly<{ input: Base; value: number }>となる。
段階を作るためだけに(value: Base) => quote(value)というラッパーを書く必要がない。
withInputを変数へ束縛した形式とinline形式の両方を検査する。

## 接続と型の保証範囲

元の文脈付き推論を優先し、その署名で成立しない場合だけ実際の関数から入力・成功・失敗を計算する。
同じ入力を受け取る候補のUnionは全成功/失敗型を残す。
異なる入力しか受け取れない候補を、入力のUnionで自由に呼べるという扱いにはしない。
非同期関数・非Resultの戻り値も拒否する。
Parameters/ReturnTypeでstep自体を参照する場合は、元の署名を維持する。

genericな検証関数がprivateな証明を出力する場合は、それを次の業務関数へ渡せる。
検証の省略・別の役割の証明との混同は引き続き拒否する。
これは関数が宣言した証明を型として接続する保証であり、検証関数の業務内容や型アサーションの正しさまで証明しない。

[専用検査](../src/step-generic-first.test.ts)では、transition/defineTransition/businessへの接続、
途中の失敗停止、非保存、段階名、元の関数・入力の参照、withInputの組のfreezeも確認する。
同じ検査を実際の開発版tarballをinstallしたconsumerでも実行する。

## 変更前後の比較

```sh
node scripts/investigate-workflow-first.mjs \
  --before c7a8764776316828aeb10006567a893c9b03c70a \
  --after 59fd7589b56bfb66d019f2ca5ae76b3aeecabaf4 --probe step
```

[調査器](../scripts/investigate-workflow-first.mjs)へstep用の正例を選ぶオプションを追加した。
両commitの既存ソースを先に型検査し、同じ[正例](../scripts/fixtures/step-generic-first.ts)を追加する。
git archiveと同じlock定義・compilerを使い、作業ツリーをcheckout/resetしない。
[生の記録](step-generic-first-inference.json)では、変更前が不受理、変更後が受理となり、既存契約への追加診断は0だった。
元のWorkflow用の比較も両commitで受理されることを確認し、選択オプション追加後の対照記録として残す。

## 未解消の範囲

推論される入力は関数の宣言した制約である。Baseにない通貨やhostの情報を型へ補うわけではない。
購買の3つの文脈注釈や、名前なしinline、多相identity、businessにおけるgenericな入力保持の別例は解消しない。
以前の9つの推論例も同じ実装で再検査し、個別の条件を混同しない。
生成100/500操作の検査は実運用の規模や性能比較を証明するものではない。
独立利用者の評価、原音の未確認範囲、全講演の完全実現は未完了のままとする。
