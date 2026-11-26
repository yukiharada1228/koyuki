# Changes

## Unreleased

- TypeScript 6.0.3のinstalled consumer検査をCIへ追加。buildは7.0.2のまま、宣言・最初のアプリ・783件・15不正定義等を両版で検査する。3つの拒否テストの行位置を両compilerに対応させ、consumerのcompiler版も固定・確認する。入力保持の補正候補が6と7で異なる受理結果となる記録を追加したが、候補自体は未採用。

- 登録サンプルに配送中のlease更新を行うworkerを追加。期限切れの復活と古いclaimによる更新を拒否し、所有権喪失・更新失敗時は送信の中断を要求して完了記録へ進まない。Web標準のタイマーをhostで使い、実SQLiteの10件を配布consumerにも追加。公開コアと従来の固定lease入口は維持する。

- Process.effectの第三引数へ新しいフィールド名を指定し、取得結果を文脈へ加えられるようにした。上書きや情報を失う文脈を拒否し、購買の実経路から16個の単純な射影callbackを削減。従来の射影関数と二引数形式は維持する。

- 明示的rendererのView経路とplanを保存前に確定し、save後にchild getterや変更済みメタデータを再読しないようにした。循環Viewを保存前にCyclicViewで拒否し、単独describeViewも反復処理へ変更。4件の回帰検査を配布consumerにも追加した。

- 明示的なbindMutation rendererで、判断結果のその場の変更や配列属性の差し替えを保存前に拒否する。renderer前の判断記録とdescriptorによるJSON形式検査を追加し、getterや情報を失う値は実行前に拒否。rendererなしのopaqueな通常保存は維持し、7件の回帰検査を配布consumerへ追加した。

- 購買checkReceiptの成功型に、検証済みの入荷accepted・関連注文placedを反映。状態を差し替えた検証文脈の再利用を型で拒否し、状態型だけを外す対照検査も配布consumerへ追加した。実行時の検証順序は維持する。

- 購買の入荷・返品・訂正の次状態型を、在庫計画・互換入口・通常公開操作まで保持する。既存Workflowで接続し、追加callback注釈なしでaccepted/returnedを推論。従来の段階名と再送の広い型を維持し、診断CLIは12宣言・25操作・52ラベルを検査する。元の3つの文脈注釈と一般の推論制限は残す。

- 購買の注文モデルを状態ごとの直和へ整理し、checkOrder成功時にplacedを保持。8遷移関数と4公開操作の次状態型を精密化した。実行本体・拒否順序は維持し、広い戻り型と状態証明の欠落を検出する配布consumerの対照検査を追加。Receipt側の型の拡大は残件として明記。

- 購買サンプルの請求書・支払の8遷移関数の成功型を、実際の次状態へ精密化。通常操作と詳細結果へ既存save経由で伝播し、履歴再送はモデル全体の型を維持する。業務の実行本体は変更せず、配布物でも厳密な型契約と広い型へ戻す対照検査を追加。

- 購買サンプルの保存adapterでplain DTOを更新前に検査し、cloneによるクラス・証明の消失を拒否する。coreのopaque値対応は維持。SQLiteの新規保存と過去receiptの成功型を分け、公開再送のモデルkindを検査する。競合時は今回の計画でなく過去の結果/writesを返すことを3方式と配布物で検査した。

- 登録サンプルの純粋なstart/confirmを、それぞれ実際に生成するChange variantの戻り型へ精密化。版・次状態・イベントの厳密一致と、広い戻り型へ戻す対照検査を配布物へ追加。保存adapterの広い戻り型は維持する。タグの作成前状態と復元の検査も加え、全84話題の対応表の現状説明を更新した。原音・利用者評価・全体の部分充足の判定は変更しない。

- 購買の申請編集も状態検証・明細解析・更新計画のWorkflowへ分離。buyer検証とDraft・解析済み配列の型を要求し、元の版・状態・明細の拒否順序を保持する。旧run:2を3つの明示名へ変更。追加のcallback注釈なしで実経路のResult接続を委譲し、成功130境界・代表失敗274境界の3方式比較、再送・例外・配布物を検査。互換入口・他の内部接続・文脈注釈は残す。

