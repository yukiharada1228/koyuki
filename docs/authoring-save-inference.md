# 保存後も業務の状態型を保つ

開発版`koyuki/experimental`の`defineOperation`で、入力を保つgenericな保存関数の成功型を改善した。公開APIの項目、JSX、Hooks、実行処理は増やしていない。

## 予約例で起きていたこと

予約の保存Hookは、保存した状態をそのまま返す契約を持つ。

```ts
function useSaveBooking() {
  const repository = useContext(Bookings);
  return <S extends Booking>(value: S, input: Input, events: readonly EventEnvelope[]) =>
    repository.commit(value, input, events);
}
```

以前は、このHookを`useSave`へ渡すと、申請の`Requested`も承認の`Confirmed`も、操作の成功値では`Booking`全体に広がっていた。計算の型は正しくても、保存後に再び状態を絞る負担が残っていた。

現在は同じ宣言のまま、次の型を推論する。

| 操作 | 成功値 |
| --- | --- |
| `submitBooking` / `requestAutomaticApproval` | `{ readonly kind: 'committed'; readonly value: Requested }` |
| `approveBooking` | `{ readonly kind: 'committed'; readonly value: Confirmed }` |

操作入力・エラーUnion・詳細レポートも維持する。業務側の型引数、保存ラッパー、型アサーションを追加する必要はない。JSX登録・イベント接続・実行方法も変わらない。

## 絞ってよい保存だけを絞る

`defineOperation`は実際の保存関数の型を取り、候補となる狭い戻り値をその関数が保証しているか検査する。

- `<T extends State>(value: T) => Promise<Result<T, E>>`なら、計算結果の状態型を保持する。
- `committed` / `replayed`のラッパー内の`value`についても、保存関数が保証する場合に保持する。ラッパーの他のフィールドは削らない。
- `(value: State) => Promise<Result<State, E>>`は広い契約を保つ。実際に別の状態を返し得るため、計算結果の型だけを根拠に絞らない。
- DTOや保存件数などへ変換する保存関数は、その戻り値型を保つ。
- 計算結果を受け取れない保存関数は型エラーとなる。

generic保存を先に取得するオーバーロードと、inline callbackへ文脈型を渡す従来のオーバーロードを分けている。前者の順序を後ろへ動かすと、先の候補による文脈推論の影響で、generic保存の正例が拒否されることがある。TS6/7の配布consumerで順序も含めて検証する。

## 範囲と制約

今回の改善対象は`needs`形式で`useReplay`を持たない操作である。再送付き操作はreceiptの成功値も返すため、計算結果だけで狭めない。既存の再送用オーバーロードとreceipt契約は変更しない。factory形式の操作宣言も従来どおり。

任意の多相変換、任意の入れ子の保存結果、すべての型注釈の省略を保証するものではない。TypeScriptの型に反する実装、anyや無検証の型アサーションも保証外。関数の純粋性や業務仕様の正しさの証明ではない。

これは講演の「型で接続を支援しながら記述の負担を減らす」という論点への改善であり、講演全体への完全準拠や、人間の初見評価の完了を意味しない。

## 検証

`src/authoring-wiring-contracts.test.tsx`で、genericな直接保存・ラッパー保存・別状態を返す広い保存・DTOへの変換を比較する。広い保存が実際にpendingを返すことも実行して確かめ、型だけを都合よく絞っていないことを検証する。`src/authoring-wiring.test.tsx`では実際の申請・承認の成功型とエラー型を検査する。

`test:connections:package`は同じ契約を公開importだけの別プロジェクトへ持ち込み、TS7.0.2 / TS6.0.3で型検査・宣言生成・生成宣言のconsumerを検査する。生成宣言から予約承認のConfirmedまで保持されることを確認する。

配布型の精度を故意に広げる対照と、保存の保証を無視して狭める対照をそれぞれ作り、正例と拒否検査が両方の退行を検出することも確認する。runtimeの保存・再送・配送処理には変更を加えていない。

2026-11-27の検証では、ルートの型検査・全1304テスト、配布物のTS6/7・28実行テストと上記の型退行対照、三業務の配布物検証、Quick Startが成功した。実行時外部依存ゼロ・31ローカルJSモジュール・Node型なしの宣言検査と、Nodeグローバルなしのブラウザー実行も成功した。公開版npmの更新やリモートCIの再実行は行っていない。
