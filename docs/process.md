# 途中のI/Oを接続する

純粋な業務関数の合成にはworkflowやtransitionを使う。
途中で外部データの取得や配送が必要な場合は、processでI/O境界を明示する。
同期ResultとPromise<Result>を同じ純粋な関数列に混ぜない。

```ts
const delivery = process<Tick>()
  .effect('claim-email', tick => repository.claim(tick.now, tick.leaseMs))
  .effect('send-email', send)
  .effect('ack-email', message => repository.acknowledge(message));

const result = await delivery.run(tick);
const report = await delivery.runDetailed(anotherTick);
```

定義時にはI/Oを開始しない。runとrunDetailedはそれぞれ独立した実行であり、
同じ要求を両方へ渡せば2回実行される。キャッシュや暗黙の再送制御はない。
成功値を次へ渡し、最初のResultの失敗で後続を止める。
最初の入力・最後の成功値・全段階のエラー型を保持する。

through(workflow)で途中に純粋な計算を接続できる。
最後に純粋な判断と保存が必要なら、既存のcommit(mutation)へ渡す。
配送完了記録のような単なるI/Oのために、空のvalidate/evolveや架空のmutationを宣言する必要はない。

直接のrunDetailedは実行した段階のtraceとResultを返し、planはnull。
commitがある場合のplanは、最後のmutationが生成したplanとなる。
traceはインプロセスの実行記録であり、永続監査ログや再開用チェックポイントではない。

想定外のthrowやPromise rejectionは、そのまま呼び出し元へrejectする。
必要なSDKエラーの分類はfromPromise等のadapterで行う。
成功済みの外部副作用を後続の失敗によって自動的に取り消すことはない。
DB transaction・receipt・outbox・配送先の冪等性・lease管理は各adapterとホストの責務である。
入力のsnapshotは暗黙には取らず、長時間のI/O中の参照所有権も呼び出し側が扱う。

登録メールの実例は[永続イベント接続](registration-events.md)にある。
この直接実行APIは開発版の追加で、公開済みnpm alpha.5には含まれない。

## 途中の業務操作の詳細記録

```ts
process<Order>()
  .effect('reserve', { runDetailed: inventory.reserve.runDetailed })
  .commit(shipping.create);
```

effectのobject形式はActionReportを返すrunDetailedを1回呼び、内部traceの後にeffect自身の成否を追加する。
途中のplanは全体のplanに採用せず、値のdumpも追加しない。失敗した内部traceは残し、後続は停止する。
通常の関数形式は従来通り、その関数を1回呼び出した成否のみを記録する。
runDetailedを持つcallableをそのまま関数として渡しても、自動で詳細形式へ切り替えない。
ReplayReportは別の形式なのでobject形式には渡せない。replayの値で後続を進める意味は明示的に設計する。

## 接続先の入力型

effectの詳細操作とcommitは、前段が返し得るすべての成功値を受け取れる必要がある。
たとえば前段がstringを返す場合、`'approved'`だけを受け取る操作は接続できない。
状態Unionの一種類だけを受け取る操作には、先に実際の検証・型の絞り込みを行う。
単なるメソッド型の双変性でこの制約を迂回できないよう、接続契約は関数プロパティとして検査する。
この修正はdefineActionのload→mutation、withReplayのrun→runDetailedにも適用する。
従来コンパイルできた狭すぎる入力型は、開発版では型エラーになる。
