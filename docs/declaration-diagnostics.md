# 業務コードを実行せずに宣言の位置を診断する

開発用CLIはTypeScript/TSXのソースを構文解析し、既知の宣言の静的なメタデータを検査する。
対象モジュールをimportせず、業務関数、トップレベルのコード、getter、repository、
参照先モジュールを実行しない。既存の型チェックとは別の任意の検査である。

```sh
npm run check:declarations -- src/tags/model.ts src/tags/events.ts src/expenses/application.ts
npm run check:declarations -- --json src/expenses/application.ts
npm run check:declarations -- --json src/experiments/procurement/application.ts
npm run check:declarations -- --json src/shipping/domain.ts
npm run check:declarations -- --json src/shipping/feature.ts
npm run test:declarations
```

タグと経費の11宣言を、診断・未解決項目とも0で検査する実例を含む。
購買アプリの6つのbusiness宣言では、25操作の既定IDを検査する。
CLI自体はリポジトリの開発ツールであり、公開npm packageのbinや実行時依存には追加しない。
[Babel parser](https://babeljs.io/docs/babel-parser)と[traverse](https://babeljs.io/docs/babel-traverse)は固定版の開発依存。
型チェックに使うTypeScript 7や、Web標準のみ・実行時依存ゼロのcoreは維持する。

## 診断と判断しないこと

| code | 判定 | 範囲 |
| --- | --- | --- |
| AMBIGUOUS_STEP_LABEL | warning | 同じdefineTransition内で同名の段階がある。traceの名前の対応が曖昧になる。業務処理の誤りという証明ではない |
| AMBIGUOUS_WORKFLOW_LABEL | warning | 静的に接続したWorkflowの段階名が重複する。分岐の別経路も含むため、同じ実行で両方が走るという意味ではない |
| AMBIGUOUS_PROCESS_LABEL | warning | 静的なProcess内で、effect・接続したWorkflow・bindMutationの保存操作IDのtrace名が重複する |
| REPEATED_OPERATION_ID | warning | 選択したファイル集合の別宣言で同じ明示operation IDを使う。共有する保存境界なら意図的な場合もある |
| RESERVED_APPLICATION_OPERATION | error | 静的に読めるApplication操作テーブルがdismissや@始まりの予約名を使う |
| PARSE_ERROR | error | ソースを構文解析できない。TypeScriptによる型チェックの代わりではない |

すべてファイル名・1始まりの行/列・説明を持ち、重複には先の位置も付ける。
警告は名前変更や共有意図の確認に使い、共有save関数を使ったこと自体は診断しない。
別のtransitionの同名段階も、それだけでは警告しない。
独立したWorkflow同士の同名段階も警告しない。
businessのthen等、公開型で既に拒否されるものの重複診断を今回追加する目的ではない。

通常の終了コードは、errorがあれば1、なければ0。--strictを付けるとwarningも1となる。
引数不足・読み込み失敗は2。--jsonはkoyuki.declaration-diagnostics.v1のJSONを返す。
診断0でも全宣言の妥当性を示すvalidフラグは返さない。

## 認識する構文と未解決の扱い

koyuki、またはframework/index.js等からのimportを識別し、別名importとnamespace importを扱う。
スコープで隠された名前、type-only import、他のモジュールの同名関数をKoyukiと取り違えない。
constの参照、as/satisfies、静的な文字列・数値キーを読み、任意の式は評価しない。

defineTarget / defineUseCase / defineCommand / bindMutation / defineUseCaseGroupのoperation、
defineTransitionのstep名、defineApplicationの操作名を対象とする。
businessでは、operation resolverの指定がなく、nameと操作テーブルが静的に読めるとき、
coreと同じ`${name}.${operationName}`の既定IDを検査する。数値名は実際の文字列キーを使う。
明示IDとbusinessの既定IDの重複も、操作のキー位置を付けて報告する。
checkedOperationIdsは検査したIDの出現数であり、重複や共有を除いた業務機能数ではない。
独自resolverを呼んだり、その関数本体からIDを推測したりせず、未解決として残す。
Object literalの__proto__ setterをownデータキーと見なさず、そのテーブルも未解決にする。
動的なID・spread・関数で作るテーブル・import先にある段階の実体はunresolvedとして位置と理由を残す。
通常関数か名前付きStepか判別できない値に、推測で自動ラベルを付けない。
defineApplicationやbusinessに動的な操作テーブルを渡すこと自体は正当なので、未解決をエラーにはしない。

Workflowでは、既知のimportの`workflow(name, rule)`を起点とする`then`と`branch`を読む。
ローカルconst経由の接続と、静的なyes/noのWorkflowを展開し、同じ構成内でtrace名が
重複すれば両位置を報告する。branch自身のtrace名は実装と同じ`name:yes`/`name:no`とする。
別経路に同名段階があっても名前だけでは図へ一意に対応できないため警告するが、
その両方が実際に実行された、または業務規則が誤っているという判定ではない。
共通prefixを再利用しても、同じソース位置の組への警告は重ねない。
動的な名前・importされた分岐の実体・循環参照・展開上限は未解決として残す。
展開は一つの構成につき1024個のconstruction callまでで、無制限な全展開ではない。
未知のオブジェクトのthen/branchを、メソッド名だけでWorkflowと取り違えない。
任意のメソッド・関数内部・live spanの名前全体を検査する機能ではない。
送料の3つのWorkflowでも、業務関数やpredicateを実行せず診断・未解決とも0を確認する。

Processは既知のimportの`process()`を起点として、`through`・`effect`・`commit`を読む。
`through`へ渡すローカルWorkflowの名前と、`effect`自身の明示名を接続する。
`commit`はローカルの`bindMutation`のWorkflowと保存操作IDを読む。
同じWorkflowを再利用する場合、二つのthroughの参照位置を報告する。
WorkflowとProcessで共通の展開予算を使い、一つの構成につき1024 construction callで制限する。
import先のWorkflow・不明なcommit・動的effect名は、位置付きの未解決として残す。
effect・save・projectorは実行せず、その内部traceや任意の詳細loaderは解析しない。
Processのlive観測で使うcommit scope名を、返却traceの段階名と混ぜない。
送料のfeatureでは保存操作IDを検査し、importされた3つのWorkflowは未解決として報告する。
domainを別途検査しても、ファイル間の接続まで解決できたという意味にはしない。

検査はソース上に書いた定義と静的なconst参照の展開であり、実際に到達するコードや、
オブジェクトの後続変更・任意の別名経由の変更を解析した結果ではない。
複数の選択ファイルを一つの検査範囲として扱うため、独立したアプリの共通operation IDは
別々に検査するか、warningの説明を踏まえて共有意図を確認する。
実行時に生成される宣言、再export経由の全参照解決、任意のメソッドチェーン、
分岐・状態の網羅性、関数本体の純粋性や業務ルールの正しさは証明しない。
このためIssue #6全体の完了とはしない。

[22件の検査](../scripts/declarations.test.mjs)は、位置、正当な共有、名前のshadowing、
未解決、実例に加え、対象ファイルへ副作用・throw・存在しないimport・getterを置いても
それらを実行しないことを確認する。CIのcore jobでも継続する。
購買の25操作には、独立した期待ID一覧と重複する宣言をテスト用に追加し、
各操作に対応する25件の警告が出ることも確認する。元のアプリの実行や定義変更は行わない。
これは講演が指定したCLI仕様ではなく、Koyuki側の開発支援の具体化である。
