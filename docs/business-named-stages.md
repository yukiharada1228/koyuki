# businessの段階に業務上の名前を付ける

`business`の関数列へ、従来の普通の関数に加えて、既存の`step(name, rule)`を置ける。
名前付き段階と普通の関数を混在でき、独自のbuilderや新しい実行方法は追加しない。

```ts
const app = business({
  name: 'expense',
  load,
  save,
  operations: {
    quote: [
      step('calculate-quote', withInput((value: Context) => quote(value))),
      finish,
    ],
  },
});
```

Contextとquote・finish・load・saveは利用者の型と関数である。
[実行可能な検査](../src/business-named-stages.test.ts)には、それらの全定義、入力型・成功型・
失敗型の厳密一致と、classのprivate fieldを持つ元の文脈が同じ参照で渡ることを含む。
`Step<I, O, E>`も公開型としてimportできる。

## 名前と実行の関係

- 名前付き段階の名前を、詳細trace・選択capture・`describeFlow`の構造図で使う。
- 普通の関数の既定名は従来どおり`run:1`、`run:2`などの配列位置による名前となる。
- 処理順序とResultの停止・伝播は従来と同じ。失敗した段階の後の関数とsaveは実行しない。
- 想定外の例外は元のcauseでrejectし、型付きの業務拒否へ自動変換しない。
- 保存と再送は既存の共通境界を使う。名前を付けること自体が冪等性やatomic保存を提供するわけではない。

名前は業務を説明するラベルであり、実行要求の識別子ではない。
同じ名前を使うとtraceの名前だけで段階を識別できなくなるため、構造図のIDや実行位置との対応は別である。

## 宣言の所有権

businessの生成時に、各段階のnameとruleを一度取得し、内部の宣言へ保持する。
元のStepオブジェクトのnameやruleを後から置き換えても、生成済みcommandの実行と図は変わらない。
ruleの閉包やドメイン値をdeep freezeする機能ではない。

名前付き段階はオブジェクト、通常の段階は関数として扱う。
`rule`プロパティも持つ関数は2つの処理本体を持てるため、`AmbiguousBusinessStage`で生成時に拒否する。
これは、関数を構造的なStep型へ代入したときに、宣言のruleと外側の関数を取り違えて実行しないためである。
通常の関数へruleというメタデータを付けていた場合も、この曖昧な形に該当する。
nameが文字列でない、ruleが関数でないオブジェクトも生成時に拒否する。

## 推論の改善範囲と残る制限

[前の調査](business-input-pair-inference.md)で通らなかった、具体的なContextを注釈したwithInputの
inline呼出しは、上の名前付きstepであれば、先に変数へ束縛せず書ける。
型アサーションで接続を通す回避ではなく、Stepのruleの入出力を既存と同じ条件で検査する。
権限の証明が足りない入力・不適合な保存出力・動的な候補の一部しか受け取れない入力は拒否する。
操作専用loadにも同じ宣言を使え、最初の名前付き段階からgeneric loadの要求型を推論する検査も含む。

名前なしinlineの例や、任意のgeneric入力保持を解消したわけではない。
Stepは宣言したI/O型を持つため、generic関数を包めば任意の型引数の対応まで保持するとは限らない。
上の例にもContextの注釈が残る。既存の購買3操作のadapterも、この追加だけで注釈不要にはならない。

検査は保守者によるもので、配布した開発版tarballのconsumerでも同じソースを型検査・実行する。
独立利用者の試用、学習負担の低下、生産性の優位、講演の全内容の完全実現の証拠にはしない。

[推論比較の記録](business-named-stages-inference.json)は、7f81efeのクリーンなソースと
TypeScript 7.0.2で、元の3パターンを分けた結果である。
genericなquotedを配列へ置く例と、名前なしinlineの例は不受理のまま、名前付きinlineだけが受理される。
いずれも既存ソースの追加診断は0である。minimal欄の旧transition fixtureは今回のbusiness例とは異なる。

```sh
node scripts/investigate-transition-inference.mjs --only current --probe business-input-pair-named-step
```
