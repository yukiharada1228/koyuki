# 業務コードを実行せずに宣言の位置を診断する

開発用CLIはTypeScript/TSXのソースを構文解析し、既知の宣言の静的なメタデータを検査する。
対象モジュールをimportせず、業務関数、トップレベルのコード、getter、repository、
参照先モジュールを実行しない。明示した入力ファイル間の限定的な参照解決は行う。既存の型チェックとは別の任意の検査である。

```sh
npm run check:declarations -- src/tags/model.ts src/tags/events.ts src/expenses/application.ts
npm run check:declarations -- --json src/expenses/application.ts
npm run check:declarations -- --json src/experiments/procurement/application.ts
npm run check:declarations -- --json src/experiments/procurement/application.ts src/experiments/procurement/domain.ts src/experiments/procurement/inventory.ts src/experiments/procurement/receipt-pipeline.ts src/experiments/procurement/request-pipeline.ts
npm run check:declarations -- --json src/shipping/domain.ts
npm run check:declarations -- --json src/shipping/feature.ts
npm run check:declarations -- --json src/shipping/feature.ts src/shipping/domain.ts
npm run test:declarations
```

タグと経費の11宣言を、診断・未解決項目とも0で検査する実例を含む。
購買アプリの6つのbusiness宣言では、25操作の既定IDを検査する。
applicationだけでは13段階名を解決し、import先の43箇所は未解決として残す。
上記の5ファイルを明示すると6宣言・25操作ID・56段階名を解決し、診断・未解決とも0になる。
申請作成・編集、入荷・返品・訂正は普通の関数や名前付きStepを直接並べる。
現在の選択ソースに独立したWorkflow宣言はなく、6宣言はすべてbusinessである。
これは宣言のメタデータの検査であり、業務関数の実行や内部の全接続の検証は行わない。
CLI自体はリポジトリの開発ツールであり、公開npm packageのbinや実行時依存には追加しない。
[Babel parser](https://babeljs.io/docs/babel-parser)と[traverse](https://babeljs.io/docs/babel-traverse)は固定版の開発依存。
型チェックに使うTypeScript 7や、Web標準のみ・実行時依存ゼロのcoreは維持する。

## 診断と判断しないこと

| code | 判定 | 範囲 |
| --- | --- | --- |
| AMBIGUOUS_STEP_LABEL | warning | 同じdefineTransition内で同名の段階がある。traceの名前の対応が曖昧になる。業務処理の誤りという証明ではない |
| AMBIGUOUS_WORKFLOW_LABEL | warning | 静的に接続したWorkflowの段階名が重複する。分岐の別経路も含むため、同じ実行で両方が走るという意味ではない |
| AMBIGUOUS_PROCESS_LABEL | warning | 静的なProcess内で、effect・接続したWorkflow・bindMutationの保存操作IDのtrace名が重複する |
| AMBIGUOUS_BUSINESS_RULE_LABEL | warning | 同じbusiness操作のrun配列内でラベルが重複する。直接渡したWorkflowの内部と両分岐も含み、別の操作同士は比較しない |
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
JSONのcheckedBusinessRuleLabelsは、静的に解決したrunのラベルの出現数であり、業務機能数ではない。
Workflowの内部と両分岐の選択markerも含むため、一回の実行で呼ばれるRule数や操作配列の長さとは異なる。

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
動的なID・spread・関数で作るテーブル・選択外のimport先にある段階の実体はunresolvedとして位置と理由を残す。
通常関数か名前付きStepか判別できない値に、推測で自動ラベルを付けない。
defineApplicationやbusinessに動的な操作テーブルを渡すこと自体は正当なので、未解決をエラーにはしない。

businessの操作は配列、またはrun配列を持つ静的なオブジェクトとして読む。
通常関数には配列位置からrun:1等の既定名を付け、既知のstep(name, rule)や
構造的な{name, rule}には静的な文字列名を使う。withInputの返却関数も通常関数として扱う。
既定名と明示名の衝突も検査する。constで再利用したStepは、それぞれの接続位置を報告する。
独自operation resolverや動的なbusiness名でIDが未解決でも、読めるrunラベルは独立に検査する。
空配列、穴、spread、不明なfactory、動的なStep名は未解決とする。
一つのbusiness宣言の全操作で、通常の段階またはWorkflowのconstruction callを合わせて1024個の展開予算を共有する。
対象はrunのruleラベルだけであり、load/saveやその内部traceとの衝突は検査しない。
関数本体、関数への後続のプロパティ追加、型の接続、実行時の変更を検証する機能ではない。

既知のworkflow(name, rule)からthen/branchで構成したWorkflowをbusinessへ直接渡す場合は、
その内部名を前後の通常関数・Stepと同じ操作の範囲へ展開する。const参照や明示した選択ソースの参照も扱う。
branchは両経路とname:yes/name:noのmarkerを含める。実際の選択、同時実行、業務規則の正誤は判定しない。
Workflow内の動的名・解決できない分岐は位置付きの未解決として残し、静的に読める他の名前は検査する。
同じWorkflowを再利用した場合は各接続の参照位置を報告する。
Workflow自体の独立診断は定義箇所も検査するため、内部の重複とbusinessでの接続の警告は異なる範囲である。
既知のWorkflow.runは内部を展開せず、通常関数として配列位置のrun:nを使う。
未知のオブジェクトのrun、条件式で選ぶ候補、独自factory、shadowingされたworkflowは推測しない。

Workflowでは、既知のimportの`workflow(name, rule)`を起点とする`then`と`branch`を読む。
ローカルconst経由の接続と、静的なyes/noのWorkflowを展開し、同じ構成内でtrace名が
重複すれば両位置を報告する。branch自身のtrace名は実装と同じ`name:yes`/`name:no`とする。
別経路に同名段階があっても名前だけでは図へ一意に対応できないため警告するが、
その両方が実際に実行された、または業務規則が誤っているという判定ではない。
共通prefixを再利用しても、同じソース位置の組への警告は重ねない。
動的な名前・解決できないimport先の分岐・循環参照・展開上限は未解決として残す。
展開は一つの構成につき1024個のconstruction callまでで、無制限な全展開ではない。
未知のオブジェクトのthen/branchを、メソッド名だけでWorkflowと取り違えない。
任意のメソッド・関数内部・live spanの名前全体を検査する機能ではない。
送料の3つのWorkflowでも、業務関数やpredicateを実行せず診断・未解決とも0を確認する。

Processは既知のimportの`process()`を起点として、`through`・`effect`・`commit`を読む。
`through`へ渡すローカルWorkflowの名前と、`effect`自身の明示名を接続する。
`commit`はローカルの`bindMutation`のWorkflowと保存操作IDを読む。
同じWorkflowを再利用する場合、二つのthroughの参照位置を報告する。
WorkflowとProcessで共通の展開予算を使い、一つの構成につき1024 construction callで制限する。
解決できないimport先のWorkflow・不明なcommit・動的effect名は、位置付きの未解決として残す。
effect・save・projectorは実行せず、その内部traceや任意の詳細loaderは解析しない。
Processのlive観測で使うcommit scope名を、返却traceの段階名と混ぜない。
送料のfeatureだけを渡した場合、保存操作IDを検査し、importされた3つのWorkflowは未解決として報告する。
featureとdomainを同じ検査に渡すと、3つのWorkflowの参照を解決し、診断・未解決とも0になる。
これは明示された構成の接続であり、関数内部や業務状態の完全性を示すものではない。

## 明示したソース間の参照解決

同じ検査呼び出しへ渡したファイルに限り、相対パスの名前付きimportから、変更されない
export constの初期値と、再代入されないfunction宣言をたどる。importの別名、ローカルbindingのexport別名、複数ファイルを
またぐconst参照を扱い、Workflow・Process・bindMutation・段階名等の既存の静的解析へ接続する。
解析に渡す順序へ依存せず、参照先の診断は参照先のファイル名・行・列を保持する。
解析呼び出しをまたいで参照情報を保持しない。

ファイルはCLI引数またはanalyzeDeclarationsの入力で明示する。importを見て自動的にファイルを
読み足したり、package resolver、実モジュールのimport、getterやトップレベルの評価を行ったりしない。
指定した正確なパスのほか、.jsから.ts/.tsx、.mjsから.mts、.cjsから.ctsへの対応だけを扱う。
複数候補や同じ入力パスの重複があれば、一つを推測で選ばない。

選択外のファイル、拡張子省略、package名・path alias、namespace/default/type-only import、
別モジュールからの再export、letや再代入されたbinding、分割代入、循環した値は解決しない。
対象宣言がそれらを必要とする場合は従来どおりunresolvedへ残す。
全importの存在・型・用途を検査する機能ではなく、診断に不要なimportは走査対象に加えない。
constオブジェクトの後続変更や任意のaliasを介した変更まで解析する保証もない。
WorkflowとProcessの1024 construction callの予算はファイル間の展開でも共有する。


検査はソース上に書いた定義と静的なconst参照の展開であり、実際に到達するコードや、
オブジェクトの後続変更・任意の別名経由の変更を解析した結果ではない。
複数の選択ファイルを一つの検査範囲として扱うため、独立したアプリの共通operation IDは
別々に検査するか、warningの説明を踏まえて共有意図を確認する。
実行時に生成される宣言、再export経由の全参照解決、任意のメソッドチェーン、
分岐・状態の網羅性、関数本体の純粋性や業務ルールの正しさは証明しない。
このためIssue #6全体の完了とはしない。

[47件の検査](../scripts/declarations.test.mjs)は、位置、正当な共有、名前のshadowing、
未解決、実例に加え、対象ファイルへ副作用・throw・存在しないimport・getterを置いても
それらを実行しないことを確認する。明示した参照先にも副作用・存在しないimport・getterを置き、
参照解決で実行や自動ファイル探索が起きないことをCLIで検査する。CIのcore jobでも継続する。
購買の25操作には、独立した期待ID一覧と重複する宣言をテスト用に追加し、
各操作に対応する25件の警告が出ることも確認する。元のアプリの実行や定義変更は行わない。
購買の52個のラベルは5つの実ソースを選択して検査する。テスト内のソース文字列へ
既定名と衝突するStepを挿入した場合に警告することも確認する。この変形は業務処理として実行しない。
これらは保守者側の検査である。独立した利用者による試用記録はまだなく、
詰まった箇所・必要な型注釈・手書きの接続について第三者の開発体験を確認したものではない。
Workflowを直接渡すbusinessには、前後の関数やStepとの衝突、両分岐、部分的な未解決、参照位置、
選択ソース間の接続、通常段階との共有予算を検査する。
別のCLI検査では、選択モジュールのトップレベル・内部Rule・predicateにファイル書込みとthrowを置いても
一度も実行しないことを確認する。静的な警告のstrictでの終了コードも維持する。
これは講演が指定したCLI仕様ではなく、Koyuki側の開発支援の具体化である。
