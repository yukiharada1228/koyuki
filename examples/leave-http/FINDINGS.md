# HTTPアプリで確認した開発体験

Koyuki本体の変更は0件。新APIだけを使って、既存の休暇申請をHTTPへ接続できた。
HonoやHTTP状態コードはdomain/applicationへ持ち込んでいない。

## 書かなくて済んだ接続

- load成功後のvalidate→require→evolve→saveのResult受け渡しと後続停止。
- 操作ごとの保存closure、要求・操作名とreceipt照会の束縛、再送wrapper。
- 取得前と明示した失敗後の再送照会、保存成功と元の失敗の記録の組み立て。
- 成功済み要求の再送時にもう一度保存しない分岐。

## 残った記述と判断

| 記述 | 置き場所 | 判断 |
| --- | --- | --- |
| 操作とURL、JSON入力の対応 | http.tsのregister呼び出し | HTTP契約。業務の入力型を保つため明示する |
| 認証と台帳へのアクセス許可 | HTTP middlewareと注入したauthenticate | 再送がdomain検証を省略するため、照会前の認可が必要 |
| 業務エラーからHTTPへの対応 | 一つのstatuses表 | 網羅的な型検査が効く。domainには入れない |
| 3操作共通のJSON・要求ID・出力変換 | HTTP内のregister helper | Honoアダプター内で再利用。コアへHTTP機能を追加する必要はなかった |
| 担当上長や休暇制度の詳細 | 未実装の業務要件 | frameworkの自動化対象にはしない |
| 同じkeyで過去の成功が返ること | APIのExecutionとGET | クライアントが最新表示へ無条件に流用しない契約が必要 |
| traceの配送・保存 | onReportを受けるホスト | 任意のobserverであり永続監査ではない |

HTTP要求は独立しているためdefineApplicationは共有していない。
runDetailedの結果をHTTPに変換するだけで、別の実行エンジンや永続セッションは不要だった。

## 検証で重要だった経路

- 認証失効／他人の台帳は既存receiptがあっても照会前に拒否。
- 同じversionを読んだ2接続で別申請を送っても片方が409となり残日数を超えない。
- 同じ要求の競争はcommittedとreplayedになり、台帳versionは一度だけ進む。
- 保存済みだが型付きエラーを返した場合は、元の失敗traceを保持したまま成功を再照会できる。
- 保存後にthrowした場合も、次の同一要求はreceiptで回復する。
- 本物のserver.tsを終了・再起動しても保存状態とreceiptが残る。
- 観察用callbackの拒否は保存済みの応答を500へ変えない。

## 次の判断

この例からは、コアに新しいHTTP用DSLを増やす根拠は得られなかった。
同じHTTP helperが別業務でも必要になるかを確認するまでは、アプリ側の小さな関数として保つ。
新APIの公開候補として、既存consumerとこのHTTP consumerをリリース前の検証に使える。

## GraphQLへの接続

GraphQL.js 17.1.0のresolverから同じ3コマンドを実行し、コアの変更なしで接続できた。
追加の責務はSDL、入力envelope、認証済みactorの束縛、アクセスscope、結果unionへの変換。
Queryはmutationのload/receipt/saveを通さず、readから投影する。
SDLと手書きのresolver引数型の一致は、TypeScript単独では証明されないため実際の文の実行で検証する。

配布開発版のconsumer30テスト、公開npm alpha.5のconsumer27テストが成功。
GraphQL固有12件に加え、RESTのプロセス再起動テストを跨transportのreceipt共有へ拡張。
複数mutationの直列実行と、文全体の原子性は別であることも確認した。
この接続のための新しいコアDSLやGraphQL依存は必要なかった。
