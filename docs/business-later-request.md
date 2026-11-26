# 共通検証の後に現れる要求型を、共通loadへ反映する

[検証済みの証明を加える共通関数](business-verified-request.md)も、入力の文脈を保持する契約を確認して後段の要求型を推論する。経費課題の共通検証へ証明を追加し、型引数を省いた関数列でも検証の省略を型検査で拒否する。実行runtimeは変更せず、一般の多相変換等の残件は維持する。

[AIによる経費課題の試用](onboarding-ai-review.md)で必要だった、申請と却下の操作別loadの型引数を省略できるようにした。業務関数の入出力型はそのままで、共通loadと関数列から操作ごとの要求を推論する。新しい公開APIや実行時処理は追加していない。

今回の課題では、次の宣言を使える。関数の定義は[AI試用の実装](../scripts/fixtures/onboarding-staged-solution.ts)と同じで、submit/rejectの操作別loadだけを省く。

```ts
return business({
  name: 'expenses',
  load: ports.load,
  save: ports.save,
  operations: {
    submit: [common, submission, submit],
    approve: [common, approval, approve],
    reject: [common, approval, rejection, reject],
  },
});
```

commonは入力型Tをそのまま成功値に保持する共通検証である。従来は最初のRuleだけから要求型を考慮していたため、submitのapproverIdとrejectのreasonを後段から読み取れなかった。

## 精密化する条件

- 元の読み込みがオブジェクトの要求を受け取り、inputを含む文脈を返す。
- 最初のRuleが、その読み込み文脈に対して入力型を保持するgeneric検証の契約を持つ。
- 関数列が宣言するinputの条件を合わせた要求が、loadの入力契約を満たす。
- **load自身が、その要求に対して必要な文脈全体を返すと約束している。** 後段の引数型だけからactorや検証証明を追加しない。
- 全段階で、前段の実際の成功型が次の関数の入力条件を満たす。

もともと接続できる関数列は、そのままの要求型を保つ。途中でinputを別の値へ置き換える正しい処理に対し、後段のinputを外部要求の必須項目として追加しない。

これは任意のgeneric関数の型適用ではない。先頭が入力型を保持しない関数、nominalな文脈、より複雑な相関等では、引き続き操作別loadの型指定や通常のドメイン関数の契約が必要になり得る。名前なしinlineや深いgeneric出力の別の制限を解消したものでもない。

## 検査

[型・実行テスト](../src/business-later-request.test.ts)では次を確認する。

- 共通loadと操作別load、名前付きStep、複数の共通検証。
- 要求・成功・エラーの厳密な型、通常・詳細・選択capture、失敗時の後続停止。
- 別々のgeneric検証が要求する複数の入力項目を同時に保持。
- inputを置き換える既存の有効な処理で、外部要求を不必要に狭めないこと。
- 再送時の要求型・操作名と、同一モデルの別操作の成功値を含む履歴型。
- 固有項目の欠落、入力情報を落とす関数、広いloaderとの動的選択、文脈の一部しか返さないloader、検証証明の捏造を拒否。

実tarballの利用者側検査にも同じテストを含める。さらに、推論を元へ戻す変異は正例を壊し、load自身の出力保証を外す変異は誤った精密化を許して拒否契約を壊すことを確認する。

`npm run test:onboarding:package`は、従来の1段実装、AI試用の操作別load付き実装、上記の共通loadだけの複数段実装を全て実行する。入力を保持しない関数への置換も型検査で拒否する。

この改善はAI試用で見つかった具体的な記述負担への対応であり、人間の学習負担・一般的な生産性・講演全体の完全実現を証明するものではない。

[取得側の入力条件と後段の要求型の合成](business-scoped-request.md)にも対応した。以前のscoped loaderの宣言拒否は正例へ変更し、loaderのtenant条件と業務のapprover条件を同時に要求する。欠落・異なるliteralの呼び出しを、別の専用契約で拒否する。
