# inlineのgeneric要件と遷移callbackの推論

[普通のgeneric recordの接続](ordinary-generic-records.md)で、input/valueのラッパーなしでも共有関数のフィールド対応を保持するようにした。深い入れ子・名前なしinline・原資料確認・独立利用者評価は残る。

[遷移全体の入力保持](transition-pair-context.md)では、名前付きのgeneric要件を具体的な前段へ適用できるようにした。
元の名前付きidentityと未注釈evolveの例も受理する。以下の過去の不受理の記録は、各commit時点の結果として読む。
未確定のTを使う別のgeneric呼び出し元のidentity・入力保持も後続で対応した。
共有generic関数のvalueフィールドの対応も保持するようにした。名前なしinlineと、さらに深い入れ子の出力には制限が残る。

## 既存のstepで書ける範囲と残る制限

現行APIでも、具体的な要件関数を名前付き段階にすると、次の例はevolveの型注釈なしで通る。

```ts
const quote = (amount: number): Result<number, 'Declined'> =>
  amount > 0 ? ok(amount * 2) : err('Declined');
const flow = transition(defineTransition({
  validate: (amount: number) => ok(amount),
  require: [step('quote', withInput(quote))],
  evolve: pair => ok(pair.input + pair.value),
}));
```

入力number、結果Result<number, 'Declined'>の厳密一致、実行結果、要件失敗時にevolveを
実行しないこと、不整合な入力型の拒否を[回帰検査](../src/transition-inline-step.test.ts)で確認した。
独立したgenericな呼び出し元の先行検証では、validateの戻り値をResult<T, never>と明示していた。
後続のidentity・入力保持の検査では戻り型も推論する。すべての型注釈を省略できるという保証ではない。

[呼び出し方の比較](transition-inference-call-sites.json)は、f8d4b19のクリーンなソースと
TypeScript 7.0.2による結果である。先に変数へ束縛する従来の回避と、オブジェクト内で
stepに段階名を付ける今回の書き方は区別する。

| 呼び出し方 | 検査したinline例 |
| --- | --- |
| require配列へas constのみ追加 | 不受理 |
| step('quote', withInput(quote)) | 受理 |
| 即時呼び出し関数を経由 | 受理（調査用の構文） |
| 多相identity関数をwithInputとstepへ渡す | 不受理 |

したがってstepも万能な解決ではない。元の名前なしinline宣言の推論制限は未解消である。
この記録のminimal欄は変更していない元の最小fixtureであり、各呼び出し方へ変換した結果ではない。

[宣言形状の追加比較](transition-inference-callable-return.json)では、関数全体の戻り値を
NoInferで包む候補は具体的なinline例を通したものの、既存generic契約に9件の診断を生じた。
これは従来と同じ4検査の診断数であり、9個の独立した不具合ではない。
引数を1要素tupleのrest引数にする候補は既存契約を維持したが、元のinline例を通せなかった。
両案とも不採用。公開宣言・実行エンジン・依存関係は変更していない。

## 戻り値の型計算を遅らせる候補

[追加の結果](transition-inference-deferred-return.json)は、53ddc8aのクリーンなソースで
TypeScript 7.0.2を使った比較である。withInputの戻り値を次の非分配条件型へ変える候補を調べた。

```ts
[I] extends [I]
  ? Rule<I, Readonly<{ input: I; value: O }>, E>
  : never
```

配列の要素へinlineでwithInput(quote)を置く例は、入力number・成功number・失敗Declinedの
厳密一致を含めて通った。しかし、既存のtransition-inference.test.tsに9件の診断が出た。
これらは次の4検査に属し、9個の独立した不具合を意味する数値ではない。

- genericなidentity関数をnumber・string・objectへ別々に適用した際の型の対応
- 独立したgenericな呼び出し元で、同じ型引数を入力と結果に保つこと
- genericな入力をitemへ包む、identity以外の結果構造
- 制約付きgeneric関数へ渡したcurrency等の追加フィールドの保持

つまり、特定のinline例を通す一方で、普通のgeneric業務関数を再利用する既存契約を壊す。
候補は不採用。publicな宣言、runtime、依存関係を変更せず、型推論の制限は未解消として残す。
既存ソースの型検査が通る現行宣言と、inline例だけが通る候補を区別した記録であり、
この条件型によるあらゆる改善が不可能だという結論にはしない。

```sh
node scripts/investigate-transition-inference.mjs --only current,deferred-with-input-return
```

scriptは候補を一時コピーへ適用し、通常の全ソースの型検査、inline probe、既存の最小再現例を検査する。
ここでのminimal欄は従来の変更前fixtureの結果であり、条件型へ変更した最小例の結果ではない。
既存の名前付き要件・型を明示した業務関数による記述は引き続き使える。

