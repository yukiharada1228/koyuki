# 休暇申請で確認した開発体験

公開済みalpha.2を固定して実装。フレームワーク本体の変更は0件。
従業員台帳を一つの集約として設計した結果、既存APIで業務の3操作を表せた。
経費と異なる「容量の仮確保・解放」は新しいruntime機能ではなく、ドメインのrequireと遷移だった。

## 書かなくて済んだ接続

- load後のResult確認、検証結果をrequireへ渡す処理、require結果をevolveへ渡す処理。
- 失敗時の後続停止とsaveの呼び出し、成功・失敗のtrace生成。
- 要求ごとのsave closure、取得前の再送照会、明示した競合後の再照会。
- ready / running / failedと内部完了イベント、過去の再送結果を現在のViewへ適用しない分岐。

## 残った接続

| 記述 | 今回の置き場所 | 評価 |
| --- | --- | --- |
| validate / require / evolveの業務名と順序 | application.ts | 利用者が宣言すべき内容 |
| 操作名と入力型を対応付けるtarget登録 | application.ts | 経費でも繰り返す定型記述 |
| 各操作をwithReplayで包みlookupを対応付ける | application.ts | 経費でも繰り返す。将来の共通化候補 |
| Applicationの操作名とreduceの対応 | application.ts | 再送の有無とView更新方針を明示するため残る |
| fingerprint、成功結果の復元、保存前後の一致検証 | repository.ts | 永続化契約・業務の判断が必要 |
| transaction / CAS / rollback | repository.ts | SQLiteアダプターの責任 |

型の異なる3操作を一括登録する独自helperを増やさず、withReplayの登録は明示した。
共通のresolveAfterは抽出できた。元の要求とドメインのChangeの関係は、保存境界で検証する必要がある。
フレームワークが任意のChangeからfingerprintや許可された状態変化を推測する設計にはしなかった。

## 型とAPIで迷った点

1. defineRequestTargetのsaveに渡すChangeの型と、targetの入力型を明示する必要がある。
   操作ごとに入力型が異なるため、submitだけSubmitInputとして登録した。
2. requireDaysの成功に独立したbrandを付けることで、検証だけ済ませた入力と区別できた。
   枠が存在しても、型で何を証明するかはドメイン側の設計になる。
3. withReplayで包むとrunDetailedが公開されない。再送も含む一つの実行トレースは今回取得できない。
   元コマンドを直接呼ぶと再送境界を迂回するので、通常操作の代替にはしない。
4. 永続化失敗と業務失敗が同じResultに合成されるのは便利だが、どの失敗を再照会するかは利用側で明示が必要。
5. 型エラーはStepやNoInferまで表示される。今回も専用の診断は追加せず、型テストで誤接続の拒否を確認した。

## 次に本体で検討するなら

経費と休暇で共通して残ったのは、要求付きTargetとwithReplayの登録、および再送を含む観察性。
次の候補は、既存APIを残したまま、この一まとまりの宣言とトレースを扱えるかを設計すること。
今回の実装が動くことだけを理由に、新しい自動登録APIは追加していない。

業務状態、容量制約、仮確保のタイミング、集約の境界まで自動化できたという結論ではない。
それらを決めた後の接続と実行を、公開版だけで再利用できることを確認した。

追記：開発版alpha.3で[再送を含む実行記録](../../docs/replay-trace.md)を追加した。
`npm run test:leave:development`で、公開alpha.2のこのサンプルに開発版パッケージを適用して検証できる。
このサンプル自体のnpm依存はalpha.2のまま。
