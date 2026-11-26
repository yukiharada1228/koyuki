# 全84話題の判定と現行実装への経路を点検する

[共通検証の後に現れる要求型](business-later-request.md)を共通loadへ反映し、AI試用の申請・却下で必要だったloadの型引数2箇所を省略できるようにした。読み込み自身の出力保証と全段階の接続を確認し、既存の有効な関数列の要求型は維持する。一般の多相変換・名前なしinline・原資料の未確認部分は残る。

[AIによる経費課題の試用](onboarding-ai-review.md)をユーザーの指定で実施した。共通generic検証から始める場合のload型指定2箇所と、複数段の正しい実装を拒否していた課題テストの不備を確認し、後者を修正した。人間の独立評価ではないが、今後の改善はこの具体的な観察も根拠に進め、人間の協力者を実装継続の必須条件にはしない。

[深いgeneric出力の構築時推論候補](deep-step-refusal.md)は、初期契約を通過してもオーバーロードの反例で誤った精密化を起こすため不採用とした。製品coreは変更せず、推論制限・9話題のpartial・独立利用者評価・原音確認の残件を維持する。

[入荷・在庫7操作のエラー型](procurement-logistics-errors.md)も広がらずに保持し、購買全25操作の固有のkind集合を通常・詳細・再送で3方式比較する。成功状態と検証証明は維持する。これは宣言したResultの集合の検査であり、全経路の到達可能性・任意の業務の正しさ・原音確認・独立利用者評価の完了ではない。

[申請・発注12操作のエラー型](procurement-commercial-errors.md)を、関数本体から推論して通常・詳細・再送まで保持した。成功状態・検証証明・失敗の優先順位を維持し、比較用の通常TypeScriptも同じ集合を保つ。この12操作の後に入荷・在庫7操作も対応し、財務6操作と合わせ25操作が対象となる。

[inline要件のcompiler境界](inline-inference-compiler-boundary.md)では、TS6の一時コピーで呼出し保留の分岐を切り分けた。製品のinline制限は未解消のまま、配布検査は正しい構文の不受理を必須にせず、厳密な型を保った改善も許容する。通常buildにcompiler改変は使わない。

[動的に選ぶ要件関数](with-input-alternatives.md)も、dispatch関数を挟まずwithInputへ渡せるようにした。全候補が受け取れる入力を要求し、成功値・エラーの和と既存generic関数の型保持を検査する。名前なしinline・遷移中の深いgeneric変換・独立利用者の評価・原音確認は残る。

実装基準ef1bb4d2f73819741872399ddf62004100b9419fの後続点検では、保存境界、購買の次状態型、
入荷の検証済み状態、通常関数列とWorkflowの推論範囲を区別し、iz-14/19/24・qbf-06/19・w0o-19の
現状説明を更新した。全84件のstatus・原資料hash・時刻区間は維持し、直接音声確認は行っていない。
原音確認用クリップの準備も確認完了の証拠にはしない。

[Receiptの次状態型](procurement-receipt-state-types.md)も、在庫計画と通常公開操作まで保持した。
既存Workflowで追加のcallback注釈を避ける限定例であり、一般の推論制限と判定数は維持する。

[購買6モデルの状態型の再点検](procurement-state-contract-review.md)で、注文の直和と
検証成功後・次状態の型を揃えた。Receipt側に残る型の拡大も区別して記録する。

さらに[請求書・支払の次状態型](procurement-finance-state-types.md)を精密化した。
直和の各variantが通常の公開操作まで届くことと、再送の広い型を別々に検査する。

後続点検として[保存値と再送の型](procurement-storage-values.md)を追加した。
保存adapter自身が型を保持する条件を検査し、履歴と今回の成功型を分離した。
下記の全84件の判定数は変更しない。独立利用者の試用は未実施である。

実装基準は36b2e65d101a8751ad36e99e38a20c6a7aae4a46。
3つの詳細対応表の全84件のassessmentと判定理由を読み直し、対応済みの根拠、残件、古い説明の混在を点検した。
保存字幕全行の再読、全ソース行の精読、直接音声・連続画面の再確認を行ったという記録ではない。
原資料の全体照合の来歴は[詳細対応表](lecture-audits/README.md)と各ASR/資料レビューへ残す。

| 判定 | 話題数 | 意味 |
| --- | ---: | --- |
| supported | 36 | 指定の論点へ対応する実装例と検査への経路がある |
| partial | 9 | 実装・利用者評価・原資料等の残る範囲を明示する |
| design-choice | 25 | 設計の判断や説明例。個別の内蔵APIの指定と区別する |
| experience | 8 | 登壇者の経験・評価。Koyukiの実績へ転記しない |
| context | 6 | 導入・挨拶等。実行機能へ変換しない |

これは達成率ではない。判定を変えて完成扱いにする作業でもない。
supportedも全入力・全実装・全講演の完全性を意味せず、対応表に記した条件内の判定である。
今回の点検でstatusは変更しない。

## supportedの論点と根拠への経路

36件を論点ごとにまとめる。同じ話題を重複計上しない。
この索引とファイルの存在だけで意味内容の正しさを自動証明するものではない。

