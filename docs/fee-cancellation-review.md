# 保留していたキャンセル実装の確認

2026-11-28。未追跡だった`cancellation-domain.ts`、`cancellation.tsx`、`cancellation-sqlite.ts`を確認し、実行試験と配布物検証を追加した。

## 実装と境界

- 純粋なWorkflow: confirmedかつ本人の予約を、開始前にキャンセルする。24時間未満のstandard会員には手数料、premiumには免除。金額は最小通貨単位の整数とBigIntで計算し、端数を切り上げる。24時間ちょうどは手数料なし、開始時刻ちょうどは拒否。
- Resource: 支払・会員情報をホストから取得する。予約・操作者の検査に失敗した場合はこれらの取得を始めない。
- 保存: 予約・支払revision・会員revisionを比較し、状態・outbox・成功記録を一つのSQLite transactionで保存する。
- 返金: 保存後イベントの受信側として実行する。失敗しても保存結果は維持し、同じidempotencyKeyで再配送する。

確認中に、SQLiteの復元処理がJSXの操作宣言モジュールへ実行時依存していることが分かった。`CancellationRecord`と復元関数を純粋なドメイン側へ移動し、既存のexportも保持した。保存アダプターがJSX構成を評価する依存を除いた。

## 検証

`src/authoring-fee-cancellation.test.tsx`の6試験:

1. 期限の境界、premium免除、端数、最大safe integer、不正な金額・料率、元値不変。
2. 構成と不正な要求でI/Oなし。別の操作者は支払情報の取得・保存を行わない。
3. 支払または会員のrevision更新でConcurrentChange。状態・outbox・成功記録は変わらない。
4. outboxまたは成功記録のINSERT失敗で全体rollbackし、返金しない。
5. 返金失敗でもcommitted。DBを再接続してreplayed、別操作者のkey再利用は拒否。不正receiptから業務をやり直さない。
6. 同じ要求の並行実行で一度だけcommit・イベント作成・返金呼び出し。

`test:connections:package`にも同じ試験を追加した。業務モジュールはkoyuki / koyuki/experimentalの公開importだけを使用し、ホスト用SQLiteバンドルにフレームワーク本体が混ざらないことも検査する。TypeScript 6/7で業務の型検査と宣言生成も行う。

## 残る制約

実際の決済サービスへは送信していない。返金のexactly-onceは保証せず、決済側が同じkey・同じ内容を重複処理しない契約が必要。金額・会員情報はサーバー側の事実であり、本文から採用しない。会員・支払のrevisionの維持、receiptの保持期間、outboxのackはホスト側の責務。

論理値とrevisionの比較は、保存アダプターが守って初めて有効になる。この確認を本番決済や負荷の検証済みという意味にはしない。
