# 再送後に影響対象の現在値を表示する

[Application比較](procurement-application-comparison.md)で確認した、応答消失後にDBへ保存済みでも空のViewが残る制約に対応する。
既存procurementReplayApplicationはそのまま維持し、現在値を取得するhost契約を持つ場合に使う
`procurementCurrentApplication`を追加した。coreの再送・Application APIは変更していない。

```ts
const application = procurementCurrentApplication(repository, authenticatedActor, policy, initialEntities);
const session = await application.start();
await session.dispatch({
  type: 'request.create',
  input: { requestId: 'call-001', input: { id: 'rq-001', lines: [{ sku: 'a', quantity: 1, unitCents: 500 }] } },
});
```

## 過去結果と表示の現在値を分ける

25操作の再送commandは、これまでどおりcommitted/replayedを返す。
保存した過去結果を書き換えず、replayedを新しい業務commitと偽装しない。
Applicationの実行境界が結果を受け取り、committedならそのwritesを、replayedなら影響対象の現在値を投影する。

replayedのwritesからkind/idを抽出し、CurrentRepository.currentへ一度渡す。
現在値の読込みも同じApplicationの実行中に行い、完了後に一度だけ表示状態を更新する。
古い作成結果がdraft/version 1でも、現在がsubmitted/version 2なら後者を表示する。
応答消失を成功記録で解決した場合にも、保存済みの現在値を空のViewへ反映できる。
初期値・queue・revision・通知・失敗管理は既存Applicationへ委譲し、25操作ごとにrefresh処理を書かない。

## 現在値を取得するhost契約

`CurrentRepository`は既存ReplayRepositoryへ、対象キーを一貫した読込みで返すcurrentを追加する。
SqliteProcurementはBEGINからCOMMITまでの一つのread transactionで各主キーを読み、状態別に復元する。
同じキーは重複取得せず、一つでも存在しなければ部分的な配列を返さずProjectionUnavailableとする。
groupが異なるactorや無効actorにも値を返さない。これはtrusted hostの取得portであり、認証基盤の追加ではない。

Application側も、必要な全キーが一度ずつ返ること、group、safe integerのversion、
過去の保存version以上であることを確認する。不足・重複・想定外キー・別group・古すぎる値では投影しない。
既知のViewより古いversionで上書きしない純粋なapplyCommittedも継続して使用する。
任意のport実装が同じ瞬間のDB値を返したことを型だけで証明するわけではない。

## 取得失敗は業務の再実行と区別する

対象欠落や既知のbusy競合等の取得不能はProjectionUnavailableとしてfailedとなり、それまでの表示を維持する。
これは業務保存が失敗したという意味ではない。保存成功の実行記録は維持する。
取得先を復旧してdismissし、同じrequestId/inputを明示的に再実行すると、
業務を再保存せず成功記録と現在値を取得する。

保存値の破損や取得処理の想定外例外はcrashedとなる。
SQLiteは破損の復元拒否時にもread transactionをrollbackし、以後の読取りを妨げない。
自動retryやschedulerは追加していない。

## 検証範囲

`src/procurement-current-projection.test.ts`の7シナリオを実配布consumerでも実行する。

- CommitUnknownからの復旧で、1回の保存・1回の現在値取得後に空のViewへ行が現れる。
- 古い作成要求の再送は現在のsubmittedを表示し、再送command自体は過去のversion 1を保つ。
- 返品を再送した後に、さらに再入荷・再照合された発注・検収・請求・在庫の現在値を反映する。
- ProjectionUnavailableでは既存表示を保ち、取得復旧後も新しい業務commitを増やさず反映する。
- group・active・missing・重複キーを取得境界で扱う。
- 不足・重複・別group・想定外・古いpatch、取得例外を安全に停止する。
- 実DBの破損データを拒否し、修復後に再度read transactionを使えることを確認する。

## 残る範囲

現在値を返すのは、過去の操作が更新したキーだけである。
その後に追加された新しい検収などを自動発見せず、全モデルの初期取得・関連行の再検索・別sessionとの常時同期を提供しない。
したがって全体Viewを完全同期する機能ではなく、現在の影響対象patchを取り込む機能である。
初期Queryの設計・権限・ページング・外部更新通知はhostに残る。

読取りtransactionの機構と上記シナリオを検証したもので、別OSの並行writerや他DB・高負荷を網羅した試験ではない。
[独立plain/helper Applicationとの比較](procurement-current-comparison.md)も追加し、代表的な取得・失敗・queueの契約一致を検証した。
全障害経路や値の観測までの同等性を証明したものではない。
