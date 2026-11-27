# 既存の予約業務へ日程変更を追加する

保守者AIによる業務追加・仕様変更の試用記録。講演の新しい必須要件ではなく、既存の公開APIで実際の業務を追加できるかを確かめる例である。人間の初見評価とは区別する。

## この例の業務仕様

- 承認済みの予約を、予約の所有者が変更する。managerであるだけでは変更できない。
- 元の開始時刻の24時間前までは変更可能。ちょうど24時間前は許可する。
- 変更先は現在より未来の整数ミリ秒。元と同じ日時への新規要求はUnchangedとなる。
- 予約ID・所有者・承認者は変えず、承認済みの状態を維持する。
- 保存と日程変更イベントを同じ境界で確定し、保存後に通知する。
- 期限を48時間へ変更する場合、部品のnoticeHoursだけを変える。

空き枠・施設の営業時間・料金差額・再承認が必要な業務なら、別途その仕様と検証を加える。この例はそれらを自動判定しない。

## 普通のTypeScriptで業務を定義する

[domain.ts](../src/experiments/declarative-booking/domain.ts)に、RescheduleInput、RescheduleChange、authorizeRescheduling、reschedule、外部入力とイベントの復元を追加した。

```ts
const rescheduling = workflow('authorize-rescheduling', authorizeRescheduling)
  .then('reschedule', reschedule);
```

承認済みというタグは変わらない。認可後の証明には変更前の状態と変更先の日時をコピーし、後から呼び出し元の値が変わっても影響しない。業務計算は変更前・変更後の組を返し、保存関数は変更後のConfirmedを含むExecutionを返す。計算と保存の出力が異なっても、既存の型検査と実行経路を利用できる。

## JSX・Context・Hooksで組み立てる

[rescheduling.tsx](../src/experiments/declarative-booking/rescheduling.tsx)が、既存の認証済み操作者Resourceを再利用し、予約・要求・時計と方針をneedsで接続する。

```tsx
<ActorContext.Provider value={authenticatedActor}>
  <Fragment>
    <ReschedulingBusiness
      repository={repository}
      clock={() => Date.now()}
      noticeHours={24}
    />
    <ReschedulingNotifications sender={sender} />
  </Fragment>
</ActorContext.Provider>
```

```ts
const input = parseRescheduleRequest(body);
if (!input.ok) return input;
return app.execute(rescheduleBooking, input.value);
```

操作の宣言とイベントの接続には、rescheduleBooking・bookingRescheduled・notifyReschedulingのオブジェクトを共有する。イベント名を再入力しない。取得結果のResultを手で展開したり、保存成功後に通知を呼ぶコードは書かない。時計も操作ごとに読み、Providerごとの操作者・Repository・期限を分離する。

新しいRepositoryの要求はload・reschedule・成功記録のlookupに限定した。日程変更に不要な既存のcommit・approvalReceiptまで実装させない。メモリ版・SQLite版は既存操作と新操作の両方の契約を実装する。

## 実際に見つかった弱点と修正

以前の予約保存は、draft→requested→confirmedという状態タグの変化で競合を検出していた。日程変更はconfirmed→confirmedなので、その条件だけでは同時変更を防げない。

RescheduleChangeに含めた変更前の日時・所有者・承認者を保存境界で照合し、一致した場合だけ更新する。メモリ版では比較から状態・outbox更新までawaitしない。SQLite版では条件付きUPDATEとoutbox INSERTを同じtransactionで行う。JSONのキー順が変わっても競合と誤認しないよう、JSON文字列全体ではなく論理フィールドを比較する。

同じ変更前状態を読んだ二つの要求では一方だけが保存され、他方はConcurrentChangeとなり、通知も一回だけになる。この競合条件は業務と保存方式に依存するため、フレームワークが状態タグだけから推測するものではない。

## 残る手書きと制約

| 利用者が書くこと | Koyukiへ任せること |
| --- | --- |
| 所有者・状態・期限・変更先の業務ルール | 関数合成の値の受け渡し、失敗停止、trace |
| 何を取得するかと取得方法 | 宣言したneedsからの取得と文脈の組み立て |
| 保存の競合条件とtransaction | 成功した保存後だけのイベント配送 |
| 発生イベント・通知の送り先・通知内容 | 宣言先への型付き配送、失敗の記録と分離 |

追加のフレームワーク実行時API・依存パッケージは不要だった。重複した操作者取得は既存Resourceを公開して再利用し、未使用のRepository操作を要求する型も除いた。再送のrequestIdとidentityは純粋な業務入力とは別のモジュールで扱う。一方、取得・保存・業務ルールを一切書かずに業務を追加できるという意味ではない。

後続で[requestId / receiptによる再送](rescheduling-replay.md)を追加した。同じrequestId・入力・操作者なら当時の成功結果をreplayedで返す。別requestIdで同じ日時を新たに要求した場合はUnchanged。保存済みイベントの再配送は、別アプリのdeliverで扱い、元の変更処理を再実行しない。配送はat-least-onceであり、実送信の重複防止やack方針はホストの責務。保持期間・常駐worker・実メールはこの例の対象外。

変更前状態の一致は比較した論理値によるものであり、同じ値へ戻るABAを履歴として検出する単調なversionではない。全変更の順番を識別する必要がある場合はversionを業務・保存契約へ追加する。

## 実行と検証

```sh
npm run prepare:connections -- ../my-connected-bookings
cd ../my-connected-bookings
npm install
npm run check
npm start
npm test
```

startは申請→自動承認→日程変更→通知をメモリ版で実行する。実メールは送らない。SQLiteの検証にはNode.js 26を使う。

`src/authoring-rescheduling.test.tsx`で、純粋な遷移・認可証明・期限±1ms・不正入力のI/Oゼロ・権限拒否・24h/48hの方針変更・操作者とRepositoryの分離・並行競合を確認する。SQLiteのoutbox書き込み失敗で状態もrollbackし、通知失敗では保存済み結果を維持することを確認する。DB再接続後のイベント復元・不正payloadの拒否・通知だけの再配送も含む。

`test:connections:package`は新部品・ドメイン・メモリ版・実際のテストを別プロジェクトへコピーし、公開importだけで同じ経路を実行する。TS6/7・生成宣言で追加の日時入力と成功・失敗型を保ち、日時不足・ID取り違え・イベント誤接続を拒否する。

2026-11-27の作業ツリーで、型検査・全1310テストが成功。配布パッケージの公開importだけでTS7.0.2 / TS6.0.3の型検査・宣言生成・生成宣言consumerと34実行テストが成功した。保存型の広がりと不正な絞り込み、view反映・Query更新・イベント配送を壊す負例も検出した。check:packageとtest:portableも成功し、実行時依存ゼロ・31ローカルJSモジュール・Node型なしの宣言・Nodeグローバルなしの実行を維持した。

後続の再送対応では入力にrequestIdが必須となった。この文書末尾の1310/34件は日程変更の初期追加時点の記録であり、最新の検証は[再送対応の記録](rescheduling-replay.md)を参照。
