# inlineのgeneric要件と遷移callbackの推論

この制限は未解消。新しい実行APIや、any/unknownへ広げる回避は追加していない。
既存の一オブジェクト形式で、以下の宣言は型検査に失敗する。

```ts
const validate = (amount: number) => ok(amount);
const quote = (amount: number): Result<number, 'Declined'> =>
  amount > 0 ? ok(amount * 2) : err('Declined');

defineTransition({
  validate,
  require: [withInput(quote)],
  evolve: pair => ok(pair.input + pair.value),
});
```

観測できた診断は、requireの要素がundefinedに代入できないことと、pairにinput/valueがないこと。
このケースでは推論結果が空のrequire tupleとvalidateの成功型に戻っており、
実際に渡した要件の出力をcallbackへ渡せていない。
TSの内部実装における原因まで証明した記録ではない。

## 現在使える書き方

```ts
const quoted = withInput(quote);
const declared = defineTransition({
  validate,
  require: [quoted],
  evolve: pair => ok(pair.input + pair.value),
});
```

あるいは、evolveの入力型を業務関数の定義で明示する。
どちらも業務関数の実行順・失敗伝播・保存への接続は既存runtimeへ委譲できる。
ライブラリがtupleの接続・成功型・失敗型をanyへ変えて解決したことにはしない。

[scripts/fixtures/transition-inference-limit.ts](../scripts/fixtures/transition-inference-limit.ts)は
実際の開発版tarballを別ディレクトリへインストールし、Node型なしで型検査する。
既知の不正推論を拒否し、名前付き要件を使う宣言について入力型・成功型・失敗型の一致を検査する。
TS更新等により制限が解消すれば、不要になったts-expect-errorが失敗し、再評価を促す。

[src/transition-inference.test.ts](../src/transition-inference.test.ts)では、
複数の名前付きgeneric要件を依存順に接続し、元の入力・中間成功値・両要件の失敗型を保持できることも検査する。
途中失敗はevolveへ進まない。この実例も同じ配布物のconsumerで実行する。

## 判断

この調査では、既存の接続拒否と型の精度を維持して一オブジェクトの制限を解消する実装には至らなかった。
推論のためだけに第2引数形式や別builderを公開して、APIの種類を増やす変更は採用していない。
名前付きの通常関数を中心とする使い方を維持し、この例を改善前の再現基準にする。

また、withInputを重ねるとinput/valueが入れ子になる。複雑な業務では、
中間状態に業務上の名前を与えた通常の関数・型も比較対象にする。
名前付きにすればReact/Elm相当の書き心地になる、という実証ではない。
