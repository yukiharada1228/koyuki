# Prismaのtransaction contextへ業務宣言を束縛する

Prisma 7.10.1＋`@prisma/adapter-better-sqlite3`による在庫移動の例。
倉庫2件の在庫を更新し、履歴1件とまとめて保存する。
現行サンプルの共通`inTransaction`は未公開のcore開発版で使う。PrismaやSQLiteの依存はサンプルに置き、コアへ追加しない。
公開npm `koyuki@0.1.0-alpha.5`の検査では、従来のサンプル専用transaction adapterをfixtureから差し替える。

講演[izV1h6o3hgQ 56:54–58:59](https://www.youtube.com/watch?v=izV1h6o3hgQ&t=3414s)の、
外側でtransactionを開始しcontextを渡す案を具体化する。
講演のこの案は当時未実施との留保がある。実証済みの方法として引用するのではなく、このサンプルで検証する。
PrismaのAPIは[v7の公式ドキュメント](https://www.prisma.io/docs/orm/v7/prisma-client/queries/transactions)に従う。
v8ではAPIが変わるため、依存バージョンを固定している。

## 実行

Node.js 22.13以降の22系、または24以降を使用する。検証環境は26.12.0。

```sh
cd examples/prisma-stock
npm ci
npm run generate
npm run check
npm test
```

現行サンプルは開発版tarballで検証する。公開npmの検査は従来のadapterでの互換性確認として分ける：

```sh
npm run test:prisma:package
npm run test:prisma:registry
```

CLIからPrisma Clientを生成し、migrationも実際のPrisma CLIでテストする。
.generatedは生成物としてGitに含めない。native SQLite driverのビルドはこのサンプルのインストールに属する。

## 業務と実行の定義

| 段階 | 内容・失敗 |
| --- | --- |
| load | txから倉庫2件と要求IDの重複を読む。NotFound / DuplicateRequest / StorageUnavailable |
| validate | 入力、version、不変条件、在庫不足、整数の範囲を検証。InvalidInput / Conflict / InsufficientStock / CorruptStock |
| evolve | 検証済み証拠から、総在庫を変えない新しい2件の状態と履歴を生成 |
| save | tx内で2件をversion付きCAS更新し、履歴を追加。Conflict / StorageUnavailable |

`domain.ts`の検証・遷移はPrismaをimportしない純粋な関数。
業務の想定内失敗をthrowせず、private brandで検証済みの型を遷移へ渡す。
brandは型だけの証拠であり、実データにSymbolプロパティを追加しない。
Koyukiの決定一致確認はplainな直列化可能データを対象とし、runtime Symbolを含む値は拒否する。

`application.ts`はload・validate・evolve・saveを宣言する。
公開alpha.5に合わせたStep形式で、開発版のdefineTransitionでの通常関数宣言とも同じエンジンを使用する。
ホスト側の実行は次の一つの境界へ渡す。

```ts
return inTransaction(createClient, tx => stockMovement(tx).run(input));
```

`stockMovement`内のすべての読み書きは、引数のtxを使う。
グローバルなPrisma Clientへ途中で戻さない。外側で開始したtransactionが、取得→計算→複数保存を囲む。
QueryはPrismaのselectで参照用のフィールドを直接取得でき、更新用domainの復元やworkflowを強制しない。

## Result.errとrollbackは別の仕組み

Prismaのcallbackが単に`err(...)`をreturnすると、Prismaには普通の戻り値なので、それ以前の書き込みがcommitされる。
この挙動を比較テストで確認している。

`transaction.ts`は失敗Resultを呼び出し固有の内部markerへ変換し、Prismaにrollbackさせる。
rollback後にmarkerを受け取った場合だけ元の失敗Resultへ戻す。
既知のPrisma/driverエラーはStorageUnavailable、想定外の例外はrollback後も例外として伝える。
業務関数や利用者のworkflowにこの変換を書く必要はない。

このadapterはPrisma Clientの生成から破棄までを所有する。
createClientはそのトランザクション専用の新しいClientを返し、他の要求で共有するClientを返さない。
このSQLiteデモでは専用接続のコストを受け入れ、他の要求の接続を閉じない契約とする。
共有poolを使うPostgreSQL等で同じライフサイクルを推奨・検証したという意味ではない。

## commit失敗で見つかった境界

このバージョンのPrisma＋better-sqlite3で、遅延外部キー制約によりCOMMITが失敗すると、
同じ共有Clientから未commitの変更が見える経路を検出した。
COMMITの失敗をResultへ変換しただけでは十分な後処理にならなかった。

専用Clientをfinallyでdisconnectすることで、この例では未commitの変更と接続を残さず、
次の正常な移動も実行できることを回帰テストにした。
DriverAdapterErrorの識別にはバージョン固定の`@prisma/driver-adapter-utils`をサンプル側で直接使用する。
内部utilityへの依存なので、Prisma更新時はこの回帰テストを再実行する。
第三者ライブラリのコードを修正したり、KoyukiコアからPrismaへ依存したりはしない。

一般にStorageUnavailableは「保存されなかった」という保証ではない。
接続切断でcommit結果が不明になる別の経路もあり、任意DBでのexactly-onceや自動再試行を保証しない。
この例の要求IDは重複を拒否する。既存の休暇・経費サンプルのようなreceiptによる成功値の再送ではない。
保存結果が不明ならMovementを照会して判断する方針をホストが決める。

## 検証

12テスト：

- 2在庫と履歴の正常保存、総量の不変条件、Client再接続後の永続性。
- 通常のErr returnがcommitされる比較と、adapterでのrollback。
- 2件目のCAS失敗で、1件目も戻ること。
- 履歴INSERT失敗で、2件とも戻ること。
- 在庫不足・古いversion・重複・存在しない倉庫・不正入力での停止。
- 想定外のcallback例外でのrollbackと例外伝播、次回実行の健全性。
- 終了したtxを保持してもグローバルClientへfallbackしないこと。
- 更新用workflowを通さないselectによるQuery。
- チェックインしたmigrationをPrisma CLIで適用できること。
- COMMIT時の遅延制約違反の変換・後処理と、その後の正常実行。

型検査では、検証前の値からの遷移と、txからのグローバル接続制御を拒否する。
複数DBの分散transactionや実際のネットワーク断、他DB/他driverでの同じ挙動までは検証していない。

## coreの共通境界への接続

ホスト側`transaction.ts`はcoreの`inTransaction`へPrismaの`$transaction`を渡す。
Result失敗をtransactionの中止へ変換する処理はcoreに置き、client作成・切断とPrisma例外の分類はhostに残す。
coreはPrismaをimportしない。rollback失敗で中止マーカーが置き換わった場合は業務エラーへ復元せず、driver障害として扱う。
公開alpha.5はこの新APIを含まないため、registry検査のadapterは`scripts/fixtures/prisma-registry-transaction.ts`を使用する。
