# inlineのgeneric要件と遷移callbackの推論

この制限は未解消。新しい実行APIや、any/unknownへ広げる回避は追加していない。
既存の一オブジェクト形式で、以下の宣言は型検査に失敗する。

```ts
const validate = (amount: number) => ok(amount);
const quote = (amount: number): Result<number, 'Declined'> =>
  amount > 0 ? ok(amount * 2) : err('Declined');

defineTransition({
  validate,
  require: [withInput(quote)],
  evolve: pair => ok(pair.input + pair.value),
});
```

観測できた診断は、requireの要素がundefinedに代入できないことと、pairにinput/valueがないこと。
このケースでは推論結果が空のrequire tupleとvalidateの成功型に戻っており、
実際に渡した要件の出力をcallbackへ渡せていない。
TSの内部実装における原因まで証明した記録ではない。

## 現在使える書き方

```ts
const quoted = withInput(quote);
const declared = defineTransition({
  validate,
  require: [quoted],
  evolve: pair => ok(pair.input + pair.value),
});
```

あるいは、evolveの入力型を業務関数の定義で明示する。
どちらも業務関数の実行順・失敗伝播・保存への接続は既存runtimeへ委譲できる。
ライブラリがtupleの接続・成功型・失敗型をanyへ変えて解決したことにはしない。

[scripts/fixtures/transition-inference-limit.ts](../scripts/fixtures/transition-inference-limit.ts)は
実際の開発版tarballを別ディレクトリへインストールし、Node型なしで型検査する。
既知の不正推論を拒否し、名前付き要件を使う宣言について入力型・成功型・失敗型の一致を検査する。
TS更新等により制限が解消すれば、不要になったts-expect-errorが失敗し、再評価を促す。

[src/transition-inference.test.ts](../src/transition-inference.test.ts)では、
複数の名前付きgeneric要件を依存順に接続し、元の入力・中間成功値・両要件の失敗型を保持できることも検査する。
途中失敗はevolveへ進まない。この実例も同じ配布物のconsumerで実行する。

## 判断

この調査では、既存の接続拒否と型の精度を維持して一オブジェクトの制限を解消する実装には至らなかった。
推論のためだけに第2引数形式や別builderを公開して、APIの種類を増やす変更は採用していない。
名前付きの通常関数を中心とする使い方を維持し、この例を改善前の再現基準にする。

また、withInputを重ねるとinput/valueが入れ子になる。複雑な業務では、
中間状態に業務上の名前を与えた通常の関数・型も比較対象にする。
名前付きにすればReact/Elm相当の書き心地になる、という実証ではない。

## 宣言候補の再検証

`node scripts/investigate-transition-inference.mjs` は、srcとtsconfigを一時ディレクトリへ
複製し、実際にインストールされているTypeScriptで候補を順番に検査する。
作業ツリーの宣言・テストは変更せず、一時ディレクトリは終了時に削除する。
まず既存の型検査が成功することを確認し、その後、上記のinline再現例と
入力型・成功型・失敗型の厳密一致検査を追加する。
既存テストの`ts-expect-error`も残すため、不正な接続を受理する変更は既存契約の診断に現れる。
これは候補調査であり、候補が成功することを要求する受け入れテストではない。

初回の調査基準でTypeScript 7.0.2から得た観測結果（後続で型検査を追加しているため、診断数は恒久的な件数ではない）:

| 候補 | inline例の受理 | 既存契約の追加診断数 |
| --- | --- | --- |
| 現行宣言 | 失敗 | 0 |
| 接続検査全体をNoInferにする | 失敗 | 0 |
| requireをtupleのspread形式で推論する | 失敗 | 0 |
| 空tupleの既定値を除去する | 失敗 | 37 |
| 接続検査を引数全体の条件型へ移す | 失敗 | 11 |

診断数は独立した不具合数ではなく、同じ推論の崩れによる連鎖も含む。
既定値の除去だけでは、requireを省略した既存の宣言まで広い配列型になり、
空tupleとの接続を壊す。これらの候補は採用していない。
この結果からTypeScriptで解決不能とは判断しないが、単純なNoInferの移動や
既定値の除去を解決策として再提案する根拠はない。

### inline例だけが通る候補の落とし穴

追加調査では、withInputの戻り値に通常の関数が持つ`readonly name: string`を
交差させる候補はinline例を受理した。しかし、元から可能だった次の推論を壊した。

```ts
const preserve = withInput(<T>(value: T) => ok(value));
const number = preserve(2);         // inputもvalueもnumber
const text = preserve('approved'); // inputもvalueもstring
```