- 購買の申請作成を作成前提・明細解析・計画作成のWorkflowへ分離。既存APIだけでResultの手動接続を実経路から外し、作成前提と解析済み配列のprivateな証明を要求する。旧run:1を3つの明示名へ変更。3方式の観測・再送・I/O例外、配布物consumerを更新し、成功128境界・代表失敗272境界を検査。互換関数と他の内部接続・文脈注釈は残す。

- stepへconstrained generic関数とwithInputを直接渡す型推論を追加。元の文脈付き推論とParameters/ReturnTypeを維持し、宣言した制約・成功/失敗型・privateな証明を保持する。不適合候補・非同期/非Resultを拒否。実行本体は変更せず、追加Contextや元のbusiness/transition推論制限は未解消。

- workflowの先頭でconstrained generic関数とwithInputを使える型推論を追加。元の文脈付き推論と型参照を維持し、宣言した入力・全成功/失敗型・privateな証明を保持する。不適合な関数候補、非同期/非Resultは拒否。実行本体は変更せず、制約にない追加文脈や元のbusiness/transition推論制限は未解消。

- 購買の数量訂正を実Workflowへ移し、数量再検証と計画作成をResultの手動判定なしで接続。計画投影をdomainで共有し、数量検証済み計画の型を要求する。訂正の旧run:2を2つの明示名へ変更し、成功124境界・代表失敗266境界の3方式比較、型の証明・メモリ/SQLiteの停止を検査。互換経路や他のResult接続、3つの文脈注釈は残す。

- 宣言診断CLIがbusinessへ直接渡した静的Workflowの内部名と両分岐を展開し、前後の関数/Stepとのラベル衝突を検査する。既知のrun関数は従来のopaqueな段階として扱い、選択ソース間の参照・共有展開上限・コードを実行しないことを検査。動的なメタデータは未解決として残す。

- businessの操作配列へ既存Workflowを直接接続できるようにした。thenのcallback推論と内部のtrace・選択capture・live span・構成図を維持し、通常関数/Stepとの混在、失敗停止、入力/保存の型契約を検査する。run関数として渡す従来のopaque境界は維持。ruleも持つWorkflowと、Workflowの実行能力をコピーした呼び出し可能関数は、生成時にAmbiguousBusinessStageで拒否する。

- 購買の申請・承認・発注も既存の共通検証と個別判断の配列へ移し、13操作で共通検証の接続を委譲した。拒否の優先順位、二段階承認と発注の保存計画、メモリ/SQLiteの非保存を検証。全25操作の3方式比較を正常117境界・代表失敗259境界へ更新し、I/O例外の比較も継続。コード量や独立利用者の負担の改善を実証した件数とは区別。

- businessの段階に既存のstep(name, rule)を指定でき、通常関数と混在可能にした。名前をtrace・選択観測・構造図へ反映し、具体的な文脈を注釈したwithInputのinline例を配布consumerで検証。Step型も公開。名前なしinlineや任意のgeneric推論は未解消。ruleプロパティも持つ関数は実行本体が曖昧なため、生成時にAmbiguousBusinessStageで拒否する。

- 購買plain/helperへ選択値captureを追加し、Koyukiと観測reportを比較。射影後のsnapshot・機密値の非選択・入力／結果のcapture失敗分離・保存成功の維持・並行呼出しの記録所有権を配布consumerで検証。純粋な射影と通常commandを対象とし、全観測経路や永続監査とは区別。

- 購買plain/helperの独立Applicationへ現在値取得方針を追加。応答消失後の表示更新、不正patch・取得例外からの復旧、複数モデルの現在値反映、取得待ち中のqueueをKoyukiと比較し配布consumerで検証。従来の再送投影も維持し、全体同期・全障害経路の保証とは区別。

- 購買の再送後に影響対象の現在値を取得するApplicationを追加。SQLite read transactionで全キーを復元し、応答消失後の空View・古い過去値の適用を改善。取得失敗・不正patch・破損時は既存表示を維持し、業務を再保存せず再取得できることを配布consumerで検証。全体同期や旧3方式比較の同等性とは区別。

- 購買plain/helper版へ独立Application driverを追加。状態・revision・queue・入力snapshot・通知・例外復旧と再送投影をKoyukiと比較し、実配布consumerで検証。応答消失後のreplayed成功でもViewを自動refreshしない共通の制約を明記。

