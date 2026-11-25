# 初期状態も業務が指定した候補で縮める

sampleModel/sampleModelAsyncのshrinkInitialで、反例の初期状態を簡略化できる。
状態の意味や必須フィールドをフレームワークが推測して削除する方式ではない。

```ts
import { sampleModel, sampleModelAsync } from 'koyuki/testing';
const model = {
  initial: [100], seed: 0,
  limits: { cases: 1, length: 1, shrinkAttempts: 50 },
  events: () => [1],
  step: (state: number, event: number) => ({ state, output: event }),
  // Deliberate implementation mismatch when state >= event.
  check: (state: number, event: number) => state < event,
  shrinkInitial: (state: number) => state > 0 ? [0] : [],
  shrinkEvent: (event: number) => event > 0 ? [0] : [],
};
const sync = sampleModel(model);
const asynchronous = await sampleModelAsync({ ...model, check: async (state, event) => model.check(state, event) });
console.log(sync.kind, asynchronous.kind);
```

この例はinitial:100/events:[1]からinitial:0/events:[0]へ縮む。
最初は初期状態0だけに変えても不一致が残らないが、payloadを0に変えた後なら再現する。
そのため、一度不採用だった初期状態候補も、他の縮小を採用した後は再検査する。

## 契約

削除→初期状態候補→イベントpayload候補の順に試す。
同じ理由（implementationまたはinvariant）の反例が再現した候補を採用し、削除からやり直す。
理由の分類は一致させるが、エラーコードや不具合の根本原因の同一性までは判定しない。
初期状態の不変条件違反ならイベントが空でも縮小する。
acceptsがfalseになる操作列や、失敗を再現しない候補は採用しない。

すべての候補は共通のshrinkAttempts上限を消費する。
同じ状態を返し続ける、または循環するshrinkerは予算到達でlimitedとなる。
同期callbackは有限の候補配列を返し、自身で終了する必要がある。
callbackの計算時間やメモリは上限の対象外。

引数と候補はsnapshotで隔離し、元のoriginalを保持する。
getterや非対応値はsnapshotのdefectとなり、getterは実行しない。
shrinkerの例外や配列以外の戻り値はshrink-initialのdefectとして扱う。
DB等の比較は、候補ごとのbefore状態から再構築する[非同期比較の契約](async-model-sequences.md)に従う。
縮小関数自身でDBを操作する設計ではない。

one-deletion-minimalは、最終の状態とpayloadについて、受け付ける1操作の削除では
同じ分類の反例が残らないという意味。最小の初期状態、候補空間全体の最短列、形式的証明ではない。
候補の「より簡単」という順序は業務側が決める。

[経費の独立仕様との比較](../src/expense-state-exploration.test.ts)では、故意の自己承認バグについて
100,001円を3,001円へ縮め、submit→approveの不一致を維持する。
3,000円と領収書なしは同じ不一致を再現しないため採用しない。
[unit検査](../src/model-sequences.test.ts)では削除・payloadとの再検査、所有境界、
同期と非同期の一致、空の操作列、循環、予算、例外を検査する。

これはテスト支援の追加であり、全講演の完全実現や、任意の業務の正しさを示すものではない。
テスト雛形の出力と候補空間全体の最短列は未提供。
