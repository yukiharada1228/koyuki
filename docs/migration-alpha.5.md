# alpha.5への移行

公開候補の移行案内。alpha.4以前から更新する場合の変更点。

```sh
npm install koyuki@0.1.0-alpha.5
```

## 新APIは任意

単一操作のdefineUseCase、defineTarget、defineRequestTarget、withReplayは維持する。
同じ保存・再送境界を共有する複数操作にはdefineUseCaseGroupを使える。
操作ごとに異なる入力・失敗型を保つ。既存の業務状態・検証・遷移を変更する必要はない。

同じ表示更新規則なら、通常操作にはoperations、再送対応操作にはreplayOperationsを使い、
Applicationの操作名の再列挙を省ける。異なる更新規則は従来通り個別登録する。
[全体例](use-case-group.md)を参照。

## Applicationの状態Unionにcrashedを追加

**型と実行時の互換性に関わる変更。** ready / running / failedに加え、
予期しない操作例外、reduceの失敗、状態・失敗値のclone失敗をcrashedとして扱う。

```ts
view: state => ({
  data: state.data,
  busy: state.kind === 'running',
  error: state.kind === 'failed' || state.kind === 'crashed'
    ? state.error.kind
    : null,
})
```

網羅的なswitchやUIの操作許可にはcrashedも追加する。
crashedのerrorは`{ kind: 'UnexpectedException'; message: string }`。
元の例外そのものは状態へ格納しない。

Applicationのdispatchは操作のthrow/rejectでPromiseを拒否する代わりに、
crashed状態までイベントを処理して成功Resultを返す。
dispatchの成功は業務操作の成功を意味しない。state/viewでready・failed・crashedを確認する。
通常の業務失敗の型はfailedに保持し、UnexpectedExceptionを混ぜない。

failedとcrashedはdismissでreadyへ戻せる。dismissは表示状態の解除だけを行う。
保存済みで応答が失われた場合もあるため、rollbackや自動再試行はしない。
必要に応じてホストで現在の永続状態を再取得する。
reduce失敗時は実行前の表示データを保持する。

commandのrun/runDetailedを直接呼ぶ場合と、低レベルdefineProgramの例外伝播は変更しない。
初期状態はstructuredClone可能、viewは純粋に評価できるという契約も維持する。

## 共有する再送方針

defineUseCaseGroupのreplay.resolveAfterはkindの文字列リスト、またはunknownを受ける関数。
操作群のエラーは異なるため、共有callbackを特定操作のエラー型へ狭めない。
従来の単一UseCaseのresolveAfterの推論は変更しない。

receiptと更新の原子的な保存、要求のfingerprint、認証・認可、保存競合の防止はadapterの責任。
HTTPの再送照会は認証・アクセス制御より後に置く。
[休暇HTTPサンプル](../examples/leave-http/README.md)で確認できる。

## 実行環境と依存

コアのWeb標準APIのみ・実行時外部依存ゼロは維持する。
Hono・SQLite・Nodeサーバーはサンプル側の依存。
今回追加したAPIの互換性はNodeグローバルなしのVMとパッケージ型検査で確認する。
alpha.4での公開Workers／実ブラウザ検証を、alpha.5で再実施したという意味ではない。