この候補ではnumber/string/objectの呼び出しごとの対応がunknownへ広がる。
`src/transition-inference.test.ts`に3種類の厳密一致と実行結果の検査を追加した。
候補調査スクリプトは、inline例の受理と既存契約の維持を別々に出力する。
TS 7.0.2では`callable-name-member`はinline例の診断0、既存契約の診断3となる。
したがって、これは互換性を保った改善ではなく、不採用とする。
通常の関数・named Step向けのoverload追加も調査したが、今回のinline例の
callbackがunknown/neverになる問題は解消しなかった。本体の宣言は変更していない。


## raw tupleとcallable表現を変えた再調査

[新しい8候補と現行宣言の比較結果](transition-inference-candidates.json)を保存した。
同じrevisionのscript・src・インストール済みcompilerから再実行でき、JSONにはmodel.tsのSHA-256も含める。
既存契約の診断にはファイル・行・コードを付け、inline probeの診断と分けている。

```sh
node scripts/investigate-transition-inference.mjs --only current,raw-object-deferred-check,raw-object-spread-check,raw-unknown-deferred-check,raw-object-per-branch-check,callable-empty-intersection,callable-object-intersection,callable-empty-pick,callable-signature-object
```

--onlyは指定候補だけを調べる。無引数なら従来の候補も含めて実行する。
引数の検証後に一時領域を作り、候補のpatchが適用されていなければ失敗させる。
このコマンドは調査用で、採用可能な候補が存在することを成功条件とする受入テストではない。

| 新しい候補 | inline例 | 既存契約の追加診断 |
| --- | --- | --- |
| raw object tuple + 遅延した接続検査 | 不受理 | 0 |
| raw object tuple + spread + 遅延検査 | 不受理 | 0 |
| raw unknown tuple + 遅延検査 | 不受理 | 0 |
| raw object tuple + 各branchの妥当性検査 | 不受理 | 0 |
| `callable & {}` | 不受理 | 0 |
| `callable & object` | 受理 | 7 |
| `callable & Pick<Function, never>` | 受理 | 7 |
| call signatureだけのobject表現 | 不受理 | 0 |

raw tupleの候補はwithInputを変更せず、文脈のcall signatureを避けてから接続を検査する試みである。
今回の8候補では、既存契約を保ったinline例の改善には至らなかった。公開宣言・runtimeは変更していない。

callableをobjectや空のPickと交差させる2候補はinline例を通すが、
number/string/objectの既存の厳密一致に加え、以下の2種類のgenericな利用を壊す。

```ts
const preserve = withInput(<T>(value: T) => ok(value));
function forward<T>(value: T) {
  const result = preserve(value);
  if (result.ok) {
    const before: T = result.value.input;
    const after: T = result.value.value;
  }
  return result;
}
const wrap = withInput(<T>(value: T) => ok({ item: value }));
// wrap(2)はinput:number、value:{item:number}を保持する必要がある。
```

[src/transition-inference.test.ts](../src/transition-inference.test.ts)へこれらの回帰検査を追加した。
任意のTを受け取る別のgeneric呼出し元で入力と成功値を同じTとして使えることと、
identity以外のgeneric出力構造を保持することを確認する。実tarballのconsumerでも型検査・実行する。
7件は同じ推論の崩れに伴う診断であり、独立した7個のruntime不具合ではない。
空の型を交差させるだけなら常に無害、という推測を改善策として採用する根拠にもならない。

現行宣言はこのgenericな利用を保持する。名前付き要件による回避を維持し、
inlineの制限は未解消として残す。この検査で任意のgeneric型計算・全callbackの無注釈化を保証したわけではない。

動的なvalidate候補の入力安全性は後続の[入力契約修正](application-input-contract.md)で別途改善した。
保存済み候補結果のsource hashは調査時点を示し、現在のmodelとの同一性は主張しない。
genericなrequireと未注釈evolveの制限を解消したという意味ではない。

## requireの有無をoverloadで分けた検証

実装基準e3e0157のmodelを複製し、require省略用と必須tuple用のoverloadを分けた。
既定値の削除だけで省略時の推論を壊した過去の候補とは異なり、省略用の型を明示して比較した。
[実測結果](transition-inference-overloads.json)にcompilerと元modelのhashを保存している。

```sh
node scripts/investigate-transition-inference.mjs --only current,required-tuple-overloads,required-raw-overloads
```

| 候補 | inline例 | 既存契約の追加診断 |
| --- | --- | --- |
| 現行宣言 | 不受理 | 0 |
| require省略と必須tupleのoverload分離 | 不受理 | 0 |
| 同じ分離とraw object tuple・遅延検査 | 不受理 | 2 |

後者では構成図の宣言例にも型診断が発生した。件数は独立した不具合数ではない。
前者もinline例の入力型・成功型・失敗型の厳密一致まで成立していない。
どちらも採用せず、公開宣言とruntimeは変更していない。
「空tupleの既定値を除けば解消する」という仮説を支持する結果ではないが、
TypeScriptで解決不能という証明でもない。