- 購買plain/helper版へ独立した永続再送driverを追加。共有SQLite/identity境界の下でKoyuki runtimeを使わず、過去結果・要求不一致・保存競合・不明commit照会のreportを比較し、原子的な記録失敗rollbackと重複要求を配布consumerで検証。全25操作の全障害経路やApplication比較とは区別。

- 購買のplain/helper基準実装へ基本traceと保存計画を追加。KoyukiのrunDetailedと成功・load/rule/save失敗のreportを比較し、adapter例外の伝播と同時呼出しの記録分離も実配布consumerで検証。capture・永続監査・再送・Applicationまでの同等性とは区別。

- 購買25操作の通常TS/helper基準実装と共有load contextを追加。3方式×Memory/SQLiteで32回の成功結果と全保存状態を比較し、失敗時の保存停止と基準実装の承認成功型も検査。再送・trace・Applicationまで同等の比較や生産性測定とは区別。

- 購買25操作へ既存withReplayによる共通再送境界を接続。Web Cryptoで要求・actor・操作を識別し、SQLiteで全writesと成功記録を同時保存。応答消失・記録挿入失敗・重複呼出し・過去結果による投影維持を配布consumerで検証。自動retry・外部副作用のexactly-once・全障害経路の網羅とは区別。

- 購買の同じ25操作から通常結果と全writes付き結果を生成し、既存Applicationへ接続。返品時の発注・検収・請求・在庫を一度に投影し、型付きのモデル名付きdispatch、失敗時の投影保持、SQLite rollback後の再実行を実配布consumerで検証。初期読込み・別session同期・再送はhost側の未完了範囲として明記。

- 購買の業務loadを親IDに限定するrelated portへ変更。SQLiteでgroupと親IDを絞るindexを追加し、kind全件listを業務契約から除外。別親の破損行を復元せず対象業務を完了できること、対象行の破損拒否とgroup分離を配布consumerで検証。

- 購買SQLite保存のgroup全件読込みを廃止し、宣言されたcheckの主キー照会とDB一意indexへ分担。未取得の重複行による保存拒否・複合rollbackと、無関係／対象行の破損の区別を配布consumerで検証。load側listの全件取得と性能測定は未改善として明記。

- 購買評価へSQLite hostと状態別の保存値復元を追加。全6モデルの再起動後・別OS読込み、2接続の在庫CAS、最終在庫書込み失敗時の複合rollback、破損データ拒否とgroup分離を配布consumerで検証。再送・永続履歴・取得効率の未検証範囲を明記。

- 購買評価へ在庫引当・解除・移動・棚卸調整を追加し25操作の初期実装を登録。入荷・返品・訂正と在庫差分を同時保存し、引当済み数量の保護・競合・最後のclone欠陥による部分保存拒否を検証。単一group在庫の競合集中と未評価の永続化・再送・比較を明記。

- 購買評価に全量返品・検収数量訂正を追加し21/25操作へ拡張。acceptedのみの数量集計、照合済み請求の未照合化、発注・検収・請求の複合保存と承認／完了との競合を検証。在庫への連動は残る4操作の実装対象として明記。

- 購買評価に支払記録・取消を追加し19/25操作へ拡張。承認済み請求からの金額導出、有効記録の一意性、取消後の再登録、参照番号の再利用拒否を実配布consumerで検証。実送金・返金は対象外。

- 購買評価に請求承認・無効化を追加し17/25操作へ拡張。不一致請求の再登録、承認者の記録、無効化と発注完了の競合・古い完了計画の拒否を検証。複数回の読込みはスナップショットではなく、業務失敗と保存競合の両方で安全に停止する範囲を明記。

- 購買評価に発注変更・取消・完了を追加し15/25操作へ拡張。取消後の有効発注一意性、全数入荷・請求照合による完了条件を検証。請求登録も発注version更新と同時保存し、取消と請求追加の競合を防止。

- 購買評価に申請変更・取り下げ・却下・差し戻し・承認担当変更を追加し、12/25操作へ拡張。状態Unionに終端の却下を追加し、再申請時の不要な承認属性の除去、担当移管後の認可、承認と取り下げの競合を検証。core APIは変更なし。

- 購買評価アプリの最初の7操作を既存business APIで接続。申請・発注・分納・請求照合、複合保存の競合とclone欠陥、非同期repository portを配布consumerで検証。残り18操作・永続化・比較は未実施とし、共通saveの戻り値と複数モデルの投影に残る課題を記録。

