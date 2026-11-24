# Koyuki quickstart

[チュートリアル](../../docs/getting-started.md)。Node.js 22以上、ES Modulesを使用する。

```sh
npm install
npm run check
npm start
npm run start:replay
```

npmの`koyuki@0.1.0-alpha.4`を使用し、ソース内部への相対importはしない。
成功・入力拒否・重複拒否を実行し、結果をassertで検証する。
`diagnostics/invalid.ts`は意図的な型エラーの例で、通常のcheckから除外している。

main.tsはdefineUseCaseの通常操作、replay.tsは任意の再送とrunDetailedの記録を検証する。
