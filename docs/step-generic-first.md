# 制約付きgeneric関数をそのまま名前付き段階にする

## 現在：元の関数の型の対応も保つ

6f90832では、単一の具体的な関数をstepへ渡した場合、ruleの型をその関数のまま保持する。
例えばTからitem:Tを作る関数は、名前を付けた後も呼出しごとの対応を保つ。

```ts
import { step, ok } from 'koyuki';
function wrap<T>(input: T) { return ok({ item: input }); }
const named = step('wrap', wrap);
const number = named.rule(2);          // Result<{ item: number }, never>
const text = named.rule('approved');   // Result<{ item: string }, never>
```

先に束縛したgenericなwithInputも、businessの配列へstepで包んで渡せる。
[実行できる例](business-input-retention.md)のcalculate段階と、[購買の入荷・返品・数量訂正](procurement-direct-receipt-stages.md)へ適用した。
在庫用の文脈型を繰り返す必要はなく、段階名・状態型・失敗停止・選択観測は維持する。

元の関数を推論すると同時に、実際の入力・成功・失敗の契約を検査する。
関数のUnionは従来どおり、全候補の成功/失敗を含む一つのResultの契約として公開する。
異なる入力しか受け取れない候補、非同期関数、非Resultの戻り値、必要なprivateな証明の欠落は拒否する。
step自体のParameters/ReturnTypeの反射は、末尾の従来署名を維持する。
実行本体は従来どおりname/ruleを持つオブジェクトを返し、元の関数を包み直さない。

新しいbusinessの名前付き入力保持の検査は、修正前に接続と厳密型で失敗し、修正後に成功する。
同じ[stepの検査](../src/step-generic-first.test.ts)で、元の関数型の厳密一致と上記の非identityな出力の対応も検査する。
全体1,139件、TypeScript 6.0.3/7.0.2の配布物各795件、既存の不正定義・対照検査で確認する。
単独のstepの正例を、任意の多相変換や独立利用者の開発体験の保証にしない。

配列内でstep('quote', withInput(quote))と直接呼ぶgenericな例は、まだ不受理である。
この場合はwithInputを先に束縛する。通常の具体的なContextを注釈したinlineの対応とは区別する。
元のdefineTransitionの多相identityと未注釈evolveの例も、[6.0.3](step-generic-identity6.json)・
[7.0.2](step-generic-identity7.json)で再確認し、不受理のままである。既存契約の追加診断は0。
単独のnamed.ruleの呼出しにおける型の対応と、宣言全体の文脈付き推論を区別する。

## 初回の入力制約の改善

以下は59fd758時点の実装・調査の記録である。当時の未解消範囲を、現在の保証範囲とは区別する。

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
