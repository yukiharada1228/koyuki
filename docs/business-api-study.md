# 普通の関数で業務操作を書くためのAPI試作

利用者から見える既定の単位を「役割ごとの段階」から「業務操作」へ寄せる試作。
公開APIではない。npmにも配布入口にも含めず、既存APIを置き換えていない。
[実装](../src/experiments/business.ts)と[実行・型テスト](../src/business-api-study.test.ts)・[接続型の回帰試験](../src/business-api-types.test.ts)で書き心地を検証する。
新しい実行エンジンは作らず、既存のWorkflow・Command・再送・Applicationを使う。
defineUseCaseGroupとの要求context・再送の接続部分を内部モジュールへ共通化している。

## 試した形

```ts
const expense = business({
  name: 'expense.v1',
  load: (input: Input) => repository.load(input, authenticatedActor),
  save: (change: Change) => repository.save(change),
  operations: {
    submit: [validateSubmission, route, submitRouted],
    approve: [validateApproval, approve],
    reject: {
      load: (input: RejectInput) => repository.loadReject(input, authenticatedActor),
      run: [validateRejection, reject],
    },
  },
});

await expense.approve({ id: 'one', expectedVersion: 2 });
const report = await expense.approve.runDetailed({ id: 'one', expectedVersion: 2 });
```

各段階は普通の同期関数で、Resultを返す。検証・権限・前提条件・状態更新の順序は配列に表す。
利用者にvalidateとrequireの分類やevolveという呼称を必須にしない。
Resultの成功値を次へ渡し、最初の失敗で後続と保存を止める。
一段階の操作も許容する。

定義時にIOを実行しない。返された関数を呼び出すと、その操作を実行する。
返した関数には既存commandと同じrun / runDetailedもあり、operations / replayOperationsへそのまま渡せる。
Applicationの状態・投影・viewを別に扱う既存の設計は変えない。

operationsを一段内側に置いたのは、業務名とload / save / name等の設定キーとの衝突を避けるため。
返すオブジェクトのthenはJavaScriptのPromiseにthenableと解釈されるため、試作では禁止する。
この名前・階層が最終的な公開仕様と決まったわけではない。

## 共通loadで推論できる範囲

全操作に同じ入出力のloadが使える場合は配列だけで宣言できる。
却下理由や編集内容のように入力が異なる操作には、その操作のloadを明示する。
これによりrejectのreasonやeditのamount / receiptを必須のまま保持する。

共通のgeneric loadから、操作ごとの具体的な入力・出力の対応を自動で復元するとは主張しない。
型をunknownやanyへ広げて単純な形に見せることは避ける。
複数操作を全部同じ入力Unionへまとめ、必要なフィールドをoptionalへ落とす解決も採らない。

業務関数がvoidを返す検査なら、そのvoidを次へ渡すので型が合わなければ拒否する。
元の値を暗黙に引き回さない。必要な証拠や元の値は関数の戻り値へ表す。
経費のrouteはwithInput(routeSubmission)を変数へ置き、元の申請と経路の結果を次へ渡す。
型による業務モデリング・想定内の失敗のResult・純粋な遷移という核は維持する。

## 再送と実行記録

replayを使う場合は既存の共通保存・receipt lookup・失敗後の再照会方針を設定する。
saveは原子的に保存したExecutionを返し、lookupは要求内容と操作IDの一致を確認する。
要求IDの意味、認証・認可、DB transaction、外部副作用の重複排除はadapterの責務。
呼び出し形が短くなっても、これらを自動的に推測できるわけではない。

詳細traceの既定名はrun:1、run:2など配列内の位置。
関数名やFunction.nameから永続的な業務IDを推測しない。
traceは既存と同じ実行reportであり、永続監査ログではない。

## 確認したこと

初期の7件の実行テスト・12件の型拒否に加え、単一関数の失敗境界・安定ID・SQLite移行と型推論の回帰試験を追加した。

- 経費の申請・承認・却下・差し戻し・編集を同じ試作APIで実行。
- 3段階の途中失敗で、残りの関数と保存を実行しない。
- load、通常の関数配列、saveの入出力と失敗型を保持。
- 却下理由・編集内容・versionの欠落を拒否。
- 隣接段階の誤接続、先頭の型違い、saveとの型違い、async関数、空配列、型情報の失われた配列、個別loadの型違いを拒否。
- 原子保存のExecutionを返さないreplay設定と、thenという操作名を拒否。
- 直接呼び出し・runDetailed・Application・replayOperationsとの接続。
- 同一要求の再送で追加保存なし。内容や操作を変えた同じIDはIdempotencyConflict。
- replay設定時の入力snapshotと操作ID・要求contextを既存境界へ渡す。
- 定義後の配列の変更が宣言済み処理へ混入しない。利用者の配列や関数をfreezeしない。

