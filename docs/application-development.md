# 業務宣言からApplicationまで

開発版の利用手順。`defineTransition`と以下の実行時修正は公開alpha.5には含まれない。
実際にコンパイル・実行するコードは[独立consumerの定義](../scripts/fixtures/leave-functions-application.ts)と
[Application全体のテスト](../scripts/fixtures/leave-application-lifecycle.test.ts)にある。

## 何を利用者が書くか

休暇の業務状態は`pending | approved | withdrawn`という直和。
申請は本人・日数・状態の検証後、残日数の証拠を得て予約を作る。
承認は管理者権限を検証して使用済みに、取消は本人を検証して予約を解放する。

| 入力状態 | 操作 | 成功状態 | 主な業務失敗 |
| --- | --- | --- | --- |
| 同じIDの申請なし | submit | pending | Forbidden / InvalidInput / InsufficientDays |
| pending | approve | approved | Forbidden / InvalidState |
| pending | withdraw | withdrawn | Forbidden / InvalidState |
| approved / withdrawn | approve / withdraw | 変更しない | InvalidState |

この状態・検証・遷移は通常のTypeScriptの型と純粋関数で記述する。
検証済みの値だけを遷移が受け取れるよう、private brandで証拠を型にする。

```ts
const submitted = defineTransition({
  validate: validateSubmission,
  require: [requireDays],
  evolve: submit,
});
const approved = defineTransition({ validate: validateApproval, evolve: approve });
const withdrawn = defineTransition({ validate: validateWithdrawal, evolve: withdraw });
```

証拠を受け渡すResultの分岐は不要。失敗した段階で後続の判断・保存が止まる。
テスト用fixtureは既存traceとの比較のため、requireDaysだけ`step`で名前を明示している。

次に、要求の型、信頼できるactor、load、共通saveとreceiptを接続する。
これはDBの選択・認証・業務操作と保存先の対応を決める宣言であり、
フレームワークが関数名や型から推測して決めることはしない。
`defineUseCaseGroup`は共通save・再送方針を一度だけ定義し、各操作にはloadとtransitionを指定する。

最後に、操作群・成功値の投影・Viewを指定する。

```ts
return defineApplication({
  initial: () => initial,
  operations: replayOperations(commands, (_before: Account, after: Account) => after),
  view: state => ({
    account: state.data,
    balance: balance(state.data),
    busy: state.kind === 'running',
    error: state.kind === 'failed' || state.kind === 'crashed' ? state.error.kind : null,
  }),
});
```

`session.dispatch({ type: 'submit', input: call })`から、取得・検証・前提条件・遷移・保存、
`running → ready / failed / crashed`、購読通知までruntimeが処理する。
操作名をApplication用に列挙し直したり、完了イベントやResultの接続を自分で書く必要はない。
`dispatch`の成功はイベント処理の受理を示し、業務の成功は返ったstateで確認する。
再送の過去の成功値は現在の投影を巻き戻さない。

## 実行時の所有権と並行性

外部イベントはdispatch時点で[共通snapshotの形式検査](application-ownership.md)を行ってコピーし、待ち行列中の呼び出し元の変更を受けない。
コピーできない入力や、情報を失う入力はDataCloneErrorとしてPromiseをrejectし、状態・trace・後続イベントを変更しない。
状態も同じsnapshot境界を持ち、受理できないreducer結果は状態を交換する前に拒否する。
関数や接続オブジェクトはeventへ入れずadapterへ置く。Viewの戻り値はモデルとしてcloneしない。

同じsessionの外部イベントは順次処理する。expectedRevisionは実行直前のrevisionと比較し、
古い画面からの操作をIO前に拒否する。業務操作には通常、実行開始と完了で二回のrevision更新がある。
このrevisionはDBのversionではない。異なるsession間の競合はrepositoryのCASで扱う。

subscribeは現在のsnapshotを同期通知する。初回通知がthrowしたら登録せず、その例外を呼び出し元に返す。
登録後の通知失敗は受理済みの業務処理を中断しない。表示側でエラーを報告し、不要になった購読は解除する。

## 確認できる範囲

```sh
npm run check
npm test
npm run test:transition:package
npm run check:package
npm run test:portable
```

配布tarballをリポジトリ外へインストールしたconsumerで、HTTPの既存テストに加え、
Applicationの成功・失敗・dismiss・取消・再送・View更新、待機中の入力変更、古いrevisionのIO前拒否を検証する。
配布型から申請の日数省略と内部完了イベントの送信も拒否される。
NodeグローバルなしのVMでも入力の所有権を検証する。

認可、状態の不変条件、DBトランザクション、receiptとの原子保存、要求IDの意味は利用者の業務・adapterの責務。
HonoはHTTP境界に置ける。永続的な長期処理やサービス間のexactly-onceをこのインプロセスloopで保証しない。
これはReact/Elmの実行管理に着想した業務向け設計で、UIレンダリングや任意の副作用の自動化を行うものではない。

## オブジェクトメソッドをそのまま登録する

operation / operations / replayOperation / replayOperationsは、登録したcommandを
元のreceiverに結び付けて呼び出す。例えば`run`が`this.repository`を参照するオブジェクトでも、
利用者が`input => command.run(input)`のラッパーを書く必要はない。
登録時にはrunを実行しない。メソッドの参照は登録時に保持し、呼出し時のthisは元のcommandとなる。
command自体をcloneやfreezeする契約ではない。

[src/application-receiver.test.ts](../src/application-receiver.test.ts)で単体・一括の通常操作と
再送対応操作を検査する。成功時の投影、業務失敗時に投影しないこと、
replayed時に過去の成功値で投影を進めないことを保つ。
この修正は外部オブジェクトの純粋性・永続化・再試行方針を保証するものではない。