- 講演照合の--records-onlyを追加し、原文を公開せずに対応記録の参照・区間・全ページの整合性をCIで検査。原文同一性を未確認として出力し、従来の原文hash・字幕行照合との違いを回帰テストで検証。

- GitHub Actionsへcore・移植性・配布宣言・独立consumerと仕様変更・登録イベント・Prisma adapterの継続検査を追加。Node 26系で実行し、原文ファイルを必要とする講演照合とCIの範囲を区別。

- 顧客照合の作成・更新を別OSの2writerで競合させ、同じ読込み状態から一つだけ成功することと最終状態を実配布consumerで検査。講演の要件別判定を集約し、部分充足と未確認範囲を明示。登録・Prismaの配布検査はtarballを各一時ディレクトリへ分離。

- 顧客照合・直和分岐の実例にSQLite hostを追加。一意制約・更新CAS・古い変更なし判定の拒否・trusted group分離・保存値の復元を検証。2接続の競合と別OSプロセスでの永続読込みを実配布consumerでも確認し、元製品の予約仕様や並列負荷試験とは区別。

- genericなwithInputをinlineのrequireへ置き未注釈evolveと組み合わせる推論制限を、実配布宣言の検査へ追加。制限は未解消として維持し、名前付き要件による複数段階の入力・中間値・失敗型・途中停止を配布consumerで検証。推論用の新しい実行APIは追加せず、再現基準と判断を文書化。

- Workflow.branchのinline型ガードで入力型注釈を省略可能に。タグ比較では型ガード自体の推論も利用できる。前段・predicate・各枝の接続契約を維持し、広いyes枝を通したfalse側の誤接続や定数booleanによる偽の絞り込みも拒否。実配布宣言と利用ガイドで検証。

- 評価済みResultの固定tupleをまとめるcombineを追加。位置別の成功型・brand・失敗型Unionを維持し、最初の失敗Resultを変更せず返す。全失敗収集のcollectや遅延実行とは区別し、業務Workflowの失敗時に保存しないことを実配布consumerでも検証。

- Applicationへオブジェクトメソッドを登録するとthisが失われる不具合を修正。operation/operations/replayOperation/replayOperationsで元のreceiverを保持し、追加ラッパーなしで呼び出せる。通常成功・業務失敗・再送時の投影を4経路で実配布consumerでも検証。

- Workflow.runと通常/再送commandの公開型を関数プロパティへ変更し、配布宣言で入力型を広げた変数に代入して接続検査を迂回できる穴を修正。defineCommand・bindMutation・operation・replayOperationも入力契約を保持。明示的型引数と推論を検査し、Workflow.runを通常のbusiness関数として再利用する例を実配布consumerで検証。

- Workflow.branchとProcess.throughで、配布宣言でも入力の狭すぎるWorkflowを拒否する契約へ修正。Workflow.branchに通常TSの型ガードを受け取る形式を追加。各Unionメンバーを要求する枝を直接接続でき、成功・失敗型を保持。boolean形式を維持し、枝の取り違え・未証明条件の拒否、選択枝のtrace/capture、途中I/Oとの接続を検証。型ガードの正しさとinline入力型注釈の制限は明記。

- 非同期顧客照合後に状態Unionで作成・更新・変更なしを選ぶ実例を既存Process/Workflowで追加。失敗停止・scope不一致・CAS競合・欠陥伝播・型の絞り込みを検査し、実配布consumerへ追加。新しいcore APIは追加せず、永続DB名寄せと予約取込全体は対象外と明記。

- 1本目の本人公開PDF92ページを全体照合し、3資料全198ページのページ別対応を記録。84ページのframework構想を既存APIへ対応付け、開発体験の未実証・DIと純粋性の違い・非公開仕様の確認限界を維持。

- 3本目の本人公開PDF74ページを本文・図・コードまで照合し、ページ別対応を追加。直和の排他性、状態値の観測と永続履歴の違い、命令的実装の許容、教育用アルゴリズムと機能要件の区別を明記。

- 2本目の本人公開PDF32ページを全体照合し、ページ別の実装対応・設計判断・不足を追加。非同期照合後のUnion分岐、combineとcollectの契約差、型記述簡素化の限界を明記。資料検査で全ページ割り当てと根拠パスも点検。

