# 独立した仕様を埋めるモデル検査の雛形

開発用CLIは、`sampleModelAsync`を使うTypeScriptテストを標準出力へ生成する。
対象の業務コードを読み込んだり実行したりせず、期待する業務仕様を推測しない。

```sh
npm run --silent generate:model-test > business-model.test.ts
```

出力先は新規ファイルを選ぶ。上記のリダイレクトは既存ファイルを上書きする。
生成されたテストはNodeのtest runnerと、開発版`koyuki/testing`を使う。
利用先では開発依存のTypeScript/tsx等で型検査・実行する。
CLIはこのリポジトリの開発ツールであり、公開packageのbinには含めていない。

## 記述済みの業務契約から生成する

`--contract`は、利用者が記述した`models`をimportするテストを出力する。
`models`は名前をキーとし、同じ状態・操作・出力型の
`Omit<AsyncSequenceModel<State, Event, Output>, 'seed'>`を値とするrecordである。
入力生成器・境界値・期待仕様・比較・不変条件・縮小候補はこの契約側で指定する。
名前ごとに3 seedのテストを生成し、空のrecordや比較0件を拒否する。
module specifierは生成されたテストファイルからの相対位置で指定する。

リポジトリルートで、タグの既存契約を使う例：

```sh
npm run build
npm run --silent generate:model-test -- --contract ./src/tags/model-testing.js > generated-tag-model.test.ts
node --import tsx --test generated-tag-model.test.ts
```

[タグの契約](../src/tags/model-testing.ts)は、独立した参照仕様と入力生成器を
メモリ／SQLiteで共有する。比較のたびにfixtureを作り直し、出力と保存状態を確認して閉じる。
既存の手書きテストも同じ仕様を使い、重複・上限・古いversion等の到達確認を維持する。
生成コードの実行を伴う検査では両adapterの計6テストを実行し、古いversionを無視する
故意の不具合が反例として検出されることも確認する。配布物のconsumerでも生成テストを実行する。
生成時に契約moduleのトップレベルthrowが実行されないことも検査する。
これは利用者が指定した仕様の接続であり、業務コードから正しい仕様を発見する機能ではない。

経費の同じ入口での実行例：

```sh
npm run build
npm run --silent generate:model-test -- --contract ./src/expenses/model-testing.js > generated-expense-model.test.ts
node --import tsx --test generated-expense-model.test.ts
```

[経費の契約](../src/expenses/model-testing.ts)は、申請・承認・却下・差戻し・編集の
独立仕様を、既存の有限探索と操作列検査から共有する。生成された3 seedのテストは
それぞれ64試行・32操作を純粋なドメイン処理と比較する。
4金額境界、操作者・役割・有効性、領収書、理由、状態・版数を仕様へ明記する。
すべての条件への到達は既存の手書きテストでも別途確認し、生成しただけで網羅したとは扱わない。
生成コードを使う検査では、申請者を別の承認者へ誤変換する故意の不具合も反例として検出する。
配布物のconsumerでも、この契約から生成したコードを型検査・実行する。
経費のこの契約はDB・認証・再送の検査ではなく、それらの既存adapter検査を置き換えない。

別の[経費要求モデル](expense-request-model-sequences.md)では、既存のSQLite再送APIを
同じ生成入口へ接続する。ドメインだけの契約と要求ID付きの保存契約を区別する。

利用者が次を実装するまでは、生成されたテストは必ず失敗する。

1. `State`・`Event`・`Output`と初期状態を業務に合わせる。
2. `events`で境界値・不正入力・権限・競合などの候補を指定する。
3. `step`で実装から独立した期待状態と期待出力を記述する。
4. `check`で毎回独立した実装fixtureを作り、実際の出力と保存状態の両方を比較する。

`check`は縮小時にも呼ばれるため、直前の呼び出しのDB状態に依存させない。
DB接続等は`finally`で後片付けする。業務の拒否も検査対象にするなら、
生成から除外せず、期待する失敗と状態が変わらないことを仕様へ記述する。
必要に応じて不変条件とpayload・初期状態の縮小候補も利用者が追加する。

生成テストは3 seed、有限の試行・列長・縮小予算を明示し、反例やモデル欠陥があれば
seedとwitnessを含むreportで失敗する。比較回数0も失敗し、空の生成器による成功を防ぐ。
診断は合成データを使うテスト用で、業務の機密データを自動収集する機能ではない。
`sampled`は指定範囲で反例がなかったという意味で、全状態の証明ではない。

[雛形の検査](../scripts/model-test-template.test.mjs)は、未記入の失敗、独立した加算仕様と
実装の一致、実装へ加えた誤りの検出、比較0件の拒否、未記入/記入後の型検査を行う。
これは雛形の成立性検査であり、経費やタグの仕様を自動生成した証拠ではない。
業務別の独立仕様とadapter比較は[経費](model-sequences.md)・[タグ](tag-model-sequences.md)を参照する。
