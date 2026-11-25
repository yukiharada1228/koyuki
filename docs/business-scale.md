# 多数の操作でも入力・成功・失敗型を対応させる

100操作と500操作を、それぞれ一つのbusinessのoperationsに定義し、実tarballを使う
独立consumerで型検査・JavaScriptへのemit・全操作の成功実行を検査した。
これは生成した型の接続課題であり、500種類の実業務を実装したという意味ではない。

```sh
npm run check:business:scale
```

開発版をbuild・packし、一時ディレクトリにinstallしてから検査する。
npmへの公開は行わず、生成consumerにNodeの型も要求しない。
実行用hostと検査scriptはNodeを使うが、コアの実行時依存は追加しない。
同じ検査をCIのCore and portable package jobにも追加した。

## 各操作で検査すること

- op0〜op499に異なるoperationリテラルを持つ入力型を割り当てる。
- validate→permit→approveをprivateなunique symbolのbrandで接続する。
- 入力型と、成功型・load/検証/認可/更新/保存の失敗unionを厳密一致で検査する。
- 隣の操作の入力を渡す呼び出しが全操作で拒否されることを確認する。unused ts-expect-errorも検査失敗となる。
- 別の不正fixtureでは、全操作からpermitを除く。各操作のソース位置で、それぞれ診断が出ることを確認する。
- 正しい定義はemit後にすべて呼び出し、operation・status・amountを照合する。

検査用のbrand生成箇所だけ型アサーションを用いる。生成した業務定義の接続を
any/unknownや二重castで迂回していない。操作別loaderと共通generic saveを使う。
初回の記録では共通loadも設定した。後続の[個別loadのみの宣言](business-local-load.md)では
この未使用の設定を省略できるようにし、現在のscriptは共通loadなしで同じ検査を行う。
[共通loadなしの追加記録](business-local-load-scale-sample.json)も保存している。

## 記録と発見した制限

[生データ](business-scale-sample.json)はcommit 51bfd67c49223f794ac2240a909cb4000d40e274、
Node 26.12.0 / TypeScript 7.0.2 / macOS arm64で実行したもの。
sourceDirty:falseで、ソース・collector・生成fixture・tarballのhashを保存している。
100/500操作それぞれで入力/出力の厳密一致、入力取り違えの拒否、認可工程欠落の拒否、成功実行を確認した。
所要時間はcompiler/Nodeのプロセス起動を含む一回の記録であり、
エディターの補完速度、統計的な性能評価、通常TypeScriptとの速度比較ではない。速度の合否閾値も設けない。

最初に全型契約・結果のif検査を500組、一つのモジュール本体へ並べたところ、
TS2563（制御フロー解析対象が大きすぎる）が出た。
Koyukiへのimportすらない通常TypeScriptの対応するfixtureでも同じ診断を再現した。
型契約と呼び出しを操作ごとの関数へ分けると、一つの500操作business定義を維持したまま検査できた。
操作数を減らして通した結果ではない。

この限界の再現例もscript内で検査する。compiler更新でTS2563が消えた場合は、
既知の制限を再評価するためこの検査を更新する。
一つの巨大な関数へすべてを書ける、任意の規模で型検査できるという保証にはしない。

操作内は3段階で、長い関数列・generic callbackの全組合せ・Applicationや再送型は対象外。
複雑な実業務の多様性、仕様変更への強さ、独立利用者の生産性は測っていない。
これらは[25操作の実例](procurement-study.md)や[チーム評価案](team-development-study.md)と分けて評価する。
講演全体への[部分充足という判定](lecture-acceptance.md)も変えない。
