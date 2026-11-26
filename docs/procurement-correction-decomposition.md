# 数量再検証の接続と型注釈・観測の両立を調べる

返品・訂正の共通検証を分離しても、correctCheckedReceipt内部にはreceiveOrderのResultを
取り出す処理が残る。[試作と検査](../src/procurement-correction-decomposition.test.ts)で、
既存APIだけでこの接続を外へ出した場合の型と実行を比較した。
現行のdomain/application/receipt-pipelineは変更していない。
後続の[Workflow直接接続](business-workflow-stages.md)で4つ目の候補を追加した。
以下の最初の3方式の制限は再現例として維持し、新しい候補と区別する。

## 比較した3方式

| 方式 | 宣言 | 接続用callbackの型注釈 | businessの観測 |
| --- | --- | --- | --- |
| 現行 | checkReceipt → correctDecision → includeChangedStock | correctDecision内のwithInputに文脈を注釈 | 3段階。数量再検証と訂正計画の内部接続はopaque |
| 平らな試作 | checkReceipt → quantities → finishFlat → includeChangedStock | quantitiesとfinishFlatの2か所に文脈を注釈 | 4段階。数量再検証と計画作成を別の段階として観察できる |
| Workflowをまとめた試作 | checkReceipt → nested.run → includeChangedStock | quantitiesの1か所。thenの引数は推論できる | 外側は3段階。内部Workflowの2つの名前は出ない |
| Workflowを直接渡す試作 | checkReceipt → nested → includeChangedStock | quantitiesの1か所。thenの引数は推論できる | 数量再検証と計画作成の名前が外側のtrace・capture・構成図へ現れる |

注釈の数は接続用callbackに限る。共通の計画投影finishの引数型、モデルの型、
load/saveやfixtureの型まで不要になったという意味ではない。
コード行数・実作業時間・理解しやすさを測った結果でもない。

平らな試作は、既存withInputで成功した再検証と元の文脈を組にし、
その組を普通の関数へ渡して訂正計画を作る。Resultの判定・成功値の取り出しはruntimeへ委譲できる。
ただし、finishFlatの引数は前段から自動的には推論されず、ReceiptDecision<Context>を注釈する。
既存の[入力の組の推論制限](business-input-pair-inference.md)を解消した例ではない。

Workflow.thenは前段の成功型でcallbackを文脈付けするため、その追加注釈は不要になる。
一方、businessへ渡したnested.runは通常の関数であり、内部のtraceや構造を公開する契約がない。
describeFlow(nested)では2つの名前が見えるが、describeFlow(businessのcommand)では見えない。
例外的な欠損ではなく、現在の通常関数のopaque境界である。

## 検査した範囲

- 現行と3試作が、独立に書いた成功結果・注文/入荷/在庫のwrites/checksに一致する。
- 不正な版と数量超過では後続・保存に進まず、planはnullとなる。
- 計画作成後の在庫不足でも保存せず、元の入力・関連状態を変更しない。
- 4段階/3段階のtraceと、内側/外側の構成図の違いを直接検査する。
- 未検証の文脈、前段の組の欠落、要求の数量欠落を型で拒否し、正しい接続を受理する。
- 同じ検査を開発版tarballをインストールしたconsumerでも実行する。

試作のfinishは訂正計画の小さな投影をテスト内へ明示的に再記述している。
製品コードの共有APIに昇格したものではなく、その重複を本採用時の設計として推奨しない。
loadは固定fixture、saveは呼出し回数を数える関数であり、DB・CAS・並行実行の新しい検査ではない。
既存のメモリ/SQLite比較の範囲が増えたとも扱わない。

## 次に解消する不足

業務計算を再利用可能な構成へ分けても、型の文脈と内部観測を同時に保てる接続が必要である。
具体的には、既存Workflowの型付き構成をbusinessへ接続する候補を検討し、
関数本体の解析や内部値の無条件収集をせず、明示された段階のtrace・capture・構成図を保つことを確認する。
普通の関数を並べる入口と、既存の入力・失敗型・保存契約も維持する。

直接接続の候補では型の文脈と内部観測を両立できた。ただし、どの試作も現行の業務経路へ置き換えていない。
手書きResult接続が残るという判定は維持する。
これは講演が特定のWorkflow APIを要求したという意味ではなく、
iz-22/24、qbf-19の記述負担とw0o-13の明示的な途中状態を両立するためのKoyuki側の課題である。
独立利用者による試用は未実施で、全講演の完全実現やReact/Elm同等のDXは未確認のままとする。