- 本人公開の講演PDF3件を取得し、URL・hash・ページ数・確認済みページを記録。1本目の公開版には動画の複雑な実製品コード画像がないことを確認。保存資料の同一性検査を追加し、全198ページの意味照合や全編視聴の完了とは区別。

- business.runDetailedの任意captureをload/Rule/save/receipt照会へ接続。実行しない過去段階は記録せず、不明commit後の照会も観測。取得・clone失敗は秘密情報を含まないobservationErrorsへ分離し、保存済み業務結果を維持。通常report・型・操作ID・再送契約を維持。

- Workflow.inspectの任意captureで、選択した段階入力・Resultをcloneして観測可能に。Ruleの再実行なしで失敗停止・選択branch・transitionを記録。通常実行のreportを維持し、値の永続保存やbusiness全体への観測設定は未提供。

- 3本目の画面変化50候補と状態観測の補足3枚を確認。省略されたUnion-Find・Maybe/GraphQL Union・文脈・ナップサックの例を記録し、教育例とframework機能要件を区別。全値履歴の未提供と連続視聴の未確認を維持。

- 2本目の追加画面27枚で、29分台が非同期タスク送信と全失敗集約の例だと確認。collectEffectsを明示的I/O境界として追加し、指定並列数・結果順・全失敗集約・欠陥時の新規停止と開始済み処理の待機を検証。同期Rule・自動再送・transactionとは区別。

- 1本目の画面変化73候補と補足4枚を追加確認し、時刻・hash・観察内容を記録。GraphQL境界の例外変換、非同期依存、51分台のframework構想を字幕照合へ補足。画面検出の取りこぼしと細かいコードの判読限界を明記。

- 3本目の省略箇所周辺を10枚の追加静止画で確認し時刻・hashを記録。命令的記述の許容と直和の説明を補足。構造的Unionだけでは両IDを持つ値が通る点を型・JSON境界のテストで明示し、タグと排他フィールドの必要性を区別。連続映像・音声の全確認とは称さない。

- foldEachを追加。前要素の成功状態に依存する同期Result計算を順次接続し、最初の失敗を保持して停止。残予算の明細配分で途中失敗時の保存停止、呼び出しごとの初期化、所有権・例外・型を検証。独立検証のcollectEachと区別し、非同期I/Oは対象外。

- businessを開発版のルートexportへ昇格。通常の同期Result関数の配列から操作を宣言し直接呼び出す推奨入口を文書化。既存APIは維持。独立consumerは実際の開発版tarballとルートimportで検証し、利用ガイドの最小例も実行。npmへの公開は未実施。

- 接続先メソッドの入力型が狭すぎても許容される型の穴を修正。Process.effect/commit・defineAction・withReplayの詳細操作を関数プロパティ契約で検査し、未検証のstring/状態Unionを狭い入力へ渡す接続を拒否。defineActionはloaderを先に推論し、既存の型引数指定と入出力・エラー推論を維持。

- Process.effectにActionReportを返す操作のobject形式を追加。途中commandの詳細traceを保持し、内部失敗でも後続を停止。関数形式の挙動・例外伝播を維持し、途中planや値の自動記録は追加しない。複数集約の実例・独立配布consumer・Nodeなし実行で検証。

- 非公開businessの複数集約接続例を追加。在庫確保と出荷登録の異なるsave/成功型をProcessで接続し、失敗停止・部分成功・adapterによる再実行時の重複防止・内容変更拒否を検証。永続replayや全体transactionとは区別し、内部traceの未展開も記録。

- 1本目の本編・質疑の保存済み字幕2258行を再読し、39区間の対応を追加。3本4034行の割り当てを検査。宣言を優先する方針、I/O注入と純粋性、講演時点の未実施案、チーム導入とテストの負担を区別。全編音声・画面の検証完了は主張しない。

- 3本目の保存済み自動字幕964行を全体再読し、24区間の対応を追加。段階traceと全状態履歴、型付きResultと予期しない例外、継承への注意と禁止を区別し、省略箇所を29分台・40分台の双方で記録。音声・全画面の確認完了は主張しない。

- defineTransitionのvalidateを先に推論してから段階の契約を検査する形へ変更。型付きのevolveと接続するcollectEach/withInputを直接記述可能にし、完全なUseCaseの入出力・エラー型と不正段階の拒否を配布consumerでも検証。generic呼び出しと未注釈evolveを組み合わせる推論制限は引き続き明記。

