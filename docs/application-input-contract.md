# 動的に選ぶcommandの入力契約

開発版のApplication/operations/replayOperationsは、一つの操作キーへ異なるcommandを
実行時に割り当てる場合、**全候補が受け取れる入力**を要求する。
型の接続保証を保つための修正であり、実行時の関数呼出しや保存処理は変えない。

## 発見した問題

```ts
const byCount = { run: async (input: { count: number }) => ok(input.count) };
const byText = { run: async (input: { text: string }) => ok(input.text.length) };
const selected = flag ? byCount : byText;
const registered = operations({ calculate: selected }, (_state: number, value) => value);
```

このselectedは「countだけ受け取るcommandか、textだけ受け取るcommand」のどちらか。
呼出し時にどちらかを型から確定できない。
以前は入力型を分配して`{count:number} | {text:string}`にしていたため、
byTextが選ばれた状態へcountだけ渡すコードもコンパイルできてしまった。
回帰検査を修正前に実行すると、拒否を期待した`@ts-expect-error`が未使用として報告された。

修正後は`{count:number} & {text:string}`を要求する。
両方のフィールドがあればどちらの関数も呼べる。一方のフィールドだけでは拒否する。
numberだけとstringだけを受け取るcommandの組合せでは、共通の入力がないため呼び出せない。
`run(input: number | string)`という**一つの関数**は引き続きnumberとstringの両方を受け取れる。

この断片のflagはhostの選択条件、ok/operationsはcoreからimportする。
実行可能な定義と拒否検査は[公開APIの回帰検査](../src/application-input-contract.test.ts)にある。

## 通常の操作宣言

```ts
const registered = operations({ byCount, byText }, (_state: number, value) => value);
await registered.byCount.run({ count: 4 });
await registered.byText.run({ text: 'four' });
```

別のキーに分けた場合は、キーごとの入力型を保持する。テーブル全体に一つのintersectionを要求しない。
業務操作の選択と入力の対応が明確なら、通常はこの形を使う。
動的な一つのキーへ無理に全フィールドを渡す必要はなく、commandを型として確定してから登録する方法もある。

## 保持する型と対象範囲

- 動的な同一キーの成功型・エラー型は、候補が返し得る値の直和として保持する。
- 入力だけを、実際に選ばれる全候補へ渡せる型として計算する。
- operationsを経由しない、直接のApplication操作オブジェクトにも同じ入力契約を適用する。
- 再送用のreplayOperationsにも同じ入力契約を適用する。
- 詳細機能がrunと異なるエラー型を返す登録も、従来の詳細互換性検査で拒否する。

修正箇所は[Applicationの型計算](../src/framework/application.ts)と[再送操作の型計算](../src/framework/replay.ts)。
関数のunionから引数を一度に推論し、入力型の分配による過大な許可を避ける。
業務規則、型アサーション、any、外部入力そのものの正しさを証明する変更ではない。
任意のoverloadや高階genericの意味をすべて保持するという保証でもない。

## 配布物での確認

rootだけでなく、実tarballをinstallしたconsumerでも同じ9ケースをコンパイル・実行する。
左右どちらのcommandも実際に選び、共通入力で成功し、失敗型の両方を保持することを検査する。
一方の候補だけに有効な入力、互いに交わらない入力、別キーへ誤った入力を送るコードはコンパイルで拒否する。

この修正により、以前コンパイルできた**安全でない動的選択**が拒否される。
通常の静的な業務操作ごとの入力契約を一括して狭めるものではない。

## 動的に選ぶ検証関数

同じ問題がdefineTransitionのvalidateにもあったため、通常の関数と名前付きstepを関数型へ正規化し、
全候補へ渡せる入力を計算する。動的に選ばれた検証関数・stepへ、一方だけに有効な入力を渡すコードを拒否する。
単独のvalidateがnumber | stringを受け取る場合は、その直和を保持する。
[modelの型計算](../src/framework/model.ts)と配布物の回帰検査で確認する。

これは[generic要件と未注釈evolveの推論制限](transition-inference-study.md)の解消ではない。
候補調査の保存済みsource hashは当時のmodelを識別するものであり、この型修正後のsourceを指すものではない。

関数にruleという補助プロパティがあっても、実行時と同じく関数本体を優先して入力を推論する。
オブジェクト形式のstepの場合だけruleメンバーを取り出す。
