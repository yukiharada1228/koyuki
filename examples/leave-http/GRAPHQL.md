# GraphQLから同じ業務宣言を使う

既存のRESTサンプルと同じHonoサーバーへ`POST /graphql`を追加している。
GraphQL.js 17.1.0の[実行API](https://www.graphql-js.org/api-v17/graphql/)を利用し、
スキーマの検証と実行をGraphQL.jsへ、業務の接続と実行をKoyukiへ委譲する。
GraphQLパッケージはこのサンプルだけの実行依存で、Koyukiコアへ追加していない。

Nodeの対応範囲はGraphQL.jsのenginesに合わせ、22.13以降の22系、24系、26以降。
起動方法と資格情報は[RESTサンプル](README.md)と同じ。

```sh
curl http://127.0.0.1:4321/graphql \
  -H 'Authorization: Bearer owner-demo-token' \
  -H 'Content-Type: application/json' \
  -d '{"query":"mutation { submit(requestId: \"submit-1\", input: { employee: \"owner\", leaveId: \"leave-1\", expectedVersion: 1, days: 3 }) { ... on LeaveSuccess { kind account { version balance { available } } } ... on LeaveFailure { code } } }"}'
```

参照はクライアントが必要なフィールドを選ぶ。

```graphql
query Current($employee: ID!) {
  account(employee: $employee) {
    employee
    version
    balance { available reserved used }
    leaves { id kind days by }
  }
}
```

`approve`と`withdraw`は`days`を持たないChangeInputを使う。
actor・roleはGraphQL引数に存在せず、認証済みの要求ごとに操作群へ束縛する。
requestIdと入力は同じ業務要求の再送で維持する。
RESTのIdempotency-KeyとGraphQLのrequestIdは、同じRepositoryの同じreceiptへ対応する。
同一内容ならtransportを変えても再送として扱う。

## 接続と責務

- [graphql.ts](graphql.ts)：スキーマ、認証、scope、入力envelopeと出力の投影。
- application.ts / domain.ts / repository.ts：RESTと共有。GraphQL用の業務関数や別の実行エンジンは作らない。
- Queryはreadだけを使い、mutation用load・receipt・saveを実行しない。
  この小さな例ではreadが台帳全体を復元する。大きな参照モデル向けのSQL最適化・DataLoaderは未実装。
- 想定内の業務失敗はLeaveFailure、成功はLeaveSuccessというGraphQL unionで返す。
- Queryのscope違反や予期しないresolver例外はGraphQL errorsへ返す。内部例外の詳細は返さない。
- 過去の成功の再送は`kind: replayed`。現在状態の表示はQueryで再取得する。

## トランザクションの意味

一つのGraphQL文で複数のトップレベルmutationを指定しても、一括rollbackを保証しない。
先の申請が保存されたあとに次の申請が残日数不足で失敗すれば、先の申請は保存されたままになる。
これはテストで固定している。

一つの業務操作内のモデル・履歴・receiptの原子保存は、従来通りSQLite adapterが担う。
複数集約を一括で変更する業務なら、その業務を一つのcommandとして定義し、
必要なDB transaction/contextをそのadapterへ渡す設計が必要。
Prisma interactive transactionとの実統合を今回検証したという意味ではない。

## HTTP契約と検証

JSONのquery・variables・operationNameを受け付ける。variablesとoperationNameは省略またはnullも許容する。
POSTのみ、body上限4096bytes。認証エラーは401、非アクティブは403、envelope不正は400、
サイズ超過は413、JSON以外は415。
受け付けたGraphQL文の検証・実行結果は、GraphQL errorsを含む場合もHTTP 200で返す。
すべてno-store。GraphQL-over-HTTPの全適合性や、本番向けのコスト制限・paginationを主張するサンプルではない。

```sh
npm --prefix examples/leave-http run check
npm --prefix examples/leave-http run test:graphql
npm run test:transition:package
npm run test:leave:http:registry
```

GraphQL固有12テストを追加。3操作、選択フィールド、Query/Mutation分離、mutationの順序と部分成功、
過去receiptと現在Query、入力の偽装と型不正、認証・scope、権限、保存後の例外と再送、
envelope、実TCP、operationName、例外情報の保護を確認する。
RESTの既存プロセス再起動テストも、再起動後にGraphQLから同じreceiptを取得する検証へ拡張した。

公開npm alpha.5によるconsumerと、通常関数宣言へ差し替えた開発版consumerの両方で実行する。
スキーマからresolverのTypeScript型を生成する仕組みはこの例では使っていないため、
手書きの引数型とSDLの対応は実行テストで検証している。