- collectEachを追加。通常の同期Result関数から可変長配列の検証Ruleを作り、全エラーを元の要素位置付きで集約。明細・合計の検証例で集計/保存の停止、型の保持、Nodeなし実行を検証。非同期列・要素間の依存処理は対象外で、既存defineTransitionのinline推論制限を明記。

- 2本目の保存済み自動字幕812行を読み直し、21区間の実装対応・判断・経験談・不足を記録。字幕hash・区間・根拠パスの検査を追加し、可変長Result列の専用合成APIが未提供である点を対応表へ明記。音声・画面・実装の完全性の証明とは区別。

- processに直接run / runDetailedを追加。純粋な最終遷移が不要なI/O列をそのまま実行し、登録メールの完了記録から空のvalidate/evolveを除去。既存commitは維持し、失敗停止・型・並行実行・例外・Nodeなし実行を検証。

- 未公開APIの仕様変更実験を追加。承認の新たな証拠型・制限ルールを通常TS/helper/既存遷移/businessで比較し、4方式の接続漏れとHTTPエラー対応漏れを型検査で検出。新仕様5テストで境界・失敗停止・Application・過去receiptの契約を検証し、実際の変更diffを出力。

- business試作を休暇3操作へ適用。一時的なprivate候補tarballを独立consumerへインストールし、既存HTTP/GraphQL・Application・旧宣言比較・SQLite移行の31テスト、6件の不正定義拒否、Node型なしでの型推論を検証。通常の配布exportは変更なし。

- 非公開business試作を既存Workflowへ直接接続し、単一関数の空のcomplete段階を除去。共有context/replay接続を内部へ抽出し公開groupの型・挙動を維持。操作ID resolverと経費SQLiteの旧→新（別プロセス）・新→旧replayを検証。

- Strengthen the unpublished business API study with authorization-proof, exact inference, and 64-stage connection checks; use accumulator-based type recursion. Mapped adjacency checks now preserve 64-stage inline tuple inference for shared and per-operation loaders, with errors located at the mismatched stage.

- 非公開のAPI試作：通常関数の配列とbusiness.operation(input)で経費5操作を実行。入力・失敗型、既存の再送・詳細記録・Application連携を検証。配布入口へは追加せず、trace・操作ID互換性などの未決事項を記録。
- チーム開発での価値仮説と比較方針を文書化。通常TSの共通helper版を比較対象へ明示し、旧実験の計測漏れ・タグ比較の古いファイル参照を修正。行数比較を大規模開発・バグ率・生産性の証拠とは扱わない。
- Prisma 7.10.1＋SQLiteの独立在庫サンプルを追加。transaction contextへ既存の業務宣言を束縛し、失敗Result→rollback、2件更新と履歴の原子保存、commit失敗時の専用Clientの後処理、実migrationを検証。コアの依存追加なし。
- 休暇サンプルにGraphQL.js＋HonoのPOST /graphqlを追加。同じ業務宣言でQuery/Mutation分離、結果union、権限、再送、保存後の例外、複数mutationの部分成功を検証。公開npm consumer27件・開発版consumer30件が成功。コア依存の追加なし。
- fromThrowable / fromPromise：既存の同期例外・Promiseを明示した境界で型付きResultへ接続。引数型を維持し、非同期境界は呼び出し時のthrowも変換する。
- 登録→メール→人の確認を、既存のUseCase / ProcessとSQLite outboxで実装。原子保存・lease・再配送・古いclaim・別OSプロセスを配布パッケージから検証。永続workflow機能をコアへ追加したものではない。
- [3講演との論点別対応と未確認事項](docs/lecture-coverage.md)を追加。全内容の完全実現という評価は未完了。
- Program / Applicationはdispatch時にイベントをcloneし、待機中の入力変更から実行を保護。clone不可の入力はPromiseでrejectし、状態と後続キューを維持。
- subscribeの初回通知が失敗した場合は購読を保持しない。配布パッケージの休暇ApplicationでView更新・失敗・再送・待機入力・stale revisionを追加検証。
- [Application全体の開発手順と責務](docs/application-development.md)を追加。
- defineTransition：通常の業務関数から遷移を宣言。requireは任意で、依存する型と失敗を保持し、既存Step定義へ正規化する。宣言は不変、名前は役割ラベルまたは明示した業務名。
- withInput：成功した計算結果と元の入力を保持し、Resultの接続を共通化。経費申請の承認経路を独立したrequireとして宣言し、失敗箇所をtraceへ表示。
- 休暇の生関数宣言を独立したHTTP consumerで検証し、明示名の版と結果・状態を比較。既定のtrace名は異なる。
- [追加APIの使い方と制限](docs/declarative-transitions.md)。公開alpha.5との区別を維持。

