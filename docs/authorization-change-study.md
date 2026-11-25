# 認可エラー追加をtransportまで接続する比較

講演の「業務の検証・遷移に集中し、接続は任せる」を、
既存の休暇承認に対する新しい認可失敗で確認する。
開発版の実tarballを独立consumerへinstallし、[承認上限の変更](business-change-study.md)を適用した後に、
[認可の変更script](../scripts/studies/leave-authorization-change.mjs)を適用する。
元のexamples/leave-httpやframework本体を変更するものではない。

## 評価用の新規則

hostから受け取るActorに任意のapprovalEnabledを追加する。
activeなmanagerでもfalseなら、新しい承認をApprovalDisabledで拒否する。
省略とtrueは従来どおり扱う。従来のrole・active・自己承認禁止の検査は維持する。
要求へ同名のフィールドや別のactorを加えても、認証済みのActorは置き換えない。

新しい要求を拒否することと、同一人物が過去に成功した要求を読むことは別の方針とする。
この実験では、capabilityを無効にした後も、同じ要求IDの成功済みreceiptは再取得できる。
その場合はRule・保存を実行せず、過去の結果だけを返す。
一度拒否された要求にはreceiptがないため、明示的に権限を戻して再実行すると初めて成功する。

これはhostが操作構築時に渡した認証情報のsnapshotを使う仕様である。
ライブな権限directory、request開始後の失効、他ノードの認証状態を自動再確認する機能ではない。
履歴の読取りも失効させる要件なら、認証やreceipt照会の境界でも検査する必要があり、
実行されないRuleに拒否処理を置くだけではその要件を満たさない。

## 型検査で分かったこと

ActorとRuleError、既存validateApprovalだけを変更した段階で型検査を行う。
この変更は新しい中間成功型を要求しないため、4方式の既存の承認接続はそのまま通る。
一方、HTTP側の`Record<Failure['kind'], number>`によるstatus表と、GraphQL側の失敗コード表は、
ApprovalDisabledの未対応をコンパイルエラーとして検出する。
この段階の診断がhttp.ts・graphql.tsの両方にあり、その2ファイルだけであることを検査する。
403とenum値の対応を追加してから全体を再検査する。

businessのcallable・詳細reportと、既存宣言のrunが、新しい失敗型を保持することも厳密一致で検査する。
HTTPのFailure型を手動で更新したから通っただけ、という証拠にはしない。

初回の検証commit 037f225ではGraphQLのcodeはStringで、対応漏れは検出できなかった。
後続で[LeaveFailureCode enum](../examples/leave-http/GRAPHQL.md)を導入し、現在の検査ではGraphQLの表も更新が必要になる。
introspectionでApprovalDisabledがenum値として公開されることも確認する。
ただしclient生成・再生成とexhaustiveな分岐は引き続き外部の責務であり、古いclientの対応を自動保証しない。

## 変更と同条件の範囲

| 対象 | 今回の変更 |
| --- | --- |
| domain.ts | Actorの追加属性、失敗Union、新しい拒否条件 |
| http.ts | 新しいエラーの403対応 |
| businessの操作接続 | 変更なし |
| 既存transitionの操作接続 | 変更なし |
| 通常TS・共通helperの純粋な承認接続 | 変更なし |
| graphql.ts | 失敗コード表へ新enum値を登録 |
| repository・server | 変更なし |
| core・Applicationのview | 変更なし |

実行した一時consumer内のbefore/after hashと実diffを出力する。
[購買2変更の固定Git差分](procurement-change-measurement.md)とは別の計測で、あの表へ件数を加算しない。
通常TS/helperとの比較は純粋な判断の一致までで、同等のHTTP・GraphQL・receipt runtimeを作った比較ではない。

## 実行検査

```sh
npm run test:business:change
```

既存の配布検査と上限変更の後に、[5テスト](../scripts/fixtures/leave-authorization-change.test.ts)を実行する。

- 通常TS・helper・transition・businessの4方式で、false・true・省略・従来の権限違反を比較。
- businessと既存宣言で新しい失敗が伝播し、上限検証・更新・保存へ進まず、accountとreceipt数が変わらない。
- HTTPは新規要求を403で拒否。権限を戻した明示再実行だけがcommitし、後の権限停止中の同一要求はreplayする。
- GraphQLはHTTP 200の失敗branchへ新enum codeを返し、schemaへ公開する。許可されたqueryも維持する。
- Applicationはモデルを保持してfailedとなり、既存viewが新しいkindを表示する。

入力からのactor/権限の注入、保存回数、未実行段階のtrace、receiptが増えないことも確認する。
外部HTTP通信ではなくHono.requestとGraphQL実行器による統合検査で、liveな認証providerは使わない。
この1変更で型が業務仕様を証明するわけではなく、検証関数が正しく条件を判定する責任は利用者に残る。
生産性・学習負担・他の認可方式・失効の一般的な安全性の実証ではない。
