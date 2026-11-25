# 共通generic loadで操作ごとの要求型を保持する

開発版businessは、取得した文脈の`input`に要求を含むgeneric loadを、そのまま共有できる。
最初の業務関数が必要とする文脈を、そのloadが返せる場合に限り、操作の要求型を保持する。

```ts
const expense = business({
  name: 'expense',
  load: ports.load,
  save: ports.save,
  operations: {
    submit: [submit],
    approve: [approve],
    reject: [reject],
  },
});
```

例えばloadが`<I extends VersionInput>(input: I) => Promise<Result<Loaded<I>, StoreError>>`、
submitが`Loaded<SubmitInput>`、rejectが`Loaded<RejectInput>`を受け取る場合、
`expense.submit`はSubmitInputを、`expense.reject`はRejectInputを要求する。
approverIdやreasonをoptionalへ落とさず、各操作の成功・失敗型も維持する。
共通saveがgenericなら、[操作ごとの成功型](business-save-inference.md)も保持できる。
操作別の`{ load, run }`でも同じ検査を使う。

[経費の課題](../examples/onboarding/README.md)の保守者用参考実装では、
3か所のload特殊化と操作別loadの指定を、共通の`load: ports.load`へ置き換えた。
各Ruleは普通の純粋な関数で、その入力型を`Loaded<SubmitInput>`等として宣言する。
これは記述を減らす実装上の改善であり、独立利用者の習得時間や書き心地の測定ではない。

## 型検査の境界

既存のloadの結果が最初のRuleに渡せる場合は、元のloadと公開要求型をそのまま使う。
例えば文字列を受け取り、固定した`{ input: SubmitInput, actor }`を返すloadについて、
操作の要求型をSubmitInputへ勝手に変更しない。

そのままではつながらない場合だけ、最初のRuleの必須`input`フィールドを要求型の候補とする。
候補が元のloadの要求型を満たし、実際のloadがその候補から**必要な文脈全体**を返す
関数として代入可能な場合に限り、その要求型で接続する。
動的に選ぶloadのすべての候補についても、この条件を満たす必要がある。

広い結果しか返さないmonomorphicなload、actor等が欠けた結果、loadが保証しない
認可の型上の証拠、load自身のtenant等の要求条件を省く入力は、この推論で受け入れない。
後続Ruleとsaveの接続検査も維持する。宣言した関数の型が正しいことは利用者の契約であり、
any・型アサーション・未検証の外部データを安全にする機能ではない。

## 実行と制限

変更は型宣言であり、取得・検証・保存の実行順や値の受け渡しは変えない。
実行時にinputフィールドを解析したり、文脈を組み直したりしない。
private fieldを持つgenericな文脈クラスでも、元のインスタンスをRuleへ渡す検査を含める。
通常・詳細・選択値capture・再送で、要求型と既存の失敗伝播を検査する。
過去の成功を返す再送の成功型を、現在のRuleだけから狭めない。

任意のgeneric関数を型レベルで適用する仕組みではない。
ここで候補を調べる対象は通常の非同期関数と必須inputのある文脈で、
任意のプロパティ名、詳細形式のgeneric loader、深い変換やすべてのcallbackの無注釈化は保証しない。
`ports.load<RejectInput>`等の明示的な特殊化や、操作別のloadも引き続き使える。
generic requireと未注釈evolveの[別の推論制限](transition-inference-study.md)は解消していない。

[回帰検査](../src/business-generic-load.test.ts)は、入力・成功・失敗型の一致、拒否する宣言、
通常実行・保存停止・capture・再送・opaque文脈を確認し、実tarballのconsumerにも含める。
変更前`c346e74`のbusiness宣言では、この新しい正例の型検査が失敗することも分離したコピーで確認した。

[100/500操作の検査](business-scale.md)にも、共通のgeneric loadを使う別の生成群を追加した。
各操作の入出力と失敗型、別操作の入力の拒否、認可段階を省いた全操作の拒否、実行結果を検査する。
生成した独立操作での確認であり、実業務500種類・エディター応答・利用者の生産性の証明ではない。
