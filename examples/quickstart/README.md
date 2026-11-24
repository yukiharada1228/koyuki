# Koyuki quickstart

[チュートリアル](../../docs/getting-started.md)。Node.js 22以上、ES Modulesを使用する。

```sh
npm install
npm run check
npm start
```

npmの`koyuki@0.1.0-alpha.2`を使用し、ソース内部への相対importはしない。
成功・入力拒否・重複拒否を実行し、結果をassertで検証する。
`diagnostics/invalid.ts`は意図的な型エラーの例で、通常のcheckから除外している。
