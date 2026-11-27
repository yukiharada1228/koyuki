# コミット整理と保留実装の確認

2026-11-28。基点は`628112ad321a937d1bce949880c8ea239ff8cf77`。未コミットの実装・試験・説明を、依存順のローカルコミットへまとめた。push・リモートCI・npm公開は今回の対象ではない。

## コミットの分割

| コミット | 内容 | 検証単位 |
| --- | --- | --- |
| `b760d00` | 実行スコープ・Guard・保存結果の型精度・denied分類 | 独立したコミットのチェックアウトで型検査とscope試験 |
| `d9eafab` | 予約ID・接続・日程変更・永続再送・キャンセル手数料と返金 | 同じく型検査とwiring・SQLite・rescheduling・fee-cancellation試験 |
| `5a35ed3` | 予算付き経費精算・共通保存契約・通常TSとの比較 | 同じく型検査とexpense-budget試験 |
| `7321b2c` | 推奨Quick Start・Actorのscope供給・Guard手順・ガイドの導線 | 下記の最終実装コミット検証 |

この文書、変更前の分類記録、既存の講演対応・価値評価記録は最後の記録コミットへまとめる。記録自身のコミットIDを文書へ埋め込む自己参照は行わない。

## 保留していた三ファイル

`src/experiments/declarative-booking/cancellation-domain.ts`、`cancellation.tsx`、`cancellation-sqlite.ts`は未追跡で、従来は専用の実行試験がなかった。削除せず確認し、6試験と公開パッケージからの実行を追加して`d9eafab`へ含めた。

確認中に、SQLiteアダプターの復元処理がJSXの宣言モジュールへ実行時依存していたため、記録の型・復元関数を純粋なドメインへ移した。入口のexportは維持した。検査内容と返金・保存・再配送の保証範囲は[キャンセル実装の確認](fee-cancellation-review.md)に記録した。

## 再現方法

各コミットは、一時ディレクトリへローカルcloneしてdetached checkoutし、未コミットのファイルが入らない状態で検証した。開発用node_modulesは既存のものをリンクした。公開配布物の検査では、それぞれ別のconsumerへtgzを新しくインストールする。まったく新しいOSや依存の再取得まで検証したという意味ではない。

Node.js 26の環境で最終実装コミットをcheckoutし、依存を準備して次を実行できる。

```sh
npm ci
npm run check
npm test
npm run test:authoring:quickstart
npm run test:connections:package
npm run test:expense-budget:package
npm run check:package
npm run test:portable
```

## 最終実装コミットでの結果

`7321b2cc8eb3b746dd8bba8c4e0fd5df52f23df6`で上記7コマンドがすべて成功した。

- 型検査と全1338テスト。
- Quick StartのTS6/7型検査・宣言生成・実行・Guard・trace・再送・ルール変更。
- 接続の配布物51テスト、予算付き経費の配布物11テスト。TS6/7と生成宣言consumerも成功。
- 実行時依存ゼロ、31ローカルJSモジュール、Node型なしの公開宣言、Nodeグローバルなしのブラウザ実行。

機械的な実行結果は[検証記録](commit-verification.json)。最終の記録コミットはdocs配下のみで、検証対象コミットから実装・試験・スクリプト・package.jsonを変更していない。

## 対象外として保持したもの

APPLICATION-DEMO.txt、APPROVAL-DEMO.txt、COMPARISON-METRICS.json、EXPENSES-DEMO.txt、EXPENSES-SQLITE-DEMO.txt、MODEL-DEMO.txt、PROGRAM-DEMO.txt、SHIPPING-DEMO.txt、TAG-DEMO.txt、TAG-METRICS.jsonの10ファイルは以前からの未追跡出力として保持した。コミットへ含めず、作業前後のSHA-256の一致を確認した。

変更前の全72パスの分類は[履歴としての変更一覧](change-review.md)を参照する。そこに記録した「未検証」は当時の分類であり、キャンセル関連の現在の状態は上記の追加検証で更新している。
