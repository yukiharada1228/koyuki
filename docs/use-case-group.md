# 業務操作群の共通境界

alpha.5で追加したAPI。`defineUseCaseGroup`で共通の保存・要求情報・再送方針を定義し、
`.on`で操作ごとの取得と純粋な遷移を接続する。
`defineUseCase`やTargetの代替を強制するものではない。

## 休暇申請の全体

必要なAPIは`defineUseCaseGroup`、`GroupExecution`、`step`、`defineApplication`、
`operations`または`replayOperations`を`koyuki`からimportする。

以下は`npm run test:use-case:package`で実行・型検査する
[scripts/fixtures/leave-use-case-application.ts](../scripts/fixtures/leave-use-case-application.ts)の構成。
ドメイン関数とrepositoryの全体は[独立した休暇サンプル](../examples/leave/README.md)にある。

```ts
const submitted = {
  validate: step('authorize-submit', validateSubmission),
  require: [step('require-days', requireDays)] as const,
  evolve: step('submit', submit),
};

const model = defineUseCaseGroup({
  operation: (name: Operation) => `leave.${name}.v1`,
  save: (change: Change, execution: GroupExecution<Operation, Call<Input>>) =>
    repository.save(request(execution.name, execution.request), change),
  replay: {
    lookup: (execution: GroupExecution<Operation, Call<Input>>) =>
      repository.receipt(request(execution.name, execution.request)),
    resolveAfter: ['Conflict', 'InvalidState', 'StorageUnavailable'],
  },
});

const commands = {
  submit: model.on('submit', {
    load: (call: Call<SubmitInput>) => repository.load(call.input, identity),
    transition: submitted,
  }),
  approve: model.on('approve', {
    load: (call: Call<Input>) => repository.load(call.input, identity),
    transition: approved,
  }),
  withdraw: model.on('withdraw', {
    load: (call: Call<Input>) => repository.load(call.input, identity),
    transition: withdrawn,
  }),
};

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

`identity`はホストで認証したactorのコピー。`request`はこのidentityと操作名を加えて
repositoryの要求型へ変換する純粋関数。呼び出し側のinputから権限を受け取らない。

## 型と実行の契約

- `.on`の入力はloadから推論する。SubmitInputのdaysを省略したsubmit呼び出しは拒否する。
- loadの成功値→validate→require→evolve→共通saveの接続を型検査する。
- 成功値・各操作固有の失敗・共通保存の失敗・再送照会の失敗を戻り値に保持する。
- `name`は業務操作のキー。`operation`は外部識別子で、`operation(name)`で一度決める。
  既存receiptのキーやoperation IDを変更する必要はない。
- 各要求のcontextは個別に作り、外側をfreezeする。再送ありでは既存withReplayが要求をcloneする。
  plain実行では深いfreezeや要求のcloneを追加しない。入力所有権は既存Targetと同じ。
- `replay`を省略するとplain実行。saveの成功値をそのまま返す。
- `replay`を指定するとsaveは`Execution<Output>`を返す必要がある。
  lookupの成功結果も同じOutput型とする。既存withReplayの通常／詳細の契約を維持する。
- `resolveAfter`の文字列リストは、失敗値がオブジェクトでkindが一致するときだけ再照会する。
  配列はgroup定義時にコピーする。文字列自体の失敗は一致しない。
  複雑な方針は`(error: unknown) => boolean`で宣言する。
  操作群の全エラーは異なるため、この共有callbackの引数を特定操作の失敗型とは偽らない。
- 再照会はコマンドの再実行ではない。saveは一度のみ。元の失敗と最終結果は詳細記録で区別できる。
- 同じ成功時更新規則を持つ再送操作は`replayOperations`でApplicationへ渡す。
  通常操作の同じ更新規則は`operations(commands, reduce)`で一括登録する。
  別の更新規則を混ぜる場合は従来の個別`operation`／`replayOperation`を使う。
- commandのrun/runDetailedを直接呼ぶ場合、予期しないthrow/rejectは呼び出し元へ伝播する。
  Application経由では下記のcrashed状態にする。例外を「保存されなかった」という意味には変換しない。

## なくなった記述と残す記述

なくなったのは各操作のsave closure、lookupへの元要求・操作名の受け渡し、
再送wrapperの組み立て、Applicationでの操作キーの再列挙。
ドメインにResultのif/flatMapを書く必要もない。

loadは操作ごとに宣言する。取得対象や入力型が異なることは業務上の意味であり、
ひとつの広い型へ潰して省略しない。操作名とtransitionの対応も利用者が選ぶ。

保存の原子性、CAS、receiptと要求の対応、結果の復元、権限の検証はadapterとdomainの責任。
共通saveの引数型に全操作のChangeが入らない場合は、groupを分けるか個別UseCaseを使う。
任意の集約や保存方式を自動推測するものではない。

## 状態遷移で確認する

| 業務 | 入力状態・操作 | 成功状態 | 主な失敗 |
| --- | --- | --- | --- |
| 休暇 | 未登録・submit | pending、残日数を仮確保 | 権限、日数不正、容量不足、同時更新 |
| 休暇 | pending・approve | approved、仮確保を使用済みへ | 自己承認、権限、競合 |
| 休暇 | pending・withdraw | withdrawn、仮確保を解放 | 他人の操作、確定済み、競合 |
| 経費 | draft・submit | managerまたは自動承認 | 本人確認、金額、領収書 |
| 経費 | manager/finance・approve | 次の承認状態 | 自己承認、担当権限、競合 |
| 経費 | 審査中・return/reject | returned/rejected | 理由不足、権限、競合 |
| 経費 | returned・edit | draft、新しい申請周回 | 本人確認、入力不正、競合 |

休暇の容量や経費の承認経路はdomainに残る。frameworkが業務ルールを推測しない。

## 再現する

```sh
npm ci
npm run check
npm test
npm run test:use-case:package
npm run check:package
npm run test:portable
```

経費の既存SQLite・再送・修正のテストはgroupへ移行したコードを使用。
休暇はalpha.2固定の元コードを比較基準として残し、一時consumerに新しいapplicationを配置する。
consumerは内部importを使わず、packしたパッケージをインストールして型検査・テストする。


## Applicationの例外と表示

alpha.5では通常の`ready`→`running`→`ready / failed`に加え、
予期しない操作例外や成功時reduceの失敗を`crashed`として管理する。
`crashed`のerrorは`{ kind: 'UnexpectedException', message: string }`。
元の例外はcloneできるとは限らないため、状態へそのまま格納しない。

Applicationのdispatch成功は「イベントを処理できた」という意味で、
業務操作の成功とは異なる。最終state/viewを確認する。業務失敗はfailed、予期しない例外はcrashed。
両者ともdismissでreadyへ戻せる。dismissは再実行や保存の取り消しを行わない。
保存済みで応答だけ失われた場合や保存後の表示更新失敗もあるため、自動リトライしない。
必要な再照会・最新データの再取得はホストで判断する。

reduceは複製した表示状態を受け取り、新しい状態を返す。
reduceが途中で変更してからthrowした場合も元の表示状態を保持する。
返した状態やResultの失敗値がstructuredCloneできない場合もcrashedとなる。
初期状態はclone可能であること、viewは純粋に評価できることが契約。
初期化やviewの実装不備をcrashedへ無条件に吸収するものではない。

低レベルのdefineProgramとcommandの例外伝播契約は変更していない。
Applicationを使った場合の新しいterminal状態なので、網羅的なswitchを持つ利用者はcrashedを扱う必要がある。