| 話題ID | 論点 | 主な実装・検査 |
| --- | --- | --- |
| qbf-05/06/11、iz-09/12/13/14/18/19、w0o-12/18/21 | 状態・生成・変更前後の型、ドメインの整理 | [業務型](../src/business-api-types.test.ts)、[登録](../src/registration/domain.ts)、[登録の検査](../src/registration.test.ts)、[タグの作成前後](../src/tag-prepersistence.test.ts)、[経費の業務](../src/expenses/domain.ts) |
| qbf-04/07、iz-11/15/16/33、w0o-20 | Resultと関数列の接続、失敗停止 | [Workflow](../src/framework/workflow.ts)、[business](../src/framework/business.ts)、[購買作成](../src/procurement-request-creation.test.ts)、[編集](../src/procurement-request-edit.test.ts) |
| iz-07、w0o-06/07 | update・command・実行状態・view | [Program](../src/framework/program.ts)、[Application](../src/framework/application.ts)、[Programの検査](../src/program.test.ts)、[Applicationの検査](../src/application.test.ts) |
| qbf-09、iz-10/17/20/21、w0o-14 | I/Oと計算の分離、途中I/Oと注入 | [Process](../src/framework/process.ts)、[Processの検査](../src/process.test.ts)、[成功値の投影](../src/process-projection.test.ts)、[配送定義](../src/registration/delivery.ts) |
| qbf-08、iz-05/30 | 参照と更新、transportの分離 | [HTTP/GraphQL](../examples/leave-http/README.md)、[GraphQLの検査](../examples/leave-http/graphql.test.ts)、[Prismaの例](../examples/prisma-stock/README.md) |
| iz-27 | 保存境界と共有transaction context | [同期境界](../src/transaction.test.ts)、[非同期境界](../src/async-transaction.test.ts)、[Prismaの検査](../examples/prisma-stock/stock.test.ts) |
| qbf-14、iz-35 | 独立検証の全エラー集約、依存するfold、独立I/O | [同期collection](../src/collection-validation.test.ts)、[fold](../src/fold-each.test.ts)、[独立I/O](../src/collection-effects.test.ts) |
| qbf-15 | 明示したPromise/例外の変換境界 | [Result境界](../src/result-boundary.test.ts) |
| w0o-19 | 型検査・配布宣言・診断 | [配布物検査](../scripts/check-runtime-package.mjs)、[接続拒否fixture](../scripts/fixtures/leave-business-diagnostics.ts) |

参照・更新の分離は、参照の認可や業務計算を不要とする主張ではない。
I/Oの注入でDB型が引数から消えても、その処理を純粋関数と呼ぶわけではない。
集約APIは順次依存する失敗停止と独立検証の全収集を区別し、任意のループを自動変換しない。
transactionの原子性と外部副作用の巻戻し、結果不明のcommitは別の契約である。

## 見つかった不足と修正

### 登録の純粋な遷移が返す型

RegistrationとChange自体は直和だったが、startとconfirmの戻り値はどちらも全体のChangeだった。
実際の出力に合わせて、startはexpectedVersion:0・awaiting・EmailRequested、
confirmはexpectedVersion:1・confirmed・event:nullのvariantへ絞った。
実行本体の計算・保存・配送手順は変えていない。

厳密一致の型検査、独立した具体的な期待値、版・イベントを取り違える型の拒否を加えた。
[配布物検査](../scripts/test-registration-package.mjs)では、実行内容を変えずに戻り型だけを全体のChangeへ戻すと、
2つの厳密一致の型検査が失敗する対照も確認する。
monomorphicなrepository.saveが返すRegistrationは広い契約のまま保ち、根拠なく保存後の型を狭めない。

### タグの作成前モデルと復元の意味

iz-09/12の根拠へ、他業務の例だけでなくタグ自体のdomainと検査を追加した。
検証前と検証済みには完成したdataがなく、作成計画ではID・版・順序が必須になる。
hostはcandidate IDをsnapshotへ供給するため、採番の時刻やDB方式を一律に固定しない。
DBなしで通常の関数列を実行し、明示した期待値と元入力の非変更を確認する。

一方、restoreTag(created.data)も保存形式の検証に成功し、PersistedTagを返せる。
この型名は物理的なDB書込みや行の実在を証明するものではない。
保存・再取得の事実はrepositoryとその検査を根拠にし、復元constructorだけで代用しない。

### 現状と履歴の混在

iz-22/24、qbf-19、w0o-13には追加説明が蓄積し、110/117/252等の古い値が「現在」と記されていた。
現在のassessmentを要約し、購買の成功130境界・代表失敗274境界や、残る3つの文脈注釈との整合を取った。
古い基準のreview記録・資料のhash・時刻区間・Git履歴は維持する。
観測の話題w0o-13へ混在していた推論注釈の残件も、観測と型推論の範囲を分けて整理した。

## 残る判定

partialの9件は[残件の種類別の対応表](lecture-partial-reconciliation.md)を維持する。
独立利用者の試用、API安定性、推論の制限、実メールproviderと運用、永続履歴の方針、原音・省略画面の確認は別々の残件である。
25の設計判断、8の経験、6の文脈を、新しいAPIで埋める機能数へ置き換えない。
全体の[部分充足の判定](lecture-acceptance.md)は変わらず、全編音声視聴や全内容の完全実現を主張しない。