## compilerを分けた追加検証

[3 compilerの結果](transition-inference-compiler-comparison.json)を追加した。
同じcommit・宣言・最小再現例・検査scriptを使い、7.0.2、7.1.0-beta、
7.1.0-dev.20261125.1を比較した。後の2つは一時ディレクトリへ導入し、
プロジェクトの依存やlockfileは変更していない。registryのversion・tarball URL・integrityと、
実行したdarwin-arm64のnative package情報も記録する。

```sh
node scripts/investigate-transition-inference.mjs --only current,raw-object-tuple-constraint,raw-unknown-tuple-constraint,stage-tuple-constraint
node scripts/investigate-transition-inference.mjs --only current,raw-object-tuple-constraint,raw-unknown-tuple-constraint,stage-tuple-constraint --compiler /path/to/isolated/node_modules/.bin/tsc
```

--compilerは明示したcompiler実行ファイルを使う。script自身はpackageを取得・更新しない。
省略時は従来どおり、プロジェクトにインストール済みのcompilerを使う。
source commit・作業ツリーの状態・script/probe/modelのhashを記録する。
比較記録の全試行は同じcommitでsourceDirty:falseだった。

| 宣言候補 | 3 compilerでのinline例 | 各compilerでの既存契約の追加診断 |
| --- | --- | ---: |
| 現行 | 不受理 | 0 |
| raw objectの非空tupleまたは空tupleという制約 | 不受理 | 2 |
| raw unknownの非空tupleまたは空tupleという制約 | 不受理 | 2 |
| 現行Stageの非空tupleまたは空tupleという制約 | 不受理 | 0 |

今回の3候補は、従来の配列制約からtuple形状をヒントとして与える調査。
withInputのcallableへpropertyを追加してgenericの入出力対応を失う回避はしていない。
rawの2候補では、既存の通常関数の宣言にTS7024/TS2322が出た。
2件は同じ箇所に伴う診断であり、独立した不具合数とは数えない。
全候補を不採用とし、公開宣言・runtimeは変更していない。

3 compilerすべてで、名前付き要件と直接の通常関数を使う最小例は通り、
inlineの高階関数を含む例はTS2322/TS2339/TS2551等で失敗した。
フレームワークをimportしない再現例にも同じ制限が残る。
この結果は、調べたbeta/開発版へ更新するだけでは解消しないという証拠であり、
将来の全compilerやTypeScriptでの解決不能を示すものではない。
beta/開発版で既存ソースの型検査が通ったことも、その版で全runtime・配布consumer・CIを
認証したという意味ではない。独立利用者のDXや、全講演の完全実現という判定も変えない。

## 現在の制限

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
後続では、[compiler境界の調査](inline-inference-compiler-boundary.md)を踏まえて専用の観測へ分離した。
入力型・成功型・失敗型の厳密一致を含めて通る場合も許容し、正しい構文の不受理を必須にしない。
既知の診断パターンだけをcompiler-limitとして記録し、別の型エラーや精度の喪失は拒否する。

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

## 位置ごとの接続チェックとmonomorphic overloadの追加調査

[追加結果](transition-inference-mapped-checks.json)では、再帰的な接続チェックを
各tuple位置のmapped typeへ置き換える2候補を確認した。NoInferを全体へ付ける場合も、
既存契約は維持したがinlineの推論制限は解消しなかった。

withInputへ普通の関数用overloadを追加し、入力型がunknownなら従来のgenericな宣言へ
戻す候補も確認した。この候補もinline例を改善せず、制約付きgeneric関数の型を壊した。
`<T extends { amount: number }>(value: T) => ok(value)`の型引数を単なる制約へ潰すと、
呼び出し時に渡したcurrency等の追加フィールドと戻り値の対応が失われる。
入力型がunknownかどうかの判定だけでは、generic関数を安全に見分けられない。

[回帰検査](../src/transition-inference.test.ts)へこの制約付きgeneric例を追加した。
既存の制約なしidentityだけで候補の互換性を判断せず、入力・出力の厳密一致と参照を確認する。
今回の3候補は不採用とし、実装と公開APIは変更していない。

```sh
node scripts/investigate-transition-inference.mjs --only current,mapped-adjacency,mapped-adjacency-no-infer,monomorphic-with-input-overload
```

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

## 接続検査をobjectの文脈から外した検証

実装基準349942cでは、requireを裸のTとして推論させ、接続の妥当性だけを
型上のrest引数へ移した。正しい呼出しは従来どおり1引数で、不正な接続には
渡せないneverの引数が必要となる候補である。requireフィールドの交差型の中で
NoInferを移す過去の候補とは、検査位置が異なる。

