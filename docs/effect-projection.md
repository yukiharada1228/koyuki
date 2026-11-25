# 取得成功値から次の入力を作る

開発版のProcess.effectは、第3引数に普通の関数を渡せる。
外部取得のResultが成功したときだけ、その成功値と前のcontextから次段の入力を作る。
公開npm alpha.5には含まれない。

```ts
import { process, type Result } from 'koyuki';

type Input = { orderId: string; actorId: string };
declare function readOrder(id: string): Promise<Result<{ id: string; amount: number }, 'Unavailable'>>;
declare function readBudget(actorId: string): Promise<Result<number, 'Forbidden'>>;

const load = process<Input>()
  .effect('read-order', context => readOrder(context.orderId),
    (context, order) => ({ ...context, order }))
  .effect('read-budget', context => readBudget(context.actorId),
    (context, budget) => ({ ...context, budget }));

// load.run(input): Promise<Result<Input & { order: ...; budget: number }, 'Unavailable' | 'Forbidden'>>
// load自体をbusinessの詳細loaderとして渡せる。
```

取得関数だけを渡す従来のeffectは、成功値をそのまま次へ渡す。
第3引数を使うと、Resultを取り出すif、okで包み直す処理、汎用的なattachヘルパーは不要。
どの値を保持し、どの名前で公開するかは関数の戻り値で明示する。
自動でrecordを結合したり、動的なキーを型として捏造したりはしない。
元の入力型・取得成功型・全失敗型は保持し、projectorの型注釈で取得成功型を緩めない。

## 実行と失敗

取得は1回だけ実行する。Resultが失敗ならprojectorと後続を呼ばず、元の失敗を返す。
projectorは成功後に同期的に呼ぶ普通の関数で、返却値を次段へ渡す。
返却値がResultでも自動flattenせず、Promiseでも自動awaitしない。
非同期I/Oの接続には次のeffectを使い、同期の業務判断の接続にはthrough(workflow)を使う。
projectorがthrowした場合はその例外でrejectし、成功済みの取得を再実行しない。
副作用のrollbackやcallbackの純粋性は保証しない。

contextや取得値を暗黙にclone/freezeしない。参照を保持するか、新しく構築するかはprojectorが選ぶ。
class・Symbol・既存の入力参照もそのまま扱える。一方、I/O中の入力変更やcallbackの破壊的変更を
安全にする機能ではない。Application・replay等の別のsnapshot境界には、それぞれの契約がある。

詳細loaderのobject形式も使え、receiverと内部traceを維持する。
選択値captureは外側のeffect全体の入力と、投影後のResultを対象とし、内部取得値を勝手に追加収集しない。
live spanも外側のeffectに入力構築を含む。詳細loaderのIO成功後にprojectorがthrowした場合、
内側はok、外側はdefectとして閉じる。
構成図は従来と同じeffect一段で、projector内部のデータフローを自動解析するものではない。

## 実例と評価

[購買loader](../src/experiments/procurement/context-process.ts)は、請求書・入荷から関連データを取得する
5か所のattachをこの形式に置き換えた。ローカルなResult分岐と型アサーションが不要になった。
在庫NotFoundのnull化、取得順序、認可範囲、関連請求書の絞り込みは業務判断として残す。
各readの失敗・例外、genericな追加入力、入力参照とSymbol、4業務操作と全6モデルの保存後状態を
既存のメモリ・SQLite比較で照合する。[比較範囲](procurement-load-composition.md)を参照。

新しいデータ名のDSLではなく、既存effectの任意の引数として採用した。
書く必要があるのは取得関数と次の入力構築で、Resultの接続はruntimeへ委譲する。
これだけでReact/Elmと同等の書き心地や、独立利用者の生産性優位が実証されたとは扱わない。

[専用検査](../src/process-projection.test.ts)は型の維持、不正な接続の拒否、失敗停止、例外、
参照とopaque値、capture、live span、詳細loader、並行実行、従来の2引数契約を対象にする。
実tarballのconsumer、Node型なしの配布宣言、Node globalなしのbundleでも検査する。
