# 業務が指定した候補でpayloadも縮める

sampleModel/sampleModelAsyncは、任意のshrinkEventでイベントpayloadの簡単な候補を指定できる。
フレームワークが意味を知らないフィールドを自動で削除・変換する方式ではない。

```ts
import { sampleModel, sampleModelAsync } from 'koyuki/testing';
type Event = { amount: number };
// Deliberately incorrect implementation for this example.
const implementation = (total: number, event: Event) => total + event.amount + 1;
const model = {
  initial: [0], seed: 42,
  limits: { cases: 1, length: 10, shrinkAttempts: 100 },
  events: () => [{ amount: 100 }],
  step: (total: number, event: Event) => ({ state: total + event.amount, output: total + event.amount }),
  check: (before: number, event: Event, expected: { output: number }) => implementation(before, event) === expected.output,
  shrinkEvent: (event: Event) => event.amount > 0 ? [{ amount: 0 }] : [],
};
const sync = sampleModel(model);
const asyncResult = await sampleModelAsync({ ...model, check: async (...args) => model.check(...args) });
console.log(sync.kind, asyncResult.kind);
```

生成はamount 100から始まり、参照仕様と故意の不正実装の不一致を見つける。
amount 0でも不一致が残るため、その候補を採用する。元のoriginalと縮小後のwitnessを別々に保持する。

## 削除と置換の順序

まず既存の操作削除を試し、[shrinkInitial](initial-state-shrinking.md)があれば初期状態候補を、
その後、各イベントの候補を返却順に再検査する。
同じ理由の反例が残れば候補を採用し、操作削除を最初からやり直す。
payloadの変更によって前の準備操作が不要になる場合にも、古い列の削除検査だけで
one-deletion-minimalを報告しない。

理由の一致はimplementationまたはinvariantという分類であり、特定のエラーコードや
不具合の原因まで同じであることを判定するものではない。
acceptsがfalseになる候補は採用せず、モデルや比較の例外はdefectとして残す。

shrinkAttemptsは削除・初期状態・payload候補の比較で共有する上限。
同じ候補を返し続けたり候補が循環したりしても、比較回数の上限でlimitedとなる。
shrinkerは同期的に終了し、有限の候補配列を返す必要がある。callbackの計算時間や配列の大きさまでは制限しない。
shrinkEventへはイベントのコピーを渡し、返された候補もsnapshotする。
getterや非対応値を変質させず、失敗はsnapshotのdefect、shrinker自体の例外はshrink-eventのdefectとなる。

## 実例と残る範囲

[unit検査](../src/model-sequences.test.ts)では、payloadの簡略化後に不要になった準備操作を削除し、
2操作から1操作へ縮める。同期・非同期の一致、所有コピー、適用範囲、循環、例外も検査する。
[タグの検査](../src/tag-model-sequences.test.ts)では、古いversionを無視する故意のwrapperに対し、
メモリ・SQLite両方でrenameのlabelをBから空文字へ変えても、仕様との差が残ることを確認する。
この場合、期待仕様は入力検証より先にversionを拒否する。shrinkerがこの優先順位を変更したわけではない。

完了した削除検査が意味するのは、受け付ける1操作の削除で同じ分類の不一致が残らないこと。
payload候補を試しても、任意の値空間における最小値や、全候補の最短操作列は保証しない。
[初期状態の縮小](initial-state-shrinking.md)も任意の候補で指定できる。テスト雛形の出力は未提供。
Issue #8の具体化であり、全講演の実装完了や任意の業務モデルの正しさの証明ではない。