```sh
npm run check
npm exec -- tsx --test src/business-api-study.test.ts src/business-api-migration.test.ts
npm test
npm run check:package
```

型拒否はこのリポジトリのTypeScript 7.0.2での確認。新APIの配布型として独立consumerで検証したものではない。
共通の実行接続を担う内部モジュールを追加したため、開発版は15モジュールになる。
試作API・経費の試作宣言は配布入口とdistに含めず、公開APIは増やしていない。

## 公開前に残る設計判断

1. generic関数を多段にinlineで書く場合の推論と、誤定義時の診断は改善の余地がある。
   特に空配列・async関数のエラーは、該当関数ではなくoperations全体へ出る場合がある。
2. 操作ごとに成功値・保存先が違う集約を、ひとつのsaveへ無理に押し込まない。
   ひとつのbusinessの責務と、複数businessの接続を実例で確認する。
3. 既存APIを置換する推奨入口なのか、補助記法なのかを決める。
   同じ目的の公開APIを増やし続けない。購買アプリを作る前に、現在の経費・休暇で比較する。

試作の成功は、根本的なAPI改善を検討できる証拠。
大規模チームでの開発体験・使いやすさ・品質の優位を証明したという評価はしない。

## 型の接続保証の追加検証

`src/business-api-types.test.ts`で、検証と権限確認に別々の非公開unique symbolの証拠を使い、
検証→権限確認→承認の正常な接続、権限確認の省略・順序逆転の拒否を確認する。
入力型・保存後の成功型・load/全ルール/saveのエラーunionが期待型と一致することも確認する。
これは関数の型契約の検証であり、権限判定の実装内容の正しさを証明しない。
同一の構造しか持たない型では、省略を検知できない。anyや型アサーションでの迂回も防げない。

機械的な型負荷として、状態0→1→…→64という異なる型を持つ64関数を接続し、
57番目の接続だけを壊した定義が拒否されることを確認した。
当初はTS2589（型展開が深すぎる）が発生し、末尾再帰の蓄積方式で改善したが、inline配列の推論は崩れていた。
現在は、出力のtupleを1位置ずらして各入力を検査するmapped typeへ変更し、検査側からの逆推論をNoInferで止めている。
共通loadでも操作別loadでも、宣言内の64関数を`as const`・型引数・別変数なしで記述できる。
57番目の誤接続は、operations全体ではなく、その関数の位置で診断される。
入力型と保存後の成功・失敗型の厳密な一致も回帰試験へ含める。
64段は型検査の回帰試験であり、推奨する業務分割の粒度でも、無制限長の保証でもない。
この追加検証も未公開の試作に対するもので、npm配布型の検証ではない。

## 実行記録と既存宣言からの移行

単一関数をWorkflowへ直接接続するため、以前追加していた`complete`という空の段階は不要になった。
load失敗・唯一の業務関数の失敗・save失敗・成功をそれぞれ検証し、実行した段階だけを記録する。
結果のtraceから後で段階を削除しているわけではない。

既存IDを保つ場合は、namespaceからの既定値に代えてresolverを指定する。

```ts
business({
  name: 'expense-api-study',
  operation: (name: ExpenseOperation) => `expense.${name}.v1`,
  // load, save, replay, operations ...
});
```

[経費5操作の試作宣言](../src/experiments/expense-business.ts)は、既存のドメイン関数・SQLite adapter・要求形式をそのまま使う。
旧APIが保存した申請を別OSプロセスの新APIでreplayし、新APIで保存した編集・却下も旧APIからreplayできた。
差し戻し→編集→再申請→承認と、別申請の却下を実行し、古いreplayによって最新のDB状態が巻き戻らないこと、
変更履歴・receiptの件数が増えないこと、同じ要求IDの内容・actor変更を拒否することも確認した。
経費adapterのfingerprintは操作の業務名を使うため、外部IDの一致だけでは移行の証明にならない。
要求形式・actor・fingerprintの意味を保つことも必要であり、これらはこの実例で維持している。
別のreceipt fixtureでは外部IDそのものの一致を照合し、namespace変更だけでは競合し、resolverで旧IDを保つとreplayできることを検証する。

既存のtrace名は役割名からrun:1等へ変わる。外部でtrace名を永続識別子に利用している場合の移行まで自動化したわけではない。
異なる操作が同じIDを返さないことや、操作の意味を変えた際のversion管理はadapter/利用者側の契約である。

この変更時の検証は、root型チェック・全380テスト、配布consumerでの休暇HTTP/GraphQL/Applicationの30テストと8件の不正宣言拒否、
15モジュールの依存ゼロ・Node型なしconsumer検査、およびNodeのglobalを与えないブラウザbundle実行。
配布consumerの検証対象は既存公開APIの内部共通化であり、未公開business APIを配布検証したという意味ではない。
