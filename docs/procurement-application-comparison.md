# 独立したApplication driverで3方式を比較する

通常TypeScript/helper版へ`baseline-application.ts`を追加した。
KoyukiのdefineApplication・Program・replayOperationsを実行せず、sessionを独立実装する。
前段の独立再送driver、共有domain・SQLite境界、純粋なapplyCommittedは再利用する。
Koyuki製品のコードや型を一切使わない別製品の比較ではなく、Application実行管理の比較である。

## 基準実装が追加した責務

- ready/running/failed/crashedと、その状態に対応するView。
- 初期値・dispatch入力・snapshot・通知のclone境界。
- session内の直列実行と、実行直前のexpectedRevision検査。
- 受理・command・完了の実行履歴とrevision更新。
- 成功したcommittedだけを投影し、replayedで過去値を適用しないこと。
- 想定外例外をcrashedへ分離し、明示的なdismiss後に処理を再開すること。
- 初回通知が失敗したlistenerを登録せず、登録後の通知失敗は受理した業務を中断しないこと。

元のplain/helperの25操作をモデル名付きで登録し、操作を一つずつ書き直さない。
公開の型は比較対象の従来Application契約に合わせ、実行を流用しない。
後から追加した[実行観察](application-execution.md)のsubscribeExecutionは基準実装に含めず、戻り値型から明示的に除外する。
その追加機能まで同等の実装・負担を比較したとは扱わない。
比較上の実装量へは、session状態機械・queue・clone・通知・履歴の基盤も含める必要がある。

## 代表ケースの比較

`src/procurement-application-comparison.test.ts`をKoyuki/plain/helperへ適用する。
単に最終画面が同じかだけでなく、dispatchの結果・snapshot・revision・通知・session traceを比較する。

1. 作成・申請・過去作成の再送を行い、version 2の表示を維持する。
2. dispatch直後の入力変更を受けず、取得失敗でfailedとなり、dismissなしの次操作を拒否する。
3. dismiss後にreadyへ戻り、古いrevision・内部完了イベント・clone不能入力が状態を変えないことを確認する。
4. 最初の保存をgateで止めて次操作をqueueへ入れ、待機中の入力変更を受けないことと、さらに後ろのstale要求がIO前に拒否されることを確認する。
5. 初回購読失敗と、running通知での購読失敗を区別し、保存処理が継続することを確認する。
6. 保存前のadapter例外でcrashedとなり、修復・dismiss・明示的な再実行が同じ結果になることを確認する。
7. 保存成功をCommitUnknownとして返し、成功記録で解決したときのView維持を比較する。

各シナリオはSQLiteで実行し、実tarballの独立consumerでも検査する。
時間やメモリ使用量はbenchmarkとして測定していない。

## 比較で確認した表示上の制約

保存成功後の応答消失がreplayedとして復旧すると、既存の投影方針は過去値を適用しない。
初期表示が空なら、DBには新しい行があってもViewは空のままreadyになる。
これは3方式とも同じ挙動であり、最新状態の自動再取得を提供したことにはならない。
初期値の取得や再送後のrefreshはhostに残る。過去値をそのまま適用すると古い表示へ戻り得るため、
改善時には現在値の取得境界と一貫性を設計する必要がある。

## まだ同等と判定していないこと

現在の25操作で代表的なsession契約をそろえたもので、汎用Programの全機能・任意のアプリの全状態を実装した比較ではない。
複数モデルの投影そのものは共通関数を使い、初期値・他sessionとの同期・ブラウザ描画は比較対象外。
値のcapture・観測失敗・機密項目の選択・永続監査、全25操作の全障害経路は比較を続ける。
同じ業務変更を適用した差分、追加基盤を含む実装量、独立利用者の認知負担・生産性は未測定。
同じ結果を返せることと、保守や開発が容易であることは別に評価する。


この比較で確認した表示上の制約を根拠に、[現在値を取得するApplication](procurement-current-projection.md)を追加した。
既存3方式は比較時の契約を維持し、[新しい取得方針の3方式比較](procurement-current-comparison.md)も別途追加した。
