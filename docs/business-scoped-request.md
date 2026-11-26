# loadの入力条件と、後段の要求型を合わせて推論する

取得関数だけが要求するtenant等の項目も、操作の入力型へ保持する。
後段の業務関数にその項目を重ねて書いたり、操作ごとにloadの型引数を指定したりする必要はない。

例えば、loadは`{ id, tenant: 'one' }`、業務判断は`{ id, approver }`を要求するとする。
共通のgeneric検証から始まる関数列を宣言すると、両方を持つ要求が推論される。

```ts
const app = business({ name: 'scoped', load, save,
  operations: { submit: [common, submit] },
});
await app.submit({ id: 'one', tenant: 'one', approver: 'boss' });
```

## 元の取得条件から要求を蓄積する

[先頭から要求型を集める処理](business-request-prefix.md)の初期値を、unknownからload自身の入力型へ変更した。
段階の要求を加える前から、取得側の必須項目やliteralの条件を候補へ含める。
候補がloadの入力条件を満たすこと、loadがその要求で文脈全体を保証すること、全段階が前段の出力を受け取れることの検査は維持する。

もともと接続できる関数列は、元の要求型を保持する。業務の実行順序、失敗処理、保存処理は変更しない。
新しい公開APIや実行時の処理は追加していない。

以前は、この組合せを宣言時に拒否するテストがあった。
その宣言は、呼出し元へtenantとapproverの両方を要求すれば接続できるため、宣言自体の拒否を永続的な仕様にしない。
現在は正例として検査し、tenantの欠落、別のtenant、approverの欠落を呼び出し時に拒否する。取得側と業務側のtenantが矛盾する宣言は、引き続き拒否する。

## 検証した範囲

[専用契約](../src/business-scoped-request.test.ts)は、共通load・操作別load、通常・詳細実行・再送を対象とする。
要求・成功・エラーの型を厳密に比較し、ロード失敗・検証拒否・業務拒否の際に後続と保存を止める。
再送のlookupでも要求条件を維持し、保存済みの結果を返す場合は業務を再実行しない。

例の操作者は、adapterが返す文脈側のactorから参照する。
要求に余分なactorがある変数を渡した場合も、その値を操作者として採用しないことを実行で確認する。
これは例のadapter・業務関数の契約であり、tenantの型を認証・認可の実装の代わりに扱わない。

[配布物検査](../scripts/test-business-package.mjs)には、要求の初期値をunknownへ戻すと正例が型検査で失敗する対照を追加した。
また、[exportするfactory](../scripts/fixtures/business-verified-exports.ts)と[宣言生成の検査](../scripts/check-exported-business.mjs)で、scoped factoryの.d.tsだけを別のconsumerから読み直す。
取得側のliteral、後段の必須項目、呼出し元のgenericなロードエラーを保持する。最終APIの戻り型注釈は書かない。

[購買25操作のload型引数指定が0箇所](business-request-prefix.md)という結果は維持する。
64段階・62項目の検査も引き続き行うが、任意の多相変換・名前なしinline等まで解消したものではない。
原音確認や講演全体の完全実現、新たな独立利用者の試用を主張する変更ではない。
