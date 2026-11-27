# 字幕を基準にした現在の対応

ユーザーの指示により、保存済み字幕を要件解釈の基準とし、公開スライドで補強する。別ASRとの食い違い・原音10区間の未確認は注記として残すが、実装受入れの停止条件にはしない。原音確認済みとは表記しない。

実装照合の基点は5a11cb4。字幕4034行・84話題と公開PDF198頁の保存データのhashを再検査した。hash・区間検査が意味の正しさを自動証明するわけではない。

## 2026-11-27の作業ツリーでの再確認

上の基点と84話題の分類は過去の評価記録である。以下は未コミットの変更を含む現在のコードへの追補であり、過去のコミットや公開済みnpmへ反映済みという意味ではない。

| 照合する考え方 | 現在の具体例・検証 | 保証の境界 |
| --- | --- | --- |
| 異なる業務IDを区別し、入力検証の失敗をResultにする | [IDの安全性](identifier-safety.md)、[入力検証](booking-validation-results.md)。BookingIdとActorIdを区別し、外部値を検証付き生成関数へ通す | ブランド型だけで外部入力や認証の正しさを保証しない |
| 状態の型を合成後まで保つ | [保存結果の型推論](authoring-save-inference.md)。入力を保持するgeneric saveと、実際に広い値を返すsaveを区別する | 任意の多相関数を無注釈で推論できるとはしない |
| 明示した関係の接続と実行を委譲する | `src/authoring-wiring-contracts.test.tsx`。Resource依存順・取得共有・失敗停止・宣言参照によるイベント接続・構成不正時のI/O停止 | 業務上の順序・必要情報・送り先の意味は利用者が宣言する。業務仕様の自動推測を講演の要件に追加しない |
| 型と純粋関数で実際の仕様変更を表す | [日程変更](rescheduling-business-study.md)、`src/authoring-rescheduling.test.tsx`。ConfirmedからConfirmedへの変更、所有者・期限の検証、元値不変、保存時の競合拒否 | 状態タグだけの比較では同じ状態内の競合を防げない。保存アダプターの比較も必要 |
| 計算とI/Oを分離したまま実行を強化する | [日程変更の再送](rescheduling-replay.md)。状態・outbox・成功記録の同時保存、応答喪失後のDB再接続と再送、内部ルールのtrace | 再送の保存方式はKoyukiの追加設計。講演がこの方式を指定したという主張ではない。外部通知のexactly-onceは保証しない |

講演で紹介された実装方法、講演中のフレームワーク化の将来構想、Koyuki独自のJSX・Hooks・Provider・再送設計を分けて評価する。現在の判断は「中核となる実装方法と接続の構想には具体例がある」であり、「原音の逐語的な完全確認」「あらゆる業務への適合」「人間の習得容易性」の達成宣言ではない。

今回、保存字幕ディレクトリを指定した`check:lecture-audit`は3動画・4034行・84話題の構造検査に成功した。さらに以下の31実行テストが成功した。これは型検査の代用ではない。

```sh
npm run check:lecture-audit -- /Users/yukiharada/Downloads/functional-business-talks
npx tsx --test src/authoring-rescheduling.test.tsx src/authoring-leave-domain.test.ts src/workflow-observation.test.ts src/authoring-wiring-contracts.test.tsx
```

続いて既存の`check-lecture-conformance.mjs`も現在の作業ツリーで完走した。型検査、講演記録9テスト、全1315テスト、配布物での三業務のSQLite検証、予約キャンセルの仕様変更検証が成功した。仕様変更検証では24hから48hへの変更に同じHook・Provider・登録・実行器を使い、境界条件を誤らせた負例も検出した。生成レポートは`/tmp/koyuki-caption-current-review.json`。この結果によって原音確認や本番品質のフラグは変更していない。リモートCI・npm公開は実施していない。

## 再評価の結果

字幕を基準に、コードとして具体化する能力には対応例と検証が揃っていると評価する。分類はsupported 44、design-choice 26、experience 8、context 6。挨拶・経験談・設計上の選択を、機能として実装済みだと数えない。84話題の内訳であり「84機能」や正しさの割合ではない。

以前のpartial 9話題は、今回字幕へ戻って要件の範囲を再評価した。8話題をsupported、説明省略を案内する1話題をdesign-choiceとする。過去のJSONは履歴として保持し、`lecture-caption-baseline.json`に元のstatus・時刻・字幕hash・再評価理由・残る制限を記録する。テストが通ったことだけを理由に分類を上げていない。

| 話題 | 字幕を基準に評価する能力 | 現在の対応 |
|---|---|---|
| iz-22 | イベントから次の計算への接続をframeworkへ委譲 | defineOperation・Operation・execute、既存Applicationのviewと購読 |
| iz-24 | Resultの手書きの入れ子を減らす | Workflowと関数列の合成・成功値の受け渡し・失敗停止 |
| iz-31 | 登録→配送ハンドラー→人の確認→次のWorkflow | 登録・outbox・receipt・配送ハンドラー・確認操作。SQLiteで検証 |
| iz-36 | I/Oと分離した核を単独テスト | 業務関数をHooksやRepositoryなしで実行。Result取り出しは残るトレードオフ |
| qbf-12 | 独立したフィールドのResultを集約 | collectでフィールド別の値・失敗をまとめる |
| qbf-19 | 型記述の重複を減らす | 入力・成功・失敗・詳細レポートの推論。配布宣言でも検証 |
| w0o-13 | 状態を引数と戻り値に明示し、途中状態を調べる | 純粋な遷移・内部ルールのcapture・trace |
| w0o-17 | 省略した説明の公開資料への案内 | 資料と画面の照合記録を参照する設計上の項目 |
| w0o-23 | 直和と直積で不要な状態を減らす | 状態別Union・検証証明・外部入力復元の検証 |

これらの能力は既存実装で確認できたため、この再評価に合わせた新しい実行時APIは追加していない。React風のHooks・Provider・JSXはKoyuki独自の組み立て方であり、講演そのものが指定した構文ではない。

## 残る制限

任意の利用者関数の純粋性・任意の多相関数の推論・全注釈の省略は保証しない。特定のメール事業者や常駐schedulerの本番運用、全値の既定永続収集、履歴の保持期限、分散相関は未提供またはホスト側の設計。人間のReact経験者による習得負担は未評価。AIの追加・仕様変更試用はそれとは別の証拠である。

これらを機能要件に追加しない判断と、これらを達成したという主張は異なる。字幕基準の設計対応が揃うことは、原音の正確さ・本番品質・全業務仕様の正しさ・講演者の監修を証明しない。

## 再現

```sh
node scripts/check-lecture-conformance.mjs --report /tmp/koyuki-caption-baseline.json
```

保存済み84話題へ新しい評価方針を重ね、参照パス、時刻、元status、字幕hashとの対応を検査する。未知の話題や重複した再評価は拒否する。型検査、講演記録検査、全runtimeテスト、TypeScript 6/7配布物、既存業務の仕様変更を順に実行する。

`captionBaselineRequirementsAssessedAsImplemented`は、この要件解釈と証拠に基づく評価であり、検査プログラムが字幕の意味を自動証明したというフィールドではない。`originalAudioVerified`と`productionReadinessProven`はfalseのままとする。
