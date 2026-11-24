# ランタイムと依存の方針

開発版alpha.4から、公開するコアは次の方針を守る。
npm公開済みalpha.3にはまだnode:crypto依存がある。

- ECMAScript組み込みとWeb標準APIのみを使用する。
- Node / Bun / Denoなど特定ランタイム固有のAPIをコアに持ち込まない。
- 実行時の外部パッケージ依存を持たない。dependencies・optionalDependencies・peerDependencies・同梱依存は空。
- 公開する型定義も@types/nodeなどの外部型パッケージを要求しない。
- ビルド・テスト・ドキュメント・サンプル用の依存はdevDependenciesへ置く。
- DBやHTTPなどのアダプターはコアの外で利用者が選ぶ。現在のSQLite・React・Honoサンプルをコアからimportしない。

コアで現在必要なのは、Promise、Map、Set、WeakMap、Symbol、JSONなどの組み込みとstructuredClone。
Object.hasOwnなどES2022の機能も使用する。必要な標準機能を備えた環境を対象とし、polyfillは同梱しない。
将来暗号機能が必要になった場合もWeb Cryptoなどの標準APIを検討し、node:cryptoへのfallbackをコアへ埋め込まない。
現在の決定の一致確認は暗号ハッシュを必要としないため、正規化文字列を同期比較する。

## 自動検証

```sh
npm run check:package
npm run test:portable
```

check:packageは次を検証する。

1. Node型を読み込まず、ES2022とDOMの標準型だけでコアをビルド。
2. 実際のnpm tarballを一時ディレクトリへ開発依存なしでインストール。
3. 実行依存のメタデータと、npmがインストールした依存ツリーを確認。
4. 全配布JSモジュールをブラウザ向けにbundleし、パッケージ外へのimportがないことを確認。
5. @types/nodeを持たないconsumerで、全配布型定義と利用例を型チェック。

test:portableはビルド済み入口をブラウザ向けにbundleし、NodeグローバルのないVMで通常実行・詳細記録・再送を確認する。
検証スクリプト自体のNode・esbuild・TypeScriptは開発用で、配布物の実行依存にはならない。

これらは実ブラウザや各エッジ基盤での実機試験の代わりではない。
動作環境ごとの互換性は今後個別に検証する。SQLiteを使うサンプルには引き続きNode.jsが必要。
