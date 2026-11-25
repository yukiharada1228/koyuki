# 業務関数の接続エラーを段階まで示す

開発版businessは、不正な関数の接続に操作名・配列位置・入力または保存出力の不一致を示す。
公開npm alpha.5には含まれない。正しい宣言の書き方やruntimeは変更しない。

```ts
import { business, ok, err, type Result } from 'koyuki';
type Checked = { value: number; checked: true };
type Allowed = Checked & { allowed: true };
const validate = (value: number): Result<Checked, 'Invalid'> =>
  Number.isSafeInteger(value) && value > 0 ? ok({ value, checked: true }) : err('Invalid');
const allow = (value: Checked): Result<Allowed, 'Limit'> =>
  value.value <= 10 ? ok({ ...value, allowed: true }) : err('Limit');
const finish = (value: Allowed) => ok(value.value);
const commands = business({
  name: 'quantity', load: async (value: number) => ok(value), save: async (value: number) => ok(value),
  operations: { finish: [validate, allow, finish] },
});
const result = await commands.finish(3);
```

この例でallowを省いて`finish: [validate, finish]`とすると、診断には次の情報が現れる。

```text
Koyuki: finish[1] input must accept prior output
```

`finish`は操作のキー、`[1]`は関数配列の0始まりの位置で、2番目の関数を指す。
businessの実行traceでは、この位置はrun:2に対応する。
0番目が不正ならloadの成功値との接続を、途中なら一つ前の成功値との接続を確認する。
この場合はfinishの入力を緩めるのではなく、必要なallowを接続する。
最終関数の成功型がsaveの入力に合わない場合は`output must match save`と示す。
操作ごとのloadを指定した形式では、そのloadの成功型を基準にする。

## 診断用の型であり、関数の属性ではない

TypeScriptのエラー文中では、この文字列がreadonly属性のように表示される場合がある。
これは不正な接続にだけ出す型上の目印。関数へ属性を追加するAPIではない。
正しい通常関数には何も付けず使える。目印と同じ属性を付けても、元の入力・出力の契約を満たさなければ拒否する。
runtimeで関数を装飾したり、業務値や引数をログへ追加したりはしない。

元のRuleによる関数型の検査も残す。診断情報だけを付けた関数を許す実装にはしない。
型アサーション、any、虚偽の型宣言、業務仕様そのものの誤りまで防ぐ保証ではない。

## 配布物で確認する理由

最初の候補はソース内では表示できたが、配布consumerの既定の診断表示で末尾が`{ ...; }`へ省略された。
診断用の型の順序を調整し、実際のtarballを使うconsumerで操作名と段階の情報を検査した。
CLIへnoErrorTruncationを強制して成立したことにはしない。

現在の配布検査は12個の不正な宣言について行と拒否を確認し、そのうち先頭入力、途中の前提省略、
保存出力、個別loader、数値操作の5ケースで診断の目印も確認する。
元からある入力・成功・失敗型、64段の接続、generic save、動的入力の安全性も検査する。

## 比較と限界

[調査結果](business-diagnostic-study.json)は、型宣言変更前のbusiness.tsと同じ固定commitのsrc・tsconfigを取り出し、
その型契約で旧宣言と候補を比較した記録。原本は変更せず一時領域でコンパイルする。
初回は現行srcのコピーを使ったが、後続の操作キー修正が旧宣言では満たせない契約を追加したため、
再現用の比較対象も固定した。現行宣言の妥当性は別に全core・配布物の検査で確認する。

```sh
node scripts/investigate-business-diagnostics.mjs
```

両方が既存の型契約を通り、3つの不正な接続を拒否する。候補だけに操作名と配列位置の目印が出た。
これは現行srcにbusiness.tsだけを差し替える比較であり、リポジトリ全体の変更コストや
compilerの速度、独立利用者の修正時間を測った実験ではない。

TypeScriptの版・型の複雑さ・エディターによって表示や省略は変わる。
全診断を短くした保証、全ての不正宣言の独自診断、業務ルールの静的解析CLIの完成ではない。
generic requireと未注釈evolveの推論制限も解消していない。
