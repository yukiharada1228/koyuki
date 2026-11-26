# TypeScript 6と7で配布物を検査する

開発版はTypeScript 7.0.2でbuildする。生成した同じ宣言ファイルを、
TypeScript 6.0.3と7.0.2のそれぞれのconsumerで検査した。
任意の6系・7系バージョンでの動作や、最低対応バージョンを保証する表ではない。

| 検査 | 6.0.3 | 7.0.2 |
| --- | --- | --- |
| 現在のsrc全体の型検査 | 成功 | 成功 |
| packした開発版から最初のアプリを構築（Node型なし） | 成功 | 成功 |
| consumerの型検査と既存783件のruntime検査 | 成功 | 成功 |
| 不正な宣言15件の拒否、次状態型・証明の欠落に対する対照 | 成功 | 成功 |

runtimeは両consumerとも同じbuild済みJavaScriptを使う。二つの異なるruntime実装を検証した数ではない。
独立利用者の作業記録でもない。npm公開版ではなくソースからpackした開発版の結果である。

## 継続して確認する方法

```sh
npm run test:business:package
npm run test:business:typescript6
```

最初のcommandはリポジトリにインストール済みのcompiler版、二つ目は6.0.3をconsumerへ正確に固定する。
両方ともpackと最初のアプリ・consumerを使い、実際のtsc --versionが要求版と一致することを確認する。
build用の依存は変更せず、runtime依存も追加しない。CIには6.0.3のinstalled consumerを追加した。
CIの6.0.3 jobは配布物のconsumerを検査する。src全体の6.0.3での型検査は今回のローカル検査であり、同じjobの追加保証とはしない。

当初の6.0.3でのsrc検査は、不正定義3件の@ts-expect-errorの位置だけで失敗した。
同じ拒否が6と7で異なる行へ報告されるため、対象の呼び出しを一行に置いた。
不正な接続・保存入力・再送設定を拒否する条件は削除していない。

## 入力保持の推論にはバージョン差がある

同じ53a44b9のソース・collector・lock・fixtureを使い、compilerだけを替えて比較した。

| 検査 | 6.0.3 | 7.0.2 |
| --- | --- | --- |
| 現行coreでgenericな入力の組をbusiness配列へ接続 | 不受理 | 不受理 |
| literal関数契約で補正する一時候補（inline / 設定の先行束縛） | 受理 | 不受理 |
| 単独のliteral型計算 | 受理 | 受理 |
| 単独のRule aliasを使う型計算 | 受理 | 不受理 |

[6.0.3の生の結果](business-pair-typescript6.json)と[7.0.2の生の結果](business-pair-typescript7.json)に、
正確な基準commit・compiler版・entrypoint hash・診断を保存した。
root lockのhashは共通のソース依存の記録であり、別に用意した6.0.3のインストールを表すものではない。
collectorはKOYUKI_STUDY_TSCへ実行可能なtscのパスを指定すると、そのcompilerを一時コピーへ使用する。

さらにc8070e1では、business内のRule比較を広くliteralへ展開した
[候補](business-pair-expanded-comparisons.json)も7.0.2で検査した。既存ソースは通るが正例は不受理だった。
6で一つの正例が通ることだけを理由に、候補を製品へ採用したりcompilerをdowngradeしたりはしていない。

この差は「すべてのcompilerで型計算が不可能」という結論を否定する材料になる。
どちらのcompilerの内部処理が原因か、compilerの不具合か、他の補正も不可能かは断定しない。
購買の3つの文脈注釈と講演対応のpartialは残る。
