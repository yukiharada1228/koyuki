# 深いgeneric出力の推論候補の比較

深い入れ子を持つ共有generic関数の対応は未解消。再現例が通るだけでは採用せず、既存の業務経路の型契約と同時に検査する。

対象は、別のgeneric呼び出し元の未確定なTを、`{ item: { value: T } }`の中から取り出す例である。

```ts
const wrap = <T>(input: T): Result<{ item: { value: T } }, 'Refused'> =>
  ok({ item: { value: input } });
function forward<T>(input: T) {
  return transition(defineTransition({
    validate: (value: T) => ok(value),
    require: [step('wrap', withInput(wrap))],
    evolve: pair => ok(pair.value.item.value),
  })).run(input);
}
```

現行実装では、戻り値が`Result<T, 'Refused'>`であるという厳密な型比較が成立しない。
実行時の処理が壊れるという意味ではなく、宣言した関数の対応が推論に十分反映されない問題である。

## 比較する候補

[scripts/investigate-deep-output.mjs](../scripts/investigate-deep-output.mjs)は隔離したコピーで、次の3方式を同じ再現例・既存ソースに対して検査する。

- `current`：変更なし。既存の型契約は通り、深い出力の厳密な比較は不受理。
- `unknown-leaf-paths-global`：unknownの末端へのパスを調べ、producerが任意のTに対して保証するパスを合成する。全段階に適用し、既に具体的なinputを持つpairは元の推論へ戻す。
- `unknown-leaf-paths-universal-pair`：同じ候補を、既存の任意のTに対するpairのproducer判定が成功した分岐だけへ入れる。

両候補とも、個々のパスだけでなく、合成した出力全体について任意のT・実際の入力の両方でproducerの保証を検査し、元の出力のsubtypeであることも要求する。
同じ構造の再訪を止め、関数の内部へは進まない。最大深さを固定する方式ではない。
これは型レベルの研究候補であり、任意の再帰型やclassを扱えるという保証はしていない。

現時点では両候補を不採用とする。全段階への候補は既存のgeneric呼び出し元を含む推論が崩れる。
pairの分岐だけへ入れる候補は再現例を受理する一方、購買フロー等の既存契約で多数の診断が発生する。
条件型の分岐が増えることで既存の入力・出力の比較が未確定のまま残る箇所があり、後段までその影響が伝播する。
診断件数を独立した不具合の件数とは数えない。

## 再現

```sh
node scripts/investigate-deep-output.mjs
node scripts/investigate-deep-output.mjs --compiler /path/to/typescript6/tsc
```

collectorは変更前の既存ソースを先に検査し、gitの基準、ソースの変更有無、collectorと再現例と候補のhash、compiler版、再現例の受理、既存診断の位置を記録する。
コンパイラの異常終了は型の不受理と混同せず失敗させる。作業ツリーのコアは変更しない。

[TypeScript 6.0.3](deep-output-investigation6.json)・[7.0.2](deep-output-investigation7.json)の記録を比較する。
次の検討では、既に型が確定しているgenericな段階を新たな条件型で包まないことと、深い出力の対応をproducer自身から得ることを両立する必要がある。
この不採用はTypeScriptでの実現不可能性の証明ではない。

独立利用者の評価・直接音声確認は追加していない。9話題のpartialと、講演全体の部分充足は維持する。