```sh
node scripts/investigate-transition-inference.mjs --only current,raw-object-rest-check,raw-unknown-rest-check,unconstrained-rest-check
```

[compilerとsource hash付きの結果](transition-inference-rest-checks.json)では、
raw object tuple・raw unknown tuple・Tの制約なしの3候補すべてで、既存契約の追加診断は0。
しかしinline例はTS2322/TS2339/TS2551を伴って不受理で、入力・成功・失敗型の厳密一致も成立しなかった。
withInputのgenericな戻り値を変更したり、公開APIへrest引数を追加したりはしていない。
この検査位置の移動だけでは制限を解消できず、候補は不採用とする。

## 戻り値の推論抑制とフレームワークを除いた再現

[戻り値の調査結果](transition-inference-return-checks.json)では、withInputの戻り値に
NoInferを付ける3候補を比較した。すべてinline例を解消しなかった。
入力または戻り値全体の推論を抑える2候補は、genericな入力・出力の対応にも追加診断8件を生じた。
ペアの値側だけを抑える候補は既存契約を保ったが、inline例は改善せず、いずれも不採用。

原因の切り分けとして、[最小例](../scripts/fixtures/transition-inference-minimal.ts)も作成した。
Koyukiへのimport・Result型・Stage・隣接接続チェック・実行エンジンは含まない。
名前付きのcarryと通常のinline関数では、evolveの引数と最終出力が正しく推論される。
generic関数生成carry(quote)をrequireの中で呼ぶと、同じcompilerで空tupleへ戻る診断と
evolveのinput/valueが存在しない診断が出る。出力がnumberという厳密一致検査も失敗する。

調査スクリプトは最小例の名前付き・通常inline部分が成功することを先に確認し、
genericなinline部分を追加した診断をminimalとして別に記録する。
Node型も読み込まず、fixtureのSHA256を保存する。
このファイルは意図的に型エラーを含む調査用であり、通常のsrc型検査や公開packageへは含めない。

```sh
node scripts/investigate-transition-inference.mjs --only current,with-input-return-no-infer,with-input-parameter-no-infer,with-input-pair-no-infer
```

これは調査対象のTypeScript 7.0.2でフレームワークの接続チェックを除いても再現するという証拠。
TypeScriptの実装内部の原因・既知Issueとの同一性・将来版での挙動・解決不能を証明するものではない。
公開APIは変更していない。以後の候補は、この最小例と既存のgeneric契約の両方で評価する。

## TypeScript本体の記録との比較と追加候補

2026-11-26に次の一次資料を確認した。

- [PR #48538](https://github.com/microsoft/TypeScript/pull/48538)は、object/array literal内でも文脈依存関数の推論を左から右へ流す改善を説明している。
- [Issue #47599](https://github.com/microsoft/TypeScript/issues/47599)は文脈依存の式の推論を扱う。参照するPRの改善があることと、全パターンが解決済みであることは同じではない。
- [Issue #63380](https://github.com/microsoft/TypeScript/issues/63380)は、既定の型引数を持つ入れ子の呼び出しと名前付き変数で挙動が異なる例を扱う。今回の最小例と同一の不具合だという確証はない。

これらは推論方法の調査材料であり、Koyukiの問題の原因や修正方法を確定する根拠にはしない。
TypeScriptの内部を修正したり、上流へIssueやコメントを投稿したりはしていない。

[追加の比較結果](transition-inference-indexed-checks.json)では、最終出力を再帰的な条件型から
出力tupleと長さのindexで求める候補と、位置ごとの接続チェックも併用する候補を確認した。
既存契約の追加診断は0だが、inline例はどちらも不受理だった。

また、要件が一つの場合に中間成功型を直接推論するoverloadを追加し、従来の任意長宣言を
fallbackとして維持する候補も比較した。既存契約は保ったが、inline例のevolveの入力は
unknownとなり、期待する入力・出力の厳密一致は成立しなかった。
単一要件のoverloadだけを公開して従来の宣言を隠す形では比較していない。
任意長の処理を単一要件へ制限する代替案としても採用しない。

```sh
node scripts/investigate-transition-inference.mjs --only current,direct-requirement-output,indexed-stage-end,indexed-stage-end-mapped-connection
```

今回の3候補も不採用。外側の文脈、関数生成、callbackの推論を、型の精度を維持しながら
両立させる方法は引き続き未解決である。公開APIと実行エンジンは変更していない。

[深い出力の推論候補](deep-output-investigation.md)では、再現例の受理と既存契約の回帰を分けて比較する。候補は不採用で、コアの制限は維持する。
