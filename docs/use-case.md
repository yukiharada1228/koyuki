# 接続をまとめるdefineUseCaseの試作（alpha.3）

取得・純粋な遷移・要求情報を伴う保存・任意の再送を、一つの定義にまとめるAPI。
既存のdefineRequestTargetとwithReplayを組み合わせる薄い入口で、別の実行エンジンではない。
npmの `koyuki@0.1.0-alpha.3` に含まれる。既存APIは引き続き利用できる。

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
| 型エラー | onの型不一致 | 宣言内の型不一致と再送の案内 | 改善後は不要なoverload診断を除去 |

参考として、importからcommandsの終わりまで（Application定義を除く）の今回のソースは、
経費29行→29行、休暇25行→25行。改行の仕方に依存するため削減率の指標にはしない。
新APIは組み立てを一箇所に集める効果はあるが、劇的にコードを短くするものではない。

## 型診断の改善

最初の試作は再送あり・なしのoverloadを使い、通常のsaveの間違いにも再送用の型が表示された。
現在は一つの公開シグネチャにまとめ、定義にreplayがあるかを型で判別する。
診断文を短くするためにanyへ広げたり、型チェックを省略したりはしていない。

[コンパイル比較用の誤定義](../scripts/fixtures/use-case-diagnostics.ts)を、配布パッケージ経由で実際にコンパイルしている。

| 間違い | 現在の診断で確認できること | 直す場所 |
| --- | --- | --- |
| evolveはnumber、saveはstringを受け取る | saveの位置でnumberとstringの不一致 | saveの入力型またはevolveの出力 |
| validateはnumber、requireはstringを受け取る | requireの位置で期待されるStep<number, ...> | requireの入力 |
| requireはstringを返しevolveはnumberを受け取る | evolveの入力としてstringが必要 | requireの出力またはevolveの入力 |
| replayを指定してsaveが生のnumberを返す | Koyuki: replay requires save to return Execution<Output> | saveの成功値 |

最後の案内は、エラーに現れる特別な型プロパティの名前。
そのプロパティを設定へ追加するのではなく、saveを以下の契約へ直す。

```ts
return ok({ kind: 'committed' as const, value: saved });
// 保存中に既存の成功記録を確認した場合はkind: 'replayed'
```

保存と成功記録は、従来どおり同じトランザクションで確定する。

共通のrequire接続型も、接続ミス全体をneverにせず各位置の期待入力型を示す形に変更した。
新APIだけでなく既存のTargetやtransitionでも接続のチェックを維持する。
検証fixtureではNo overload matches this call（TS2769）が出ないことと、再送の案内が出ることを自動確認する。
Stepや型のintersectionなど、TypeScriptの内部的な表記は引き続き表示される。
どんな誤定義でも短い自然文になるという保証ではない。

## 型推論の範囲

- 経費と休暇の既存アダプター定義、通常／詳細の戻り値、失敗型の合成は維持。
- lookupの入力とresolveAfterのエラーは、引数型を省略しても推論する。
- saveの入力・要求情報・結果が相互に依存するインライン関数では推論が循環する場合がある。
  その場合は既存サンプルのようにsaveを型付きアダプターとして定義するか、両引数と戻り値を明示する。
- replayが明示的にない場合はActionReport、ある場合はReplayReport。
  optionalな設定を変数から渡す場合は、実行時にどちらにもなり得るため戻り値も両者のUnionにする。
- 検証済みbrand、require接続、saveの入力、再送の出力、要求情報の型の拒否を維持。
- 入力・エラーをanyにしていないことも、存在しないフィールドへのアクセスを拒否する型テストで確認。

## 採用判断

開発版の追加の入口として試験採用し、経費の実装で使う。
推奨APIの全面置き換えや、操作登録のさらなる自動化はまだ行わない。
診断は改善したが、必要な設定は減らず、複雑なインライン関数の型推論には制限が残るため。
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
- 別途6件の意図的な誤定義をコンパイルし、旧新それぞれ期待位置で拒否されることを確認。

## 複数操作のApplication登録（alpha.5）

同じ表示状態の更新規則を使う再送対応コマンドは、操作名を再列挙せず登録できる。

```ts
const commands = leaveCommands(repository, actor);
return defineApplication({
  initial: () => initial,
  operations: replayOperations(commands, (_before: Account, after) => after),
  view: state => ({
    account: state.data,
    balance: balance(state.data),
    busy: state.kind === 'running',
    error: state.kind === 'failed' || state.kind === 'crashed' ? state.error.kind : null,
  }),
});
```

`replayOperations`は各コマンドを既存の`replayOperation`で包むだけで、
新しい実行エンジンや自動再試行を追加しない。各キーの入力・失敗型を保つ。
committedの成功値だけを共通reduceへ渡し、replayedでは現在の状態を維持する。
コマンド表は登録時にコピーされ、後から操作を追加しても登録済みの表は変わらない。

全操作の成功値を扱える共通reduceがある場合に使う。
操作ごとに更新規則が異なる場合や通常コマンドを混ぜる場合は、従来の個別登録を使う。

これでなくせたのは「commandsのキーをApplication側でも繰り返す」接続。
取得・保存・receiptの対応、認証済みidentity、保存の原子性は既存のadapterで引き続き明示する。
休暇のadapterは既に一度だけ定義されているため、それを隠す新しい汎用APIは追加していない。
業務の状態・検証・遷移だけでアプリ全体が完成するという保証ではない。

検証は`src/replay-operations.test.ts`の通常成功・再送・失敗・型拒否と、
`npm run test:use-case:package`の独立した休暇consumerの既存動作比較で行う。


共通adapterを各操作へ展開する部分は、さらに
[defineUseCaseGroup](use-case-group.md)で一度の宣言にまとめられる（alpha.5）。