## 0.1.0-alpha.5

- Honoの休暇申請HTTPサンプルを追加。認証前提の再送、入力検証、業務エラー→HTTP、同時競合、保存後の応答不明、実サーバー再起動を15テストで検証。コアへのHTTP依存追加なし。

- `defineUseCaseGroup`：複数操作の共通保存・要求情報・再送方針を一度宣言。操作ごとの入力・失敗型とload→純粋な遷移の接続を維持。
- `operations`／`replayOperations`：同じ表示更新規則を持つ通常／再送の操作群を、キーの再列挙なしでApplicationへ登録。
- 経費の5操作と独立consumer内の休暇3操作で既存動作と比較。誤接続の配布型診断も検証。
- Applicationに`crashed`状態を追加。予期しない操作例外・成功値のreduce失敗を業務失敗と区別し、実行前の表示状態を保持。dismissは解除だけで自動再試行しない。低レベルcommandの例外伝播は維持。
- 講演との対応、達成条件、共通境界と利用者の責任範囲を文書化。

移行点と失敗時の契約は[alpha.5移行ガイド](docs/migration-alpha.5.md)を参照。

公開後、npmからalpha.5を新規インストールし、全14配布モジュール・外部型不要・実行依存ゼロを確認。
チュートリアルの通常／再送／詳細記録と誤定義4件、休暇HTTPの15テスト（実TCPとプロセス再起動を含む）を再検証。
HTTPとquickstartのサンプル依存も公開alpha.5へ切り替え。
再現：`npm run check:package:registry`、`npm run test:quickstart:registry`、`npm run test:leave:http:registry`。

## 0.1.0-alpha.4

- Web標準APIのみ・実行依存ゼロを配布契約として明記。Node型なしのビルド、全配布モジュールと型定義、実インストールの依存ツリーを検証。
- ランタイム中立のコアに合わせ、パッケージのNode専用engines指定を除去。開発・SQLiteサンプルのNode要件は別途記載。

- コアの`node:crypto`依存を除去。保存直前の決定の一致確認は、正規化文字列の同期比較を使う。
- この確認には暗号ハッシュが不要なため、Web Cryptoへの置換ではなく暗号APIへの依存自体を除去した。
- タグの永続化用ハッシュはアダプターへ分離し、既存の保存形式を維持。
- `npm run test:portable`でビルド済み公開入口をブラウザ向けにbundleし、NodeグローバルのないVMで実行を検証。
  Chromium 156とCloudflare Workersの公開環境でも同じ業務結果を確認。その他の環境は未確認。

公開後にnpmからalpha.4を新規インストールし、実行依存ゼロ・外部型不要・通常実行・再送・詳細記録を確認。
Workers検証サンプルもnpmのalpha.4へ切り替え、型チェック・bundle監査・公開URLの確認を実施。

## 0.1.0-alpha.3

- `withReplay(...).runDetailed(input)`：再送境界の記録と、実際に実行した業務コマンドの記録を区別。
- `defineUseCase({ operation, load, transition, save, replay? })`：取得・遷移・保存と任意の再送をまとめる追加の入口。
- 型診断：saveと遷移の不一致、requireの接続、再送時のExecution契約を表示。通常定義に無関係なoverload診断を除去。
- チュートリアル：通常実行・再送・詳細記録を、独立したnpm consumerで実行。

既存のTarget→on→withReplayは維持。複雑なインラインsaveには型注釈が必要な場合がある。
自動トランザクションや永続リトライは追加していない。保存と成功記録の原子性はアダプターが担う。

公開後、作業ツリー外でnpmからalpha.3を新規インストールし、通常実行・再送・詳細記録・4種類の誤定義の拒否を確認。
再現コマンド：`npm run test:quickstart:registry`。
