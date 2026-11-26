# inline要件を保留するcompilerの境界と、改善を許容する検査

名前なしの`require: [withInput(quote)]`と未注釈の`evolve`を同じ宣言へ書く制限について、
TypeScript 6.0.3の推論処理を切り分けた。Koyukiの型宣言や実行本体を変更して解消した記録ではない。

## 再現と原因の切り分け

[Koyukiを使う再現例](../scripts/fixtures/transition-inference-limit.ts)は、入力・成功・失敗の厳密一致も検査する。
[KoyukiもResultも使わない最小例](../scripts/fixtures/transition-inference-minimal.ts)でも、
関数を先に束縛した場合と通常のlambdaは通り、genericなcarryのinline呼出しで推論が失敗する。
以前の[TS6/TS7の同一probe](selected-requirement-context6.json)では、この制限を両版で確認している。
TS7側の記録は[selected-requirement-context7.json](selected-requirement-context7.json)にある。

比較元のTypeScript 6.0.3の`lib/_tsc.js`では、呼出し式の型検査に次の分岐がある。

```js
if (checkMode & 8 /* SkipGenericFunctions */ && !node.typeArguments && callSignatures.some(isGenericFunctionReturningFunction)) {
```

この分岐は、推論の初期段階で「関数を返すgeneric関数」の呼出しを保留する。
その間に、後段callbackの文脈型から空のrequire tupleが選ばれる例になっている。
単にtuple制約を緩める案では直らず、戻り値全体をNoInferで包む案は既存のgenericな型伝播を壊す。
この一連の現象と、独立したgeneric関数の型保持の両方を区別して扱う。

[比較script](../scripts/investigate-generic-call-skip.mjs)はcompilerを一時ディレクトリへコピーし、
上の分岐だけを`false &&`で無効にする。インストール済みcompiler、Koyuki、lockfileは変更しない。
比較script自身も、通常のbuild・CI・npm packageからは呼び出さない。

| 比較 | 元のTypeScript 6.0.3 | 一時コピーで分岐だけを無効化 |
| --- | --- | --- |
| 既存src全体の型検査 | 成功 | 成功 |
| 名前なしinlineの入力・結果の厳密一致 | 推論失敗 | 成功 |
| Koyukiなしの最小例 | 推論失敗 | 成功 |
| inlineの期待成功型を故意にstringへ変更 | 元の推論失敗と混在 | 型検査で拒否し、観測器も拒否 |

この結果は、調べたTypeScript 6の分岐が当該例を止めていることの対照証拠である。
分岐を一律に外してよいという提案、任意のコードの型安全性・性能の証明、TS7内部の確認ではない。
改変compilerを利用者へ配布したり、Koyukiにcompiler patchを要求したりしない。

## 正しい構文の失敗を必須にしない

以前の配布物検査は、妥当なinline宣言へts-expect-errorを付けていた。
そのためcompilerで推論が改善しても、不要になった抑制コメントがエラーを起こす構造だった。

現在はこの例を通常の成功fixtureから分け、[専用の観測器](../scripts/inline-inference-observation.mjs)で検査する。
入力・戻り値の厳密一致を含めて通ればsupported、既知の位置と診断の組合せで失敗した場合だけcompiler-limitを返す。
これはこの再現例の状態であり、講演やframework全体のsupported判定ではない。
未解消の構文を不正な業務接続と同じ拒否契約へ固定しない。

配布物検査では、通常の型付きlambdaへ置き換えた実際に通る対照も受理する。
名前付きの正例の型を壊す対照、通るinlineの期待成功型を壊す対照、成功値をanyへ失わせる対照は拒否する。
型の正しさを失ったまま「compilerが改善した」と扱わないための検査である。
元のinlineが止まる間は後段の型精度を証明できず、観測器もcompiler-limit以上の判断をしない。

```sh
# 実tarball・Node型なし・通常の未改変compilerで検査する。
npm run check:package

# 別途用意した6.0.3のcompilerで、一時コピーの比較だけを行う。
node scripts/investigate-generic-call-skip.mjs --compiler /path/to/typescript6/bin/tsc
```

## 記録の基準

[比較記録](inline-inference-compiler-control.json)は3dfc042のクリーンなソースから収集した。
元と改変後のcompiler実装、collector、Koyukiのmodel、2つのfixtureのhashを記録している。
未改変の配布物検査ではcompiler-limitを観測し、通るlambda対照と3つの拒否対照も確認した。
比較scriptの実行を通常の利用者の開発環境の条件にはしない。

## 残る判断

名前なしinline要件の製品上の制限は未解消である。
現行の`step`で名前を付けるか、通常の変数へ束縛する回避は引き続き使える。
この資料と2つのfixtureは上流へ再現を報告するためにも使えるが、外部への投稿は行っていない。
特定の言語実装の制限を隠すために、業務の型をanyへ変えたり、新しいbuilderを増やしたりしない。
独立利用者の評価・原音確認・深いgeneric変換の残件は維持する。
