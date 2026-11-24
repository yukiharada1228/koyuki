# 接続をまとめるdefineUseCaseの試作（開発版alpha.3）

取得・純粋な遷移・要求情報を伴う保存・任意の再送を、一つの定義にまとめるAPI。
既存のdefineRequestTargetとwithReplayを組み合わせる薄い入口で、別の実行エンジンではない。
npmにはまだ公開していない。既存APIは引き続き利用できる。

```ts
const submit = defineUseCase({
  operation: 'leave.submit.v1',
  load: (call: Call<SubmitInput>) => repository.load(call.input, identity),
  transition: submitted,
  save: (change, execution) => repository.save(
    request('submit', execution.request), change,
  ),
  replay: {
    lookup: call => repository.receipt(request('submit', call)),
    resolveAfter: error =>
      error.kind === 'Conflict' ||
      error.kind === 'InvalidState' ||
      error.kind === 'StorageUnavailable',
  },
});
```

この抜粋の型・submitted・repository・identity・requestは、
[休暇の試作実装](../scripts/fixtures/leave-use-case-application.ts)で定義している。
`submitted`は既存の`{ validate, require, evolve }`をそのまま使える。

## 契約

- replayなし：saveが返す値をそのままrunの成功値にする。runDetailedはResult・業務trace・plan。
- replayあり：saveはExecutionを返す。runDetailedは最終result・再送trace・元のattempt。
- replayは定義時に有無を決める。型が曖昧な任意の設定を実行時に自動解釈する入口ではない。
- 戻り値はrunとrunDetailed。再送を迂回するmutationやdecisionの抜け道は公開しない。
- validateの入力はloadの出力に、saveの入力はevolveの出力に固定する。
- saveの第2引数には元の要求とoperationを渡す。replayがあるときだけwithReplayが要求をcloneする。
- trace・例外・原子的な保存・認証などの責任範囲は、既存APIから変更しない。
- Applicationへの登録は別。再送を使う操作にはreplayOperationを使う。

保存値、要求IDとfingerprintの対応、許可する状態変化、トランザクションは利用者が設計する。
新APIがこれらを推測して自動生成するわけではない。

## 比較結果

| 観点 | 既存API | 試作API | 結果 |
| --- | --- | --- | --- |
| 一つの操作の組み立て | Target→on→withReplay | defineUseCaseに設定を集める | 接続の呼び出し箇所を減らせた |
| 経費の共通helper | targetとreplayの2個 | adapterの1個 | 手書きの中間コマンド型が不要 |
| 休暇の操作登録 | Target登録と再送登録を分離 | 各操作を一度登録 | 操作名を重ねて指定する箇所を減らせた |
| 必要な業務・保存設定 | load、遷移、save、lookup、resolveAfter | 同じ | 設定そのものは減っていない |
| 実行結果・実行回数・詳細記録 | 既存の契約 | 同じ | 比較テストで一致 |
| 型エラー | onの型不一致 | 宣言内の型不一致＋overloadの診断 | 全体として読みやすくなったとは言えない |

参考として、importからcommandsの終わりまで（Application定義を除く）の今回のソースは、
経費29行→29行、休暇25行→25行。改行の仕方に依存するため削減率の指標にはしない。
新APIは組み立てを一箇所に集める効果はあるが、劇的にコードを短くするものではない。

## 型エラーで分かった弱点

[コンパイル比較用の誤定義](../scripts/fixtures/use-case-diagnostics.ts)を、配布パッケージ経由で実際にコンパイルした。

- saveがstringを受け取りevolveがnumberを返す場合、旧APIはonの引数に、新APIはsaveの位置にエラーが出る。
- evolveの入力が合わない場合は、どちらも具体的な型の不一致を表示する。
- 再送を有効にしてExecutionを返さない場合、新APIはsaveの結果とExecutionの不一致を表示する。
  最初の試作ではreplayをundefinedにせよという誤解しやすい末尾診断だったため、overloadの順序を調整した。
- それでも「No overload matches this call」、Step、NoInfer、Execution<unknown>などの内部型が現れる。
  再送なしの誤定義でも再送ありoverloadの診断が表示される場合がある。

入力型の不一致、requireの接続ミス、saveの入力不一致、再送の出力不一致、要求情報の型不一致は拒否する。
エラー型がunknownに広がらず、業務・保存・照会の失敗が合成されることも型チェックで確認した。

## 採用判断

開発版の追加の入口として試験採用し、経費の実装で使う。
推奨APIの全面置き換えや、操作登録のさらなる自動化はまだ行わない。
理由は、組み立ては減らせた一方、必要な設定は減らず、型診断も改善したとは言い切れないため。
既存のTarget→on→withReplayが読みやすい場面では、そのまま使える。

公開alpha.2の休暇サンプルは変更せず、独立した一時consumerへ試作実装を配置して比較する。
この比較を保ち、次に取り組むなら型診断と利用者が迷う設定項目を優先する。

## 再現する

```sh
npm ci
npm run check
npm test
npm run test:use-case:package
```

- 本体334テスト：既存331＋通常実行の一致・再送分岐の一致・同時実行と例外の3テスト。
- 経費の既存テストは新APIに移行した実装で実行。
- 作業ツリー外のpack済みパッケージで、休暇の既存14＋詳細記録2＋旧新比較1の17テスト、型チェック、デモ。
- 別途4件の意図的な誤定義をコンパイルし、旧新それぞれ期待位置で拒否されることを確認。
