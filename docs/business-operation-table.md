# 操作テーブルのキーと生成される操作を揃える

開発版businessは、operationsに通常のレコードを受け取る。
各ownプロパティは文字列名とデータ値を持ち、その値は関数列または個別load/runの宣言とする。
公開npm alpha.5には含まれない修正。

```ts
import { business, ok } from 'koyuki';
const rule = (value: number) => ok(value + 1);
const operations = { 0: [rule] as const, hidden: [rule] as const };
Object.defineProperty(operations, 'hidden', { enumerable: false });
const commands = business({
  name: 'example', load: async (value: number) => ok(value),
  operation: name => { const actual: '0' | 'hidden' = name; return `example.${actual}`; },
  save: async (value: number, context) => { const actual: '0' | 'hidden' = context.name; void actual; return ok(value); },
  operations,
});
await commands[0](2);
await commands.hidden(2);
```

## 修正前に確認した不一致

640ef6cでは、Symbolキーと非列挙プロパティを含む宣言が型検査を通り、
操作の型も得られる一方、Object.entriesが読み飛ばしたため実行時にはundefinedとなった。
また数値キー0のresolver引数はneverと推論されたが、実際には文字列"0"が渡った。
元コードへのruntime実行と、TypeScript 7.0.2の独立した一時consumerで確認した。

## 現在の契約

- ownな文字列のデータプロパティを登録する。非列挙でも読み飛ばさない。
- 数値キーは通常のJavaScriptと同じ文字列名へ揃える。0ならresolver/save/replayのnameは"0"。
- 操作呼出しはcommands[0]のまま使える。任意の数値キーを持つdictionaryのcontext名はstringとする。
- Symbolの操作名は型検査で拒否し、JavaScriptから渡した場合も構築時に拒否する。
- operations直下のプロパティのgetter/setterは構築時に拒否し、getterを評価しない。
- null-prototypeと別realmのnativeな通常レコードも扱う。
- ownなconstructorや計算プロパティの__proto__もデータキーとして扱い、生成物のprototypeを書き換えない。
- thenは従来どおり予約語。テーブル全体の事前確認を終えるまでoperation resolverを呼ばない。

記述子を一度取得して、宣言元を変更せず登録する。テーブルや元の関数を勝手にfreezeしない。
非列挙のデータ項目も操作になるため、操作ではないmetadataはoperationsの外へ置く。
ロード関数・ドメイン値・詳細loaderのclass利用を禁止する変更ではない。

操作テーブル自体は通常のレコードとし、独自prototypeを持つclass instanceや継承による宣言は拒否する。
TypeScriptの構造的な型だけでは、ownプロパティか、getterか、prototypeが何かを完全に表せないため、
この条件は構築時にも確認する。classの値を使いたい場合は、例えば`{ go: holder.go }`と
取得する値を明示する。構造的に型が合うだけで任意のJavaScript objectを受け入れる保証ではない。

これは渡されたデータプロパティの登録を揃える修正であり、型アサーションや情報を失うオブジェクト変換で
存在すると宣言しただけのキーを復元する機能ではない。業務仕様や関数の純粋性も証明しない。

## 検証

[10件の回帰検査](../src/business-operation-table.test.ts)で非列挙項目、Symbol、getter、継承、
null/cross-realm prototype、数値名と広い数値dictionary、prototypeに似たキー、thenの事前拒否を確認する。
数値名の型はneverが狭い型へ代入できるだけの検査にせず、期待する文字列Unionとの厳密一致も検査する。
replayのlookupとsaveについても、型と実行時のnameが同じ文字列リテラルであることを確認する。
同じ検査を実tarballのconsumerへコピーし、Node globalのないbundleでも非列挙項目の登録を実行する。
配布物ではSymbol宣言の拒否と、数値操作の[段階診断](business-diagnostics.md)も確認する。
