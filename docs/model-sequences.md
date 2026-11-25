# seedで再現するモデル検査と反例の縮小

開発版koyuki/testingのsampleModelは、利用側の独立した参照仕様から操作列を選び、
各段階で実装と比較する。既存の有限幅優先探索exploreModelとは別の検査である。

```ts
import { sampleModel } from 'koyuki/testing';

const implementation = (total: number, amount: number) => total + amount;
const report = sampleModel({
  initial: [0],
  seed: 42,
  limits: { cases: 100, length: 20, shrinkAttempts: 200 },
  events: (_state, random) => [1, Math.floor(random() * 10)],
  step: (total, amount) => ({ state: total + amount, output: total + amount }),
  check: (before, amount, expected) => implementation(before, amount) === expected.output,
  invariant: total => total >= 0,
});
console.log(report.kind);
```

これは普通の関数を検査する例。期待仕様のstep・invariantは利用者が独立に指定する。
実装が返した結果から期待値を自動生成しない。実装とモデルが同じコードを共有すれば、
同じ誤りを見逃し得るため、その独立性は利用者の責任である。

## 再現と出力

seedは0から2^32-1の整数。初期状態と各段階の候補を、固定した32bit LCGで選択する。
events内でランダムな入力を生成するときも、引数のrandomだけを使う。
同じモデル・入力・順序・実装・library版とseedなら再現できる。Date.nowやMath.random、
外部I/O等に依存するcallbackの再現性は保証しない。
casesは1以上、lengthとshrinkAttemptsは0以上の安全な整数で明示する。

| kind | 意味 |
| --- | --- |
| sampled | 指定した試行範囲で反例がなかった。全状態を検査したpassedではない |
| counterexample | 実装比較か不変条件の失敗。seed、original、縮小後のwitness、縮小状態を返す |
| defect | モデル・生成器・比較等の例外や不正な戻り値。phaseと元のcauseを保つ |

casesは開始した試行数、transitionsは実装比較した辺数で縮小時も含む。
shrinkAttemptsは反例の候補を再検査した回数。これらの上限はcallbackの処理時間や
候補配列のメモリ量まで制限するものではない。callbackは同期的に終了する必要がある。

## 操作を削除して縮める

失敗した初期状態を固定し、操作の連続した範囲を削除して同じ種類の失敗を再検査する。
最後に1操作ずつの削除を試す。各候補は初期状態からやり直し、生成時の乱数は使わない。
step・invariantは純粋な参照仕様とする。checkは同じbefore状態を独立に比較できる必要がある。
検査用DB等を使う場合の状態再構築と後片付けは、[非同期比較](async-model-sequences.md)の契約を参照する。

- one-deletion-minimal：受け付ける各1操作の削除では、同じ種類の反例が残らなかった。
- limited：明示した縮小回数へ到達した。最小と扱わず、その時点の反例を返す。

これは全候補における最短列の証明ではない。任意の[shrinkEvent](event-payload-shrinking.md)を指定すれば、
業務が与えるpayload候補も再検査する。[shrinkInitial](initial-state-shrinking.md)で初期状態の候補も指定できる。
別の理由の失敗を見つけても、元の理由の反例を縮めたことにはしない。
モデルの例外を「無効な候補」として黙って捨てず、defectとして停止する。

参照モデルが一部の状態・操作の組合せを扱わない場合は、accepts(state,event)で示す。
縮小中にfalseとなった候補は採用しない。生成器がfalseとなる操作を返した場合はdefect。
acceptsは参照モデルの適用範囲であり、権限拒否や不正な業務入力を除外する機能ではない。
それらも業務の正当な失敗として検証するなら、stepが失敗結果と変わらない状態を返す。

## 所有境界と検証範囲

初期状態・生成した候補・期待値・各callback引数は既存のowned data snapshot契約を使う。
callback間や元の入力に変更を漏らさず、getterやclass等の非対応値を変質させて受け入れない。
反例と例外は明示的なテスト診断であり、通常の業務実行から自動収集するものではない。

[検査入口のテスト](../src/model-sequences.test.ts)は再現、縮小、適用範囲、上限、欠陥、コピーを確認する。
[経費の検査](../src/expense-state-exploration.test.ts)は3 seedで6,144操作を独立仕様と照合し、
4金額境界、6状態、権限・自己承認・領収書・理由・終端・不正編集の失敗を確認する。
故意に壊した操作者の変換を挟むと申請→自己承認の反例を得る。
両方を実tarballのconsumerにも含め、Node型なしの宣言検査とNode globalなしの実行も確認する。

Issue #8の部分実装。[タグの共通生成契約](tag-model-sequences.md)では重複・上限・古いversionを
メモリ/SQLiteで比較する。生成後のasync比較はhostテスト側の処理で、sampleModelの非同期checkではない。
[sampleModelAsync](async-model-sequences.md)は、隔離した非同期比較でも同じ反例削除を行える。
[payload候補の縮小](event-payload-shrinking.md)と[テスト雛形の出力](model-test-template.md)も追加した。
雛形の期待仕様・生成器・実装比較は利用者が埋める。全候補での最短列は未検証。
記述済みの契約は`--contract`で接続でき、タグの同じ参照仕様と生成器から
メモリ／SQLiteの6テストを生成し、配布物の利用側でも型検査・実行する。
経費の独立仕様からも同じ入口で3 seedのドメイン比較を生成する。
[タグの変更再保存](tag-replay-model-sequences.md)も同じ生成入口へ接続し、
同一・旧版・改変したスナップショットを両adapterで比較する。要求ID付き再送の網羅とはしない。
既存の到達確認と有限探索もこの仕様を共有し、DBや認証境界の検査とは区別する。
講演の純粋な業務関数・明示的な状態を検査へ使う具体化であり、講演がこのAPIを指定した意味ではない。
