# 講演の中心へ戻った追加照合

実装基準349942ce567464760885c63f8060e3f215c289da。
有限モデル検査や限定retryの追加を、そのまま講演の中心的な開発体験の完成とは扱わず、
状態・検証・遷移とイベント接続に関する3区間を再確認した。

## 確認経路と限界

接続済み動画ライブラリの題名・時刻が対応する3本について、字幕の区間検索と窓読みを行った。
返った字幕は1本目40件、2本目21件、3本目40件で、101件すべての本文が保存済み字幕にも存在した。
同じ字幕に由来する可能性があり、独立した音声認識・字幕の正確性の証明とはしない。
題名・時刻・本文の一致は確認したが、登録メディアと元YouTube動画のバイナリ同一性は未検証。

| 元動画 | 要求した本体区間 | 窓読みの結果 | ローカル字幕で補った区間 |
| --- | --- | --- | --- |
| izV1h6o3hgQ | 50:43–52:19、前後10秒 | 40件、返却結果にtruncated: true。最後のcueの終端は51:58.200 | 51:49–52:19 |
| qBf910_YiqA | 32:36–32:58、前後10秒 | 21件、truncated: false | 32:36–32:58を再読 |
| w0oLNoGsGLc | 21:55–23:55、前後10秒 | 40件、truncated: true。最後のcueの終端は23:28.240 | 23:15–23:55 |

窓読みは重なるcueを返すため、実際の最初・最後のcueが要求範囲を越える。
truncatedを見落として窓全体を取得済みとは扱わない。
返却JSONはローカルの元資料保存先にのみ保存し、字幕本文はGitへ転載しない。
この追加確認に新たな全編音声視聴・全フレーム・PDF全頁再レビューは含まれない。

保存した返却JSONのSHA-256（取得時の結果であり、サービスの将来の返却値を固定するものではない）:

| ローカルファイル | SHA-256 |
| --- | --- |
| videoq-569-targeted-window.json | 35e8a6556a6de8fc6078e1b25dc92e1b4ef4d3df10c46fc435f1e47eb27e9f30 |
| videoq-572-targeted-window.json | 6350523cd5342451eafe98d1033515092b1b9727908ad0459adb14d30a28bedb |
| videoq-573-targeted-window.json | 12f9b8903ba540376742595e0c3e67cbb042f899e7c39fd9336ac1a542d83f32 |

## 中心的な要求と現在の判断

| 論点 | 現在の実装 | 引き続き未達のこと |
| --- | --- | --- |
| 1本目：モデルの遷移と表現に集中し、イベントと計算の接続をruntimeへ委ねたい | businessの通常関数列、load/save境界、Applicationのdispatch・完了・状態・view。Resultの失敗停止を委譲する | 独立利用者による書き心地・学習負担の実測。複数Repositoryの取得で入力contextを組む記述は残る |
| 2本目：型で支援されるが、workflowの型記述はさらに簡素にしたい | 通常関数列、generic saveの推論、動的commandの安全な入力契約 | generic requireと未注釈evolveの同時推論。今回の[文脈外の接続検査候補](transition-inference-rest-checks.json)3案も改善せず、不採用 |
| 3本目：引数と戻り値に前後状態が現れるため、途中状態を追える | 明示した選択値capture、対応coreのlive span、実行ID、SQLiteの成功metadata監査 | 全引数・戻り値の自動永続履歴、保持・削除の運用、opaque関数内部の自動分解。live span自体に値は含めない |

講演の経験談をKoyukiの測定値へ読み替えず、言語レベルのResult構文をTypeScript frameworkの
必須機能へ読み替えない。有限モデル検査やretryはKoyuki側の具体化・追加案であり、
それらの機能数を中心的な開発体験の達成度として数えない。

## 次の優先順位

1. generic推論の制限は再現例と厳密な型検査を維持し、既存の安全な接続を壊す候補を採用しない。
2. [複数取得の試作](procurement-load-composition.md)の接続負担を実例で減らす。新しいrecord結合APIを採るなら、キー衝突、動的キーの型、opaque値と参照の保持も検証する。
3. [独立利用者の評価課題](../examples/onboarding/README.md)で書き心地を検証する。maintainer自身の実行やテスト成功を参加者の評価へ置き換えない。

全講演の完全実現という要求は未達のまま。[現在の判定](lecture-acceptance.md)を部分充足に維持する。

## 後続の取得接続の改善

優先順位2に対し、[effectの成功値投影](effect-projection.md)を追加した。
新しいrecord結合DSLは設けず、既存effectの第3引数へ普通の関数で次の入力を返す。
購買loaderのローカルattachと内部の型アサーションを除き、失敗のResult接続をruntimeへ移した。
同名フィールドの置換も戻り値の型として表し、不可能なrecord交差型にはしない。
これは実装の追加照合であり、この文書の字幕再確認や独立利用者のDX実証の範囲を増やすものではない。

## 後続の通常オブジェクトとの接続改善

[再送callbackの推論](replay-context-inference-study.md)では、文字列・数値の操作名と
要求・成功・失敗型を維持したまま、検査したinline例の型注釈を省けるようにした。
[Applicationの登録](application-operation-table.md)では、宣言した非列挙操作を落とさず、
数値名を実際の文字列イベントへ対応させた。
続いて直接登録した操作のrunとreduceでreceiverが失われるケースを再現し、
classのprivate fieldを持つ操作でも通常・観察付きの呼び出しを維持するよう修正した。
これらは普通のTypeScriptで記述できる範囲の修正であり、generic requireの推論制限、
独立利用者の評価、全編音声との照合が解消したという意味ではない。

## 後続の未使用load宣言の削減

[100/500操作の検査](business-scale.md)で、全操作に個別loadがあっても未使用の共通loadを
要求する点を確認した。[個別loadだけで宣言する](business-local-load.md)形式を既存businessへ追加し、
配列形式の操作が一つでもあれば共通loadを必須とする。新しいbuilderや業務DSLは増やしていない。
通常・詳細・capture・再送と、100/500操作の配布consumerで型と実行を検証した。
不要な設定を除く改善であり、独立利用者の書き心地や全講演の完全実現を示すものではない。

## 推論制限を別compilerで比較

[compiler比較記録](transition-inference-compiler-comparison.json)では、同じcleanなソースから
7.0.2・7.1 beta・7.1開発版を使い、現行宣言と新しいtuple制約3候補を検査した。
すべての版でinlineのgeneric要件と未注釈evolveは通らず、raw制約の2候補は既存の宣言も壊す。
調べた版への更新だけでは解消しないため、候補は不採用。通常の名前付き要件と
genericの入力・出力型を維持する公開宣言は変更していない。
これは型検査に限る比較であり、beta/開発版で全runtime・配布consumerを検証したとは扱わない。

## 後続の共通generic loadの接続改善

[入力を含む文脈のload](business-generic-load.md)について、最初のRuleから要求型の候補を取り、
実際のloadが要求条件と必要な文脈全体を保証する場合に限り、操作ごとの入力型を保持する。
保守者用の経費参考実装は、操作別の型引数とloadの指定を、共通load一つへ減らした。
通常・詳細・capture・再送・opaque文脈と、配布物の型拒否検査を確認する。
これは独立利用者の評価ではなく、generic requireと未注釈evolveの制限も解消していない。
