# genericなフィールドの過剰な型の絞り込みを拒否する

深い入れ子の推論候補を検査する過程で、現行の浅いフィールド推論にも不正な対応を受理するケースが見つかった。
深い推論候補は採用せず、この不具合を先に修正する。

## 問題

共有generic関数が、入力から直和のcontainerを生成する例を考える。

```ts
type Choice<T> =
  | Readonly<{ kind: 'left'; item: Readonly<{ payload: T }> }>
  | Readonly<{ kind: 'right'; count: number }>;
const wrap = <T>(input: T): Result<Readonly<{ choice: Choice<T> }>, never> =>
  ok({ choice: { kind: 'left', item: { payload: input } } });
```

別のgeneric呼び出し元でこの関数を接続すると、修正前は`choice`を`T & Choice<unknown>`として扱う場合があった。
入力が`{ id: string }`なら`choice.id`を読める型になるが、実際のcontainerにidはない。
input/valueの組と、組を介さない普通のrecordの両方で再現した。

TypeScriptのgenericな関数の代入比較が、この例で広すぎる対応を受理する。
既存の出力全体の保証・subtype判定だけでは、この誤ったフィールド対応を排除できなかった。
型が合うことを業務仕様の正しさと同一視しないことに加え、フレームワークの推論自身も不正な情報を作らない必要がある。

## 修正

従来の任意のTに対する比較に加え、独立したprimitive型の入力でも当該フィールドの対応が成立するかを検査する。
内部の`declare const ...: unique symbol`を型の検査にのみ用い、実行時には生成も実行もしない。

containerを生成する関数は、symbol入力に対してもcontainerを返す。
そのcontainerが入力のsymbol自身でもあるという約束は成立しないので、上の誤った対応を拒否できる。
一方、実際にTを返すフィールドや、`T & Proof`を返すフィールドでは、入力との対応と既存のProofを維持する。

具体的な入力での検査結果はgenericな条件型の前に別の型引数へ捕捉する。
条件型の成功分岐で関数型が強められた後に比較することを避ける。
元の出力全体に対する保証・subtype判定は残す。公開API・実行処理・依存関係は変更しない。

これは既知の不正な絞り込みを排除する追加検査であり、TypeScript全体の健全性や、任意のgeneric関数・overload・型アサーションの正しさを証明するものではない。

## 検証

[回帰検査](../src/generic-object-correlation.test.ts)で、修正前に受理された存在しない`id`へのアクセスを拒否する。
実際のcontainerの中には元の入力が保持されることも実行時に確認する。
普通のrecord、input/value、公開business操作、実際の`T & Proof`の保持を検査する。

[配布consumer](../scripts/test-business-package.mjs)にも回帰検査をコピーする。
インストール済みの型宣言から2つの追加検査を一つずつ外し、存在しないidを再び受理するために拒否契約が失敗することを確認してから宣言を復元する。
単に不正な入力を与えた失敗とは区別し、実際の推論の保護を検査する。

## 残る制限

この例のcontainerは安全な`Choice<unknown>`として扱う。深いpayloadと入力Tの対応まで自動で回復する修正ではない。
その型をさらに詳しくしたい場合の課題は、[深い出力の推論調査](deep-output-investigation.md)として残る。
今回の再帰的なvalueフィールド候補も、単純な再現例だけの受理では不十分であり、直和・既存のgeneric呼び出し元・業務フローの契約を一緒に保つ必要がある。

講演の直接音声確認、独立利用者の試用、9話題のpartialは未完了のままである。

全体1,178件、TypeScript 6.0.3・7.0.2の配布consumerは各834件で検証する。
2つの保護条件を外す対照検査も両版で実施する。宣言検査47件、500操作・64段階の検査も通過する。
Web標準API・実行時依存ゼロ・28モジュールを維持する。これらは保守者の検証である。
