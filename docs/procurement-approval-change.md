# 仕様変更比較：金額による二段階承認

講演の「業務の状態・検証・遷移に集中し、定型的な接続を委譲する」を、
25操作の購買アプリに対する一つの仕様変更で検証する。
講演者の非公開製品仕様の再現ではなく、Koyuki・通常TypeScript・共通helperに
同じdomain、認証情報、保存adapter、入力、期待結果を適用する評価である。

## 変更した業務仕様

```ts
const policy = {
  requestLimitCents: 2000,
  approverIds: ['first', 'final', 'other'],
  secondApproval: { aboveCents: 1000, approverId: 'final' },
};
```

- 金額1000以下は従来の一段階承認。1000を超え、申請上限以下なら二段階承認。
- first-review → final-review → approvedへ進む。中間状態では発注できない。
- 所有者と現在の承認担当は別人。二段階の承認者も別人でなければならない。
- 申請時に最終承認担当を状態へ保存する。後の設定変更で進行中の経路を暗黙に変更しない。
- 各段階で取り下げ・差し戻し・却下・担当変更ができる。担当変更で承認者の分離を破れない。
- 取り下げ・差し戻しはdraftを再構築し、再申請では最初の承認からやり直す。
- 承認済みでは、一段階と二段階の証拠を直和で区別する。二段階では両承認者を保持する。
- secondApprovalを省略した既存設定・既存の保存形式は引き続き受け入れる。

入力は従来どおりexpectedVersion付き。新たなapprove操作や実行APIは増やしていない。
承認担当はhostの設定、実行者のrole/group/activeは信頼できる認証情報から渡す。
これは組織階層、委任期限、動的な承認人数を一般化した承認製品ではない。

## 実際に変更した範囲

変更前の基準commitは`212a76f`。以下の本体差分を比較する。

| 分類 | 変更した箇所 | 理由 |
| --- | --- | --- |
| 業務モデル | domain.tsの状態Union、Policy、承認・再割当・復帰操作 | 新たな業務状態・分離条件を表す |
| 外部値の復元 | 同じdomain.tsのrestoreEntity | 新しい保存形の必須属性・担当者の関係を検査する |
| hostの設定所有 | context.ts | 新しいnested設定も構築時にコピー・freezeする |
| Koyukiの操作接続 | application.tsは変更なし | 既存のload/run/saveが新しい純粋関数の結果を実行する |
| 通常TSの操作接続 | plain.tsは変更なし | 共通domain関数と既存の明示的な接続を再利用する |
| helperの操作接続 | helper.tsは変更なし | 共通domain関数と既存helperを再利用する |
| 実行基盤・保存 | core、SQLite driver、再送driver、Applicationは変更なし | 新しい状態も同じCAS・原子保存・receiptの契約で扱う |
| 既存の型検査 | comparison / trace-comparisonの成功型を更新 | approveが完了だけでなくFinalReviewも返すという仕様変更を反映する |
| 新規検証 | procurement-approval-change.test.ts、consumerへのコピー | 新しい仕様と保存・再送の継続性を実配布物でも検査する |

本体ソースの変更は共有のdomain.tsとcontext.tsの2ファイル。
全方式がこの共有部分を使うので、この変更についてKoyukiだけ修正箇所が少ないとは言えない。
この比較は独立した3チームの実装や作業時間の測定ではない。

## 確認したこと

新規19テストに、金額999/1000/1001と上限超過、設定の所有、
各段階の不正な担当・古いversion・早すぎる発注、両段階の復帰操作、
不正設定で保存しないこと、保存形の欠落・相反する属性の拒否を含める。
メモリとSQLiteの両方で3方式を検査する。
SQLiteは段階間でclose/openし、復元した値を次の業務関数へ渡す。
3方式の再送driverでは同一要求の並行承認が一つのcommitへ収束し、
最終承認後の再起動と古い要求の再送でも現在の状態がversion 4のapprovedに留まることを確認する。

通常TS/helperのapproveの公開成功型はApproved | FinalReviewへ変わる。
既存の「必ずApproved」という厳密一致検査が型エラーになり、更新が必要だった。
比較時点（db80172）ではKoyukiの共通saveはRequest全体を返していた。
その後、[generic saveの成功型](business-save-inference.md)を保持する改善を行い、
通常procurementのapproveもApproved | FinalReviewになった。
procurementChangesのCommitted envelopeもこの到達型を保持する。
core businessの再送履歴や任意のgeneric変換を、現在のRuleだけから狭めたという意味ではない。

restoreEntityは属性と局所的な整合性を検査し、過去に実際に承認イベントがあったことを証明しない。
旧一段階形式との互換性を維持するため、DB改ざんで二段階の印まで除去した行から
失われた履歴を復元する保証はない。監査履歴の追加・移行・改ざん対策は別の課題である。
旧バージョンのreaderが新しい状態を読める保証もないため、複数バージョンの同時運用は未評価。

```sh
npm run check
npx tsx --test src/procurement-approval-change.test.ts
npm test
npm run test:business:package
```

この一変更で「業務変更のたびに接続を書き直さない」という設計は確認できた。
全種類の仕様変更、大規模チームでの学習負担・速度・障害率の優位は未検証である。
後続で[複数場所からの返品・訂正](procurement-return-change.md)も比較した。[休暇での新しい認可失敗](authorization-change-study.md)はtransportとApplicationまで検証したが、通常TSとの同等runtime比較や、監査・保持期間等の方針変更は引き続き残る。
