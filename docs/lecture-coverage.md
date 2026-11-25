# 3講演とKoyukiの対応・未確認事項

「講演の全内容を完全実現」と、個々の機能が実装・検証されていることを区別する。
以下は保存済みの日本語自動字幕・参照メモ・抽出静止画に基づく論点単位の照合。
音声付き全編の直接視聴、すべての画面・コードとの照合、登壇者による確認は完了していない。
自動字幕の誤認識を含む可能性があり、逐語録や全内容の検証完了とは称さない。

講演は単一のフレームワーク仕様ではない。実践済みの方法、設計上の判断、未実施の案、
経験談やチーム運営を含む。コードにできる内容を以下に対応付け、結果を保証できない内容は分ける。
時刻・範囲は話題へ戻る導線。引用ではなく要約。

[字幕に沿った詳細照合](lecture-audits/README.md)を記録した。
1本目2258行を39区間、2本目812行を21区間、3本目964行を24区間へ割り当て、原文ファイルのhashと実装根拠を記録した。
これは字幕行の対応漏れを点検する記録であり、発話・画面・実装の完全性を自動的に証明するものではない。

## TypeScriptによるGraphQLバックエンド開発

出典：[izV1h6o3hgQ](https://www.youtube.com/watch?v=izV1h6o3hgQ)

| 範囲 | 論点 | Koyukiの対応・限界 |
| --- | --- | --- |
| 02:04–05:04 | フロントとバックのメンタルモデルの差 | Applicationのdispatch・状態・viewを分離。開発者の認知負担がどれだけ減るかは未測定 |
| 05:22–10:36 | CQRS、薄い参照と不変条件を守る更新 | HTTPサンプルのGETと業務commandを分離。Queryに更新用workflowを強制しない。同じ宣言をGraphQL.js経由で実行し、Query/Mutation分離・再送・実TCPを検証 |
| 11:33–16:04 | Elm/Reduxの状態と実行の分離 | defineProgram / defineApplicationと購読。インプロセスの実行loop |
| 18:21–23:19 | イベントからモデルを発見、IO→状態遷移→IO | domain型・load/transition/save。何を集約やイベントにするかはモデリングの判断 |
| 26:56–32:15 | 検証前後・作成後の型、不正な状態を減らす | タグ・経費・休暇・登録のUnionとprivate brand。配布型の誤接続検査 |
| 32:37–38:58 | Resultを計算の合成に使う | workflow / transition / process。最初の失敗で後続停止 |
| 40:31–42:21 | 振る舞いをドメイン近くへ、workflowは合成 | 各domain.tsとapplication.tsを分離。業務関数をフレームワークへ移さない |
| 42:37–46:53 | 更新対象と入力をcommandへまとめる | Loaded、検証済みcommand、既存Entityと要求を一緒に渡す |
| 46:56–50:40 | 途中IOの関数注入・workflow分割 | shippingと登録メールのprocess.effect。直接runで不要な空の遷移を除去。注入したIOを純粋関数とは呼ばない |
| 50:54–52:19 | Result接続の定型処理をframeworkへ | defineTransition / defineUseCaseGroup / operations、実行状態と完了イベントの自動処理 |
| 54:10–54:50 | andThen/mapや入れ子の負担 | 宣言による順次接続、withInput、collect。TypeScriptのdo記法や全generic推論を提供するわけではない |
| 56:54–58:59 | DB transaction、contextを渡す案 | SQLiteのCAS・履歴・receipt・outboxの原子保存をテスト。Prisma 7.10.1のcontextで複数更新・typed rollback・commit失敗の後処理を検証。提案は講演当時未実施。任意DBへの一括保証なし |
| 59:07–61:00 | 関数型の全面導入より宣言に必要な範囲 | 通常の関数・Result。IO adapterは通常のTypeScript、実行時依存ゼロ |
| 61:08–64:36 | 言語・Prisma・REST/GraphQLの選択理由 | transport非依存。HonoとGraphQL.jsとの統合を検証。全言語・全ORMを再実装する要件にはしない |
| 64:39–66:24 | 登録・メール・人の確認から別workflowへ | 登録サンプルの永続outboxと確認command。別OSプロセス・配送失敗・ack失敗・lease競合を検証。講演では未経験の構想 |
| 66分台–70:13 | 失敗を含む計算の合成、例外との違い | 明示的Result伝播。予期しない例外はApplicationのcrashedと区別 |
| 70:21–72:46 | Event Storming、ドメイン知識・チームとの発見 | 状態表と具体例を提供。ドメイン専門家の判断やワークショップをライブラリで代替しない |
| 72:52–74:38 | 複数エラーの収集、Resultのテストの手間 | collect / collectEachの全エラー収集、通常関数の単体テスト。専用のResultテストDSLは未提供 |
| 74:40–77:50 | チームへの導入・パラダイムの差・将来像 | 開発ガイドと実例。万人への学習負担や将来普及は実装で保証できない |
| 77:57–79:38 | 共有する型・共有しないドメイン、境界 | 公開コアと業務サンプルを分離。認証・DB・ドメインを利用者へ残す。全スタックの型生成は未提供 |

## TypeScript 関数型バックエンド開発のリアル

出典：[qBf910_YiqA](https://www.youtube.com/watch?v=qBf910_YiqA)

| 範囲 | 論点 | Koyukiの対応・限界 |
| --- | --- | --- |
| 02:16–05:11 | 書籍をそのまま採用せず従来の設計と組み合わせる | Repository・集約と通常TypeScriptを維持。workflowへの全ロジック集中を要求しない |
| 05:13–07:38 | 不変な状態遷移・Resultによる成功と失敗の一本化 | 純粋なRuleと既存エンジン。元のモデルを直接更新しない例とテスト |
| 08:12–09:47 | Union、brand、検証付き生成 | private brand、hydrate/restore、状態別フィールド。外部データは実行時に検証 |
| 10:28–12:45 | 関数の引数・戻り値に変更前後の状態を出す | transitionの段階間の型検査。brandの偽造をTSのassertionまで防ぐことはできない |
| 13:00–17:53 | 小さなサブステップの合成 | validate / require / evolve、独立した通常の業務関数 |
| 18:28–22:54 | IOは通常実装、QueryとMutationを分ける | adapterと純粋coreを分離。Hono/SQLiteは配布コアの外 |
| 23:40–25:58 | 型・静的検査が目的、FP自体が目的ではない | Unionや通常関数で利用できる。全層のFP化・クラス禁止なし |
| 26:02–29:31 | Resultパズル、合成・ループとdo記法の差 | 宣言・collect・withInputとcollectEach。可変長の同期独立検証を位置付きで集約する。依存する要素間の処理・非同期列・言語構文の拡張を包括的に扱うわけではない |
| 29:36–30:08 | 既存Promise・throwの処理を境界で変換 | fromPromise / fromThrowable。mapperとエラー分類はadapterが明示 |
| 30:12–31:40 | 2年の経験、型で減るテストと仕様テスト | 静的拒否と業務・DB・障害時テストを分離。Koyukiで同じ実運用年数・不具合削減率を証明したわけではない |
| 31:43–33:31 | オンボーディング・DTO・型の冗長さ・適用範囲 | 通常関数、任意require、plain data。公開項目の投影・秘密情報の除外は残る。推論制限を文書化し、教育・適用範囲の判断は利用現場に残す |

## 関数型プログラミングと型システムのメンタルモデル

出典：[w0oLNoGsGLc](https://www.youtube.com/watch?v=w0oLNoGsGLc)

| 範囲 | 論点 | Koyukiの対応・限界 |
| --- | --- | --- |
| 00:51–05:15 | 関数は写像、型は値の集合 | Rule<I,O,E>、段階間の入出力型を検査 |
| 05:19–05:53 | FPの無条件な優越ではない | 通常のIO・単純なQueryを許容。単純CRUDへの導入を強制しない |
| 06:00–09:30 | React/Elm、明示した状態遷移と実行委譲 | Application / Program、viewの導出、購読。UI rendererそのものではない |
| 10:08–19:29 | 文と式、命令と計算、関数適用・合成 | pure workflowとeffect/processの境界。TypeScriptの構文を置換しない |
| 19:50–23:46 | 前後の状態を値として返す、観測可能性 | immutable domain、段階名と成否のtrace、Application snapshot。全段階の入力・出力dumpと永続的な全状態履歴は未提供。任意の破壊的変更を静的に禁止もできない |
| 23:55–28:36 | IOと複雑な業務計算を分離する目的 | domainの独立テスト、load/save、途中effectと原子保存adapter |
| 29:21–35:15 | 型による制約、compiler/toolの支援 | 配布d.tsの型検査と不正入力の実行時検証。仕様の正しさの形式証明はしない |
| 35:18–40:55 | Result、直和と直積、不正な状態を表せなくする | domain states、private proof、Application状態Union。Resultの型注釈だけで予期しないthrowを排除できず、利用者の型設計の品質も自動保証しない |
| 38:40–39:48 | 似た構造をまとめるUnionと継承の使い方 | 業務状態をUnionで表す。継承やクラス全般の禁止とは解釈しない |
| 29分台・40分台 | 時間のため省略されたスライド | 動画で説明されなかった内容まで「全実装済み」と推測しない |

## 今回追加したもの

- [例外・Promise境界](result-boundaries.md)：既存SDKを型付きResultへ接続。
- [永続イベント接続](registration-events.md)：登録・メール・確認の実例。原子保存、別OSプロセス、競合・再配送を検証。
- いずれも未公開の開発版。新しい永続workflowエンジンをコアへ追加したものではない。

## 未完了の受け入れ条件

1. 音声・画面を含む3本すべてとの全件照合。現時点は上記の資料ベースの対応表。
2. 独立した利用者による開発体験・学習負担の評価と、実業務での運用実績。
3. 永続イベントを一般機能にする場合の方針決定。ホストのscheduler、dead letter、lease更新、
   外部配送先の冪等性までをどこが担うか、現在は登録サンプルで境界を示した段階。
4. 他DB・他driverでのtransactionの検証。Prisma 7.10.1＋SQLiteでのcontext・typed rollback・commit失敗と、GraphQL.js / Honoでの統合は検証済み。

したがって、現時点で「講演全内容を完全実現した」「最高と証明した」とは評価しない。
コードとして確かめられる論点の対応を広げたことと、残る未確認事項を同時にレビューできる状態とする。

## GraphQL実統合の追加検証

[同じ業務宣言をGraphQLから利用する例](../examples/leave-http/GRAPHQL.md)を追加。
独立consumerと公開npm alpha.5の両方で、認証・型付き業務失敗・再送・クエリ投影を検証する。
GraphQLの複数mutationは文全体の原子性を意味しないことをテストし、DB transactionと区別した。
RESTで保存したreceiptをサーバー再起動後のGraphQLで再利用する経路も確認する。
コアAPI・依存・既存業務モデルは変更しない。スキーマからの型生成と実運用評価は引き続き未検証。Prismaの追加検証は次節に記載。

## Prismaのtransaction contextの追加検証

[在庫2件と履歴の原子保存](../examples/prisma-stock/README.md)をPrisma 7.10.1で実装。
外側のadapterがtransactionを開始し、読み書きを同じtxへ束縛する。
通常のcallbackではErr returnでもcommitされることと、それをadapterでrollbackへ接続することを比較した。
2件目のCAS失敗・履歴失敗・commit時の遅延制約・終了したcontext・実CLIのmigrationも検証する。

commit失敗後に専用Clientを破棄する境界が必要な経路を検出し、接続所有権をサンプルの契約に含めた。
コアにPrisma依存や新しいtransactionエンジンは追加しない。SQLite以外への一括保証は行わない。

## 通常関数による業務操作宣言の試作

[利用者向けAPIの検討](business-api-study.md)では、validate/require/evolveの分類を強制せず、
通常の同期Result関数の配列から既存の実行境界へ接続する形を検証する。
型の異なる64関数のinline接続、接続途中の誤り、権限確認の省略、入力・成功・失敗型の保持を確認した。
これは講演の「Resultによる接続の定型記述を任せる」という課題に対する実装案であり、
講演がこのAPIを指定したという意味ではない。試作は未公開。
単一関数の余分なtrace段階は解消し、既存操作IDを維持するresolverと経費SQLiteの双方向replay移行を検証した。
trace名そのものの変更や、独立した利用者による開発体験の評価は引き続き残る。

休暇3操作も同じ試作で記述し、一時的なprivate候補パッケージを独立consumerへインストールして検証した。
既存HTTP/GraphQL・旧宣言比較・Application・SQLite移行の31テストと配布型の拒否検査が成功。
これにより接続の定型記述を減らす案が2ドメインで既存実行契約を保つことを確認した。
通常のnpm公開APIには含めず、独立した利用者による評価や講演全体との音声・画面の照合を代替しない。

[承認ルール追加の実験](business-change-study.md)で、普通の関数型と証拠型による接続漏れの検出を4方式で比較した。
TS単体でも検出できること、新しい失敗のtransport対応と過去の成功receiptの扱いは別の契約であることを確認した。
これは講演の型・純粋計算・実行接続の考えを検証する一例であり、一般的な生産性優位の証明ではない。

## I/O列の終端に空の遷移を要求しない

登録メールの完了記録で必要だった空のvalidate/evolveを除去し、既存processを直接run / runDetailedできるようにした。
claim→send→ackという実際の3段階だけを記録する。状態遷移と保存があるshippingのcommit経路は維持する。
rootの全385テスト、独立consumerの登録8テスト、15モジュールの依存ゼロ・Node型なし検査、
Nodeのglobalを与えないbundleでの直接実行を確認した。
これは途中I/Oの接続を簡単にする改善であり、永続scheduler・分散transaction・外部副作用の自動rollbackを実装したものではない。
