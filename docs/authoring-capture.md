# Hooksから途中状態を選択して観測する

開発版koyuki/experimentalのcreateApplicationでは、inspectの第3引数へ既存のWorkflowCaptureを渡せる。明示した各段階の入力・Resultから、必要な項目だけを選び、同じ実行のレポートへ返す。

```tsx
function selectedState(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const state = 'current' in value ? value.current : 'next' in value ? value.next : value;
  return state !== null && typeof state === 'object' && 'kind' in state
    && typeof state.kind === 'string' ? state.kind : null;
}

const report = await app.inspect(approval, input, {
  input: (value, step) => ({ step, state: selectedState(value) }),
  result: result => result.ok ? selectedState(result.value) : null,
});

// approve段階で、選択したmanagerからapprovedへの変化を調べられる。
console.log(report.observations);
console.log(report.observationErrors);
```

inspectは業務を実行し、成功すれば保存も行う。captureはその一度の実行を観測し、観測のためにload・業務計算・途中I/O・saveを再実行しない。第3引数を省略した戻り型と動作は維持する。

## 選ぶ値と返すレポート

inputとresultのselectorは同期の純粋関数として書く。selectorの返した値だけをsnapshotするため、未選択のフィールドを観測用に複製しない。inputはその段階を実行する前、resultはResultが返った後に選択する。呼出し元の値を後から変更しても、すでに取得したsnapshotは変わらない。並行するinspectも別々の観測配列を持つ。

観測配列・行はreadonlyとして返す。選んだ値の型はselectorから推論する。元の詳細レポートのresult・trace・planや、再送のattemptはそのまま保持し、独自レポートに同名のobservations/observationErrorsがある場合は今回のcapture結果へ置き換える。置き換える名前の型を元の型と交差させない。

observationsへ公開する項目は利用者が選ぶ。これは元のresult・planや他のレポート項目も伏せる機能ではない。ログへ保存する場合は、保存する項目を観測結果から明示的に取り出す。

## 失敗と観測範囲

selectorのthrowや選んだ値のsnapshot失敗は、step・phase・CaptureFailedという診断情報へ分ける。業務の成功・想定内失敗を置き換えず、後続の実行方針も変えない。誤って同じrealmの通常のnative Promiseを返した場合は、既存のsnapshotCaptureと同じく待たずに拒否し、nativeな拒否を未処理にしない。非同期selector、独自のthenable、selectorの任意の副作用を隔離する機能ではない。

業務I/Oの想定外のthrow/rejectは、元の例外でrejectする。その場合に完了したcaptureレポートを返すという契約は加えない。live observerを併用すると、同じ実行のspanと終端通知を受け取れる。

対象は既存の内部観測能力を持つ明示的なWorkflow・Process・Command・再送境界である。途中I/Oや詳細形式のloadにも入る。段階名だけのtraceを返す独自handlerは、内部の値を観測する能力がないため、そのtraceから入力・出力を推測しない。通常関数の内部、時刻だけを持つscope、外部システムの内部まで自動で取得するものではない。

この入口は、明示した内部段階を観測することへopt-inする。既存のbusinessやProcess単体のcaptureが持つI/O境界の扱いは変更しない。

## 再送・保存・検査

保存済みreceiptが見つかった場合は、snapshotとlookupの観測だけを残す。実行していない業務段階の観測を作らず、attemptはnullのままにする。

[専用検査](../src/authoring-capture.test.tsx)は状態変化、選択後のsnapshot、未選択accessorの非実行、capture失敗時の保存、途中I/Oとlive span、再送時の省略、並行capture、独自レポートの型の衝突を検査する。業務を再実行して観測値を作る方法は使わない。

配布物検査では実際の経費例で状態を観測する。TypeScript 6/7のNode型なしの型検査・宣言生成・戻り型注釈なしでcaptureをexportした[利用者側API](../examples/authoring/captured-exports.tsx)の生成宣言だけを読むconsumerでも、選択値の型・元のResult型・再送のattempt型を確認し、必要な入力の欠落を拒否する。

これは途中状態の明示的な観測への対応である。既定の全値収集、永続化、履歴の保持・削除、分散相関や原音確認の完了を意味しない。
