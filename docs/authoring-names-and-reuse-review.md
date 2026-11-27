# 操作名・Hook再利用と追加業務のAI試用

基準コミットd614ebaに対する追加検証。人間の初見評価ではなく、既存実装を知る保守者AIによる試用である。公開ガイドと配布物のAPIで追加できるかを確かめたが、内部知識の影響を除いた実験とはしない。

## 変更した契約

同一アプリの操作名はProviderをまたいで一意。異なる宣言でも同名を登録すると、重複側のHookを呼ぶ前にDuplicateOperationとなる。別アプリでは同名を許容する。executeは宣言オブジェクトで照合し、名前だけで他の宣言へ解決しない。

.use()は同期Hookであり、毎回新しいハンドラーを返す。登録・キャッシュ・状態保持をしない。返されたハンドラーをProcess.effectへ渡した検証では、内部ルールのtraceとlive spanが残り、失敗時には保存と後続の通知を停止した。部品の評価中はload/saveを実行しない。複数操作の合成はtransactionの自動統合を意味しない。

## 別プロジェクトで追加した予約キャンセル

保存先 `/Users/yukiharada/dev/koyuki-onboarding-names-d614eba` にprepare:authoringで開発版tarballを作り、npm install後にcancellation.tsxを追加した。Koyukiのimportはkoyukiとkoyuki/experimentalのみ。React・Node型を追加していない。再現用ソースは `scripts/fixtures/authoring-cancellation-trial.tsx`。

- 状態はbooked/cancelledのUnion。純粋Workflowで所有者確認とキャンセルへの遷移を合成。
- Contextから操作者とRepositoryを取得し、一つのdefineOperationでload/execute/saveを接続。
- npm run checkとnpx tsx cancellation.tsxが成功。成功、権限不足、取得失敗、trace、並行する別操作者を検査。失敗時はsaveを呼ばない。
- @ts-expect-errorで数値idの入力を拒否することも検査。操作定義に型引数や戻り型の注釈を追加していない。状態型とRepository境界、検証関数の失敗Unionには通常の型注釈を残した。

手書きで残ったのはloadのResultを分岐し、成功時にbookingとactorをまとめる処理。Providerの操作者を未検証の入力から受け取らないための明示的な境界であり、推測による自動注入は加えていない。業務の合成・登録・実行には別のoperationKeyやhandler propは不要だった。

この小さなメモリRepositoryによる追加試用は、予約業務の永続再送や本番transactionを検証していない。三業務の既存SQLite検証とは区別する。初見React利用者がどこで迷うか、習得時間や生産性は未確認。

再現する場合は、新しい試用ディレクトリをprepare:authoringで用意し、fixtureをcancellation.tsxとしてコピーし、tsconfig.jsonのincludeへ追加してから上記二コマンドを実行する。

続く既存業務の仕様変更試用は[期限ルールの変更記録](authoring-specification-change.md)を参照。新規追加の成功と、仕様変更時の変更範囲を分けて評価している。
