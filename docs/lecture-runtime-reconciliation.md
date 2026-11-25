# 実行境界等を追加した後の講演との再照合

実装基準は3a488fc7ec19499832165bed6a4301fd51967949。
保存済み字幕と本人公開PDFへ戻り、最近の実装が元の話をどこまで満たすかを確認した。
今回の再読は下表の4字幕区間・6PDFページに限る。
元の全84区間・198ページのレビュー記録を、新たな全編視聴・全頁再読へ読み替えない。

| 原資料 | 今回確認した主張 | 現在の対応と残る不足 |
| --- | --- | --- |
| 1本目50:43–52:19 / PDF84 | 状態と表現へ集中し、イベント・計算の接続をframeworkへ委ねたい | businessとApplicationが接続・失敗停止・完了・投影を調停。[宣言参照](declaration-ownership.md)も保持する。React/Elmと同等の書き心地・学習負担は独立利用者で未測定 |
| 1本目56:54–59:07の質疑 | 外側でtransactionを始めたcontextを関数へ渡す案 | [同期・callback境界](transactions.md)とPrisma実例で具体化。ただし登壇者が当時実施済みだったとは扱わない。任意DB・別サービス・外部IOへの原子性は保証しない |
| 2本目32:36–32:58 / PDF30 | 型を緩めず、workflowの型記述を簡素化できないか | 通常関数列、generic save、[動的入力の安全性](application-input-contract.md)を検査。generic requireと未注釈evolveの同時推論は未解消。診断品質と独立利用者のDXも未証明 |
| 3本目21:55–23:55 / PDF27 | 前後の状態が引数・戻り値に現れ、途中状態を追える | 選択capture、実行ID付きtrace、保存時の成功metadata監査を提供。それぞれ下記の異なる保証であり、全状態の自動dump・永続履歴の完成ではない |
| 1本目PDF87 | andThen等の接続やResultの入れ子の負担 | business/Processで既存の接続を委譲。言語レベルのdo記法、すべてのgeneric推論、任意業務の記述量優位とは区別 |
| 1本目PDF90 | readonlyを使っていないという留保などの補足 | Koyukiは独自の設計としてreadonlyや宣言の所有権を採用。登壇者がreadonlyの利用を必須要件としたとは記録しない |
| 3本目PDF48 | 型で値の取り得る範囲を考え、compilerの支援を得る | domainの直和・brand・接続検査と、動的command/validateの安全な入力範囲。業務仕様の正しさや普及・DXの実証は別 |

## 観察できることを混同しない

| 機能 | 取得・保存するもの | 取得・保証しないもの |
| --- | --- | --- |
| 純粋なdomain関数 | 引数から次の状態を値として返す | 任意のTypeScript関数の純粋性を言語的に証明しない |
| [段階trace・実行観察](application-execution.md) | 実行ID、段階名、成否、Application完了。段階はreport終了後の通知 | 全引数/全戻り値、段階ごとのlive timing、親子span、永続保管 |
| [Workflow capture](workflow-observation.md) | 明示したprojectionが選ぶRule前後の値 | captureがthrowしない保証。純粋なinspectのcapture例外は呼出し元へ伝播する |
| [Process capture](process-observation.md) / business capture | load/Rule/IO/save/receipt照会等から選んだ値と、業務Resultから分けたcapture診断失敗 | 全値を勝手に収集しない。公開項目や保持期間を決めない |
| [成功監査](audit.md) | SQLiteで状態と原子的に保存する操作者・操作・対象version等のmetadata | Ruleごとの値の全履歴、拒否ログ、改ざん耐性、全DBへの対応、保持削除の実運用 |
| [静的構成図](flow-structure.md) | 宣言した処理構成。名前が一意に対応するTraceの表示 | 関数内部のifの解析、業務状態図、node/span IDによる完全な経路証明 |

明示的な引数・戻り値は観察の足掛かりになるが、上の各機能を一つ加えれば全部を達成するわけではない。
特に成功監査を追加しても、段階の全引数・全戻り値を永続保存したという説明には変更しない。

## 講演への対応とKoyuki独自の拡張

実行IDの形式、監査schema、Mermaid出力、宣言参照の所有権はKoyuki側の具体化・拡張。
講演がこれらの形式を指定した、または全業務で自動提供することを要求したとは扱わない。
講演の経験談・教育効果・認知負荷の評価を、Koyukiの実測値に置き換えない。

この更新でsupported/partial等を格上げしていない。
[字幕の詳細記録](lecture-audits/README.md)とPDFページ別記録へ実装根拠を追加し、
初回レビューのbase commit・audio/all-code等の未確認flagは維持した。

## 原文と記録の検査

```sh
npm run check:lecture-audit -- /path/to/functional-business-talks
npm run check:lecture-decks -- /path/to/functional-business-talks
npm run test:lecture-records
```

hash・区間/ページ・参照先の検査であり、要約の妥当性、字幕の誤認識、全編の連続音声映像、実装の完全性の自動証明ではない。
今回も原文やPDFそのものをGitへ転載していない。
