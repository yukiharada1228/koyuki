# 未完了Issueと現在の実装の照合

2026-11-25にGitHubの未完了Issue #1–#8を初回照合した実装revisionは
`6c78970b8b5fb8f23b54cfdd684f332ae6f2f15b`。以後の実装は下段に記録し、表も更新している。
Issueがopenであること自体を未実装の証明にはせず、提案の完了条件と現行コードを区別する。
ここにある将来案すべてが講演で要求された機能という意味でもない。

2026-11-26（日本時間）に、公開Issue #1〜#8の本文とopen状態を再取得した。
#1〜#5については、本文の完了条件と下記のコード・検査を個別に照合した。
#6〜#8は`61453d6`の実装まで進めた後、本文を再取得して下段で条件別に再点検した。
他DB・分散相関・保持運用の追加実装を、元の完了条件へ暗黙に追加しない。

| Issue | 現在使える根拠 | 満たしたと扱えない条件 |
| --- | --- | --- |
| [#1 共通transaction](https://github.com/yukiharada1228/koyuki/issues/1) | [同期共通境界](transactions.md)をタグ・経費・経費receiptへ接続し、本文の4完了条件を実例で検証。callback型の非同期契約もPrismaへ接続済み | 任意driverの原子性や分散transactionは保証しない。他driverやTarget全体の相関観察は追加範囲であり、本文の4条件の未充足とは分ける |
| [#2 相関trace](https://github.com/yukiharada1228/koyuki/issues/2) | [Application実行IDと詳細trace](application-execution.md)、[Program](program-execution.md)、live timing・親子spanで本文の4完了条件を検証 | opaque関数内部・分散相関・永続履歴は未提供。本文が要求する対応coreの実行相関と、全関数・全システムの観察を区別する |
| [#3 構成図](https://github.com/yukiharada1228/koyuki/issues/3) | [JSON/Mermaid構成図](flow-structure.md)で明示branch・IO・保存を保持。送料を国内/海外の明示分岐へ変更し、本文の4条件をタグ・送料の実例で検証 | Traceとの対応は名前による照合。任意の関数内部のifの解析、業務状態図の自動導出、完全なnode/span対応は提供しない |
| [#4 再送と限定retry](https://github.com/yukiharada1228/koyuki/issues/4) | [withReplay](replay.md)、[永続receipt](procurement-replay.md)、[retryEffect](retry.md)に加え、経費adapterのhost指定versionと既存形式・version衝突の検査を追加。本文の4完了条件を指定した実例と方針で確認 | withReplay単体は再試行しない。未適用・冪等性はhostの保証。経費例はreceiptを自動削除せず保持し、異なる定義versionの同じ要求IDは拒否。期限削除・自動移行の運用機構は未提供 |
| [#5 共通監査](https://github.com/yukiharada1228/koyuki/issues/5) | [共通形式とSQLite原子保存](audit.md)をタグ・経費へ接続し、本文の5完了条件を実例と契約文書で検証 | 保持・削除と改ざん耐性の保証範囲を文書化する条件は、全運用機能を内蔵する条件とは異なる。他DB adapter・実運用・改ざん検出・拒否ログは未提供 |
| [#6 宣言検査](https://github.com/yukiharada1228/koyuki/issues/6) | [接続の型検査](workflow-input-contract.md)、配布宣言の負例。[非実行のソース診断CLI](declaration-diagnostics.md)で明示/既定ID・段階名・Application予約名を位置付きで報告。明示Workflowのthen/branch・const参照も展開し、同名traceの曖昧さを警告。Processのeffect・through・ローカルbindMutationも接続 | 独自resolver・動的定義は未解決として残す。全参照の解決、分岐・状態の網羅性、エディター診断、任意の変更解析は未提供。型・構文・メタデータ検査を業務規則の証明とは扱わない |
| [#7 有限モデル検査](https://github.com/yukiharada1228/koyuki/issues/7) | [明示モデルの有限探索](finite-model.md)で上限・反例・実装比較を指定。[経費](expense-state-exploration.md)は最大7操作で照合 | [限定採用評価](finite-model-adoption.md)で維持する責務・記述量・追加価値を整理し、任意の実験用入口として継続採用。モデルの同値性・抽象化・実装対応は利用者の契約。保守時間・チーム効果は未測定 |
| [#8 テスト生成](https://github.com/yukiharada1228/koyuki/issues/8) | [seed付き操作列と反例削除](model-sequences.md)で経費を独立仕様と照合。[タグ](tag-model-sequences.md)はメモリ・SQLite各320操作を比較。[非同期比較](async-model-sequences.md)と[指定payload候補の縮小](event-payload-shrinking.md)も両adapterで検査。[初期状態候補](initial-state-shrinking.md)は経費の反例でも縮小 | DB等の隔離・簡略化候補はhostの契約。[雛形出力](model-test-template.md)を追加。期待仕様・生成器・比較は利用者が記述する。全候補での最短列は未検証。sampledを完成・全状態の証明としない |

## 共通境界の実装前に固定した契約

以下は当初の実装順序と受入条件の記録である。#1を先行させたのは、#5の成功監査と#4のreceiptも、
同じ保存先で状態と原子的に保存できる契約に依存するため。後続の実装状況は上表と下段に記す。

実装前に固定すべき契約は次のとおり。

1. transactionの範囲は同じadapter・保存先内。外部HTTPや別DBを暗黙に含めない。
2. callbackのResult失敗、throw/reject、commit失敗を区別し、状態と履歴の片方だけが残らないことを確認する。commit結果が不明な場合を「必ず未保存」と偽らない。
3. ネストは明示して拒否するか、adapterが提供するsavepoint等で意味を定義する。同じ接続を並行利用して別操作のtransactionへ混入させない。
4. 開始・確定・失敗の観察側の例外で、確定済み保存を失敗に置き換えない。入力や操作者情報を既定で収集しない。
5. 経費の履歴書込み失敗、タグの保存失敗、別接続・別プロセス競合、commit障害を実際のadapterと障害注入で検証する。fakeだけでDBの原子性を証明しない。

これは実装前の受入条件であり、現在の共通transaction APIの詳細仕様は[契約文書](transactions.md)を参照する。
共通境界の存在だけで監査・retry・構成図・モデル検査の条件まで満たしたとは判断しない。
また、これらを実装しても独立利用者の開発体験や全編音声との照合は別途残る。

## #1〜#5の完了条件別の再点検

参照する本文の最終更新は、#1が2026-11-24T08:47:19Z、#2が同08:47:20Z、#3が同08:47:21Z、
#4が同08:47:23Z、#5が同08:47:24Z。下表の充足は指定した実例と契約の範囲での判定であり、
GitHub上のIssue状態、全講演の完全実現、任意のadapterや利用者への保証とは別である。

| #1の条件 | 確認した根拠 |
| --- | --- |
| タグ・経費の業務定義を変えず共通保存境界を使う | [タグ](../src/tags/sqlite.ts)と[経費](../src/expenses/sqlite.ts)はcreateSyncTransactionを使用。初回照合commitから現在までdomain.ts・events.tsに差分なし |
| 状態と履歴の片方だけを残さない | [経費SQLite検査](../src/expenses-sqlite.test.ts)の履歴障害、[監査SQLite検査](../src/sqlite-audit.test.ts)のhistory/receipt/audit障害で全変更のrollbackを確認 |
| 別接続・別プロセスの競合で一方だけ成立 | 同じ経費SQLite検査の2接続・2プロセス競合、および監査SQLite検査のタグ競合・同時再送 |
| ネスト・Result失敗・例外・commit失敗の契約 | [同期検査](../src/transaction.test.ts)、[非同期検査](../src/async-transaction.test.ts)、[契約](transactions.md)。commit失敗を未保存と偽らずunknownとして扱う |

Target専用の新しい設定欄ではなく、既存のsave adapter内で共通境界を使う具体化である。
別DBや外部APIを暗黙に同じtransactionへ入れる実装にはしていない。

| #2の条件 | 確認した根拠 |
| --- | --- |
| 取得から検証・要件・更新・保存・完了を同じ実行へ結ぶ | [Application検査](../src/application-execution.test.ts)に全役割を通る例を追加。単一executionId、段階列、完了、要件失敗後の保存停止を確認 |
| 途中I/Oと選択した分岐を記録 | 同じApplication検査の詳細loader・選択branchと、[live検査](../src/live-execution.test.ts)の親子span。未実行の枝を捏造しない |
| 観察の有無で結果とI/O回数を変えない | 同じ入力を観察あり／なしで実行し、結果とload・Rule・saveの呼出し回数を比較。run/runDetailedを二重実行しない |
| 解除・観察失敗・機微情報の非記録 | Application・[Program検査](../src/program-execution.test.ts)の購読解除とthrow/reject分離、認証情報と例外文面が記録されない検査 |

通常のResult関数が内部段階を公開しない場合まで観察できる保証ではない。
任意の業務関数を解析する能力を、この条件の達成から導かない。

| #3の条件 | 確認した根拠 |
| --- | --- |
| 図の取得で業務関数やI/Oを実行しない | [構成検査](../src/flow-structure.test.ts)でpredicate・Rule・portの呼出しゼロ。[実例検査](../src/flow-examples.test.ts)と[demo](../src/examples/flow-structure.ts)でもRepository・送料portを呼ばずに取得 |
| タグの直列処理と送料の分岐・I/Oを図示 | タグのvalidate/require/evolveと、送料のshipping-serviceのyes/no両経路・見積I/O・保存を同じ構成APIで取得 |
| 宣言した構成と実行した経路を区別する | 送料の国内/海外を一回ずつ実行し、対応するサービス生成の名前だけがok、他方がnoneとなることを検査。図の取得で再実行しない |
| 型・関数名だけで完全な業務状態図を導出したとしない | [図の契約](flow-structure.md)はdeclared-compositionを明示。関数本体はopaque、同名はambiguous、不明な記録はunmatchedTraceに保持 |

この送料例は元の単一関数を反射して図を作る方式ではなく、通常の業務関数を明示的なbranchへ接続した。
通常TSの比較版はWorkflowを呼ばず、同じ業務関数・portsを手続き的につなぎ、結果とI/O順序を比較する。
診断の段階名は変更したが、入力・保存結果・失敗の型と操作IDは維持している。

| #4の条件 | 確認した根拠 |
| --- | --- |
| 応答喪失後も更新と履歴を一度に保つ | [経費再送検査](../src/expense-replay.test.ts)のcommit応答・receipt照会喪失、[retry契約](retry.md)の明示的な冪等性指定 |
| 同時再送・入力違い・保存前後の障害 | 同検査の別接続、fingerprint不一致、receipt書込み障害と、[定義version検査](../src/expense-replay-version.test.ts)の異なるhost versionによる競合 |
| 業務拒否・権限・version競合を無条件retryしない | 同検査の非再試行ポリシーと[retry検査](../src/retry.test.ts)のterminal Result・例外保持 |
| 上限・待機・中断・保持・定義versionの扱い | retry検査の試行回数とAbortSignal、[経費の保持・定義version方針](replay.md)。既存形式を維持し、自動削除なし・ID再利用なし・version変更時の衝突拒否を具体化 |

保持期間や定義versionの扱いを定めることと、削除ジョブや自動移行を実装することは異なる。
今回のadapter設定は業務規則やcore APIを変更せず、ホストが選んだ定義versionを要求の同一性へ結び付ける。
外部システムのexactly-onceは元のIssueでも範囲外であり、ここから保証しない。

| #5の条件 | 確認した根拠 |
| --- | --- |
| タグと経費で同じ形式を使う | [共通記録器](../src/adapters/sqlite-audit.ts)、[core検査](../src/audit.test.ts)、監査SQLite検査でkoyuki.audit.v1を比較 |
| 保存と監査が一緒に成立・不成立となる | 監査SQLite検査のINSERT障害・履歴障害・receipt障害で状態と監査をまとめてrollback |
| 操作者を未検証payloadから採用しない | 同検査で偽造actorIdを入力へ加えても、hostのidentityを記録する |
| 機微項目・保持削除・改ざん耐性の範囲を明記 | [監査契約](audit.md)は許可したmetadataのみ、自動削除なし、hostの保持責任、直接SQLへの改ざん耐性なしを明記。運用済みという証拠ではない |
| 再送で成功監査を増やさない | タグreceiptと経費receiptの再取得、2つのOSプロセスの同時再送で非重複を確認 |

この5件について、元の完了条件を実例で満たす根拠があることと、より広い運用拡張が未提供なことを分ける。
#6〜#8は以下で別に再点検し、提案全体と元の完了条件を分ける。

## #6〜#8の条件別の再点検

GitHub本文のupdatedAtは#6が`2026-11-24T08:47:26Z`、#7が`2026-11-24T08:47:27Z`、
#8が`2026-11-24T08:47:29Z`。以下はこれらの本文と現在のソースを比較した記録であり、
Issueのcloseや外部へのコメントは行わない。

### #6 宣言診断

| 元の完了条件 | 根拠と判定 |
| --- | --- |
| 問題位置と修正可能な診断 | [CLIの検査](../scripts/declarations.test.mjs)でファイル・行・列・関連位置・説明を検査。WorkflowとProcessの名前の曖昧さも接続位置で報告する |
| タグ・経費の実例 | 両業務の11宣言を非実行で解析する検査を維持。送料と購買の実例も追加 |
| 型検査と同じ診断を増やさない | 段階名や操作IDの共有をwarningとして報告し、型で既に拒否するbusiness.then等の診断は追加しない。任意の業務関数の型・純粋性を再証明しない |
| 業務関数・IOを実行しない | トップレベルthrow・存在しないimport・getter・Workflow引数・Processポートに副作用を置いても実行しないCLI検査 |

この4条件を実例で確認できることと、提案全体の参照解決・分岐や状態の未対応検査が
未提供なことを分ける。動的定義やimport先を未解決と報告する機能は、未登録参照の判定そのものではない。
エディター診断は本文でも必要に応じた展開であり、必須条件として追加しない。

### #7 有限モデル検査

| 元の完了条件 | 根拠と判定 |
| --- | --- |
| 対象・抽象化・上限の明記 | [有限モデル契約](finite-model.md)と[経費](expense-state-exploration.md)で金額・操作者・版数・対象操作・深さと件数を明記 |
| 違反時の反例操作列 | 型の合う誤実装、誤った参照遷移、自己承認について初期状態と操作列を検査 |
| モデルの性質と実装全体を区別 | 37状態の承認過程のpassedと、編集を含む深さ7のlimitedを区別。DB・認証・無限状態の証明とはしない |
| 保守コスト・追加価値・採否 | [限定採用評価](finite-model-adoption.md)で実際の記述量と維持する責務を整理。型の合う不具合の検出と、不適切なkeyでの見逃しを対照検査し、任意の実験用入口として継続採用を判断。保守時間・チーム効果は未測定 |

最終条件について限定的な技術評価と採否を追加した。これを独立利用者の効果測定と
置き換えず、一般推奨や講演全内容の完成の根拠にはしない。

### #8 操作列と雛形生成

| 元の完了条件 | 根拠と判定 |
| --- | --- |
| 経費の金額・権限・承認/却下 | [経費の検査](../src/expense-state-exploration.test.ts)が4金額境界・6状態・想定した失敗への到達をassert。独立仕様から生成した3 seedのテストも配布物で実行 |
| タグの重複・上限・古いversion | [タグの検査](../src/tag-model-sequences.test.ts)でメモリ・SQLite各320操作と想定する失敗の到達をassert |
| 再現するseedと最小の操作列 | seed・元の列・縮小後のwitnessを返す。1操作削除に対する最小性と予算打切りを区別。全候補における最短列を証明したとはしない |
| メモリ/SQLiteの同じ契約 | タグの独立仕様・生成器を両adapterで共有。比較ごとの隔離を使う生成コードも実tarballで検査。経費の生成契約はドメイン処理であり、DB比較へ置き換えたとはしない |
| 雛形と人が指定する期待仕様の区別 | [生成器](model-test-template.md)は未記入で必ず失敗する雛形と、利用者指定modelsを接続するテストを出力。期待値を実装の返却値から作らない |

操作列の「最小」の保証強度には上記の制限がある。
[タグの変更再保存](tag-replay-model-sequences.md)は独立仕様から生成し、同一・旧版・改変した
変更をメモリ／SQLiteで比較する。
[経費の要求モデル](expense-request-model-sequences.md)では、要求ID付きの同一・変更した元入力と、
古い成功出力・現在のDB状態を別々に比較する。応答喪失・並行競合・定義version変更や
宣言上の全失敗段階を、同じ生成契約で網羅したとは確認していない。既存の再送テストが通ることを、生成検査の網羅性へ読み替えない。

## 同期境界の実装後の差分

上表の#1は同期adapter向けに更新した。[契約・検査・制限](transactions.md)を参照。
共通境界の追加によって#4の限定retryや#5の監査形式まで完成したとは扱わない。

## 共通監査の追加

#5は[SQLiteの成功監査](audit.md)を追加した。監査表があるDBへの設定なしの更新も拒否する。
保持・削除・改ざん耐性については保証範囲を明記し、運用検証まで完了したとは扱わない。

## Application観察の追加

#2へ[Applicationの実行観察](application-execution.md)を追加した。詳細commandを二重に実行せず、
段階名と成否を同じexecutionIdへ接続する。続く開発版では対応するcoreのlive timing・親子spanも追加した。任意の関数内部や分散相関まで実現したとは扱わない。

## 宣言構成図の追加

#3へ[構成図](flow-structure.md)を追加。通常の関数やIOを実行せず、明示した構成だけを取得する。
名前の重複は曖昧として表示し、関数内部の分岐や業務状態図を自動で証明したとは扱わない。

## 経費の独立仕様探索の追加

#7の一部として[経費の遷移列](expense-state-exploration.md)を有限探索した。
初期8状態・各状態128操作・最大7操作で、到達132状態と14,464操作を照合した。
失敗14,000件を含めて独立仕様と一致し、状態の復元と保存の遷移条件も確認した。
続いて[koyuki/testing](finite-model.md)へ再利用可能な明示モデル検査を追加した。
経費の探索は深さ上限によるlimitedであり、無限の版数や#8のseed・縮小器の完成ではない。

編集を除いた一回の承認過程も別に探索し、37状態・1,776操作の有限グラフを打切りなしで検査した。
自己承認拒否15件と終端状態での再承認拒否192件を実装と照合し、モデルを意図的に壊すと
申請→自己承認の反例が出ることも確認した。詳細と抽象化の範囲は[経費の探索](expense-state-exploration.md)を参照。

## 限定retryの追加

#4へ[retryEffect](retry.md)を追加。Resultの失敗ごとに未適用または冪等性を明示し、
試行上限・待機・AbortSignalによる中断を扱う。in-flightの成功は中断で隠さない。
SQLiteではcommit応答と直後のreceipt照会の喪失を注入し、2回目の呼出しが成功記録を返すこと、
更新・履歴・receipt各1件を確認した。権限・version・idempotency競合は再試行しない例もある。
保持・削除の運用、定義versionの移行、永続scheduler、外部副作用のexactly-onceは未提供。
