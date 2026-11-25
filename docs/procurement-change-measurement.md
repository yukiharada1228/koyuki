# 仕様変更2件の差分を再集計する

二段階承認と複数場所からの返品・訂正について、変更前後のGit treeを直接比較する。
[対象の完全なcommit ID](../scripts/studies/procurement-change-cases.json)と
[ファイル別の集計結果](procurement-change-metrics.json)を保存した。
作業ツリーや現在のHEADを対象へ混ぜず、同じ履歴から再集計できる。

後続で[現在のKoyuki loaderをProcessへ移した](procurement-framework-context.md)が、下記は
その変更前の固定revisionの計測である。現在の2系統のcontextの保守コストや差分を測った値ではない。

## 結果

数字はGitの物理行の追加／削除で、空行・コメント・書式変更も含む。
各セルは「変更ファイル数、+追加 / -削除」。意味上の変更数や工数ではない。

| 分類 | 二段階承認 | 複数場所の返品・訂正 |
| --- | --- | --- |
| 共通の業務モデル・規則 | 1、+56 / -12 | 2、+23 / -5 |
| 共通のhost context | 1、+2 / -1 | 1、+2 / -2 |
| loader比較の試作 | 0 | 2、+7 / -6 |
| Koyukiの操作接続 | 0 | 0 |
| 通常TSの操作接続 | 0 | 0 |
| helperの操作接続 | 0 | 0 |
| framework・保存・再送・投影 | 0 | 0 |
| テスト | 3、+175 / -5 | 1、+175 / -0 |
| 検査ツールへの登録 | 1、+2 / -0 | 1、+2 / -0 |
| 資料・評価記録 | 5、+87 / -5 | 3、+75 / -2 |
| 全変更ファイル | 11、+322 / -23 | 10、+284 / -15 |

業務モデルとhostは3方式で共有しているので、方式ごとに同じ変更を3回分へ増やしていない。
また、返品のloader試作の変更をKoyukiの操作接続へ紛れ込ませたり、表から除外したりしていない。
その試作が通常の25操作の実行に必須だという意味でもない。

この2変更では3方式とも操作接続の変更はゼロだった。
これは共通domain・host・adapterを持つ今回の構成で、業務変更をそこへ局所化できたという結果である。
Koyukiだけが変更を減らした、導入コストが安い、開発が速い、という結果ではない。
新規実装の総コスト、共通helper・frameworkの開発/習得、独立参加者の工数は測っていない。
この集計ツール自体も後から追加したため、上の2変更の差分には含まれない。

## 再現する

```sh
npm run measure:procurement:changes
npm run check:procurement:changes
npm run test:procurement:changes
```

最初のコマンドはJSONを標準出力へ出す。保存済みファイルを自動更新しない。
checkは実Git treeから再集計し、保存済みJSONの全項目が一致することを検査する。
対象commitを含む履歴が必要で、shallow cloneやnpm配布物だけでは実行できない。
CIの記録検査jobではfetch-depth: 0を指定して実行する。

- Myers・indent heuristicなし・rename検出なしのnumstatを使い、外部diffやtextconvを実行しない。
- すべての変更を分類し、未分類ファイル・binary・非UTF-8・通常ファイルでない対象は失敗とする。
- 追加ファイルはbefore:null、削除ファイルはafter:null。両側のbytes・行数・SHA-256・modeを記録する。
- framework・3方式の操作接続・保存・再送・投影は、group内の全ファイル名・mode・内容hashの一致を検査する。
  変更ファイル一覧に出なかっただけでなく、groupが空でないことも確認する。
- groupのsource digestは検査の再現用であり、コードの安全性・意味上の等価性・品質点ではない。

[4テスト](../scripts/procurement-change-metrics.test.mjs)は一時Git repoを使い、
追加・削除・末尾改行なしの行数、作業ツリーからの独立、未分類・binary、
不変groupの内容・追加ファイル・実行modeの変更、空group、可変のrevision名を検査する。
計測と検査は開発用のNode/Gitを使う。配布runtimeの依存やWeb標準APIの契約には追加しない。

## 比較の範囲

業務結果・障害時の状態の根拠は、それぞれの[承認変更](procurement-approval-change.md)と
[返品変更](procurement-return-change.md)の実行・型検査にある。
差分の行数だけで、その適合性や講演全内容の実現を証明することはできない。
同じファイル数でも内容・難しさは異なるため、方式の順位や生産性向上率には変換しない。
[休暇の認可エラー追加](authorization-change-study.md)は別途検証したが、通常TSとの同等transport/runtime比較ではない。
一般的な認可・監査方針変更、全機能の実装負担、独立利用者のDXは引き続き未評価である。
