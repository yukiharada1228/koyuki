# 購買シナリオの限定計測で見えた実行負担

このページの2試行はソースを`tsx`で実行した開発時の計測。
配布用JavaScriptの結果とは区別する。[配布物の比較とprofile調査](procurement-built-results.md)を追加した。

計測対象commitは74ff8a58828c7f9b3e7f3b7743a79b027aeed61a。
Node 26.12.0、Apple M4、macOS arm64で、独立した2プロセスを順に実行した。
対象ソースは両方sourceDirty:falseで、同じhash集合だった。
[試行1の生データ](procurement-runtime-sample-1.json)と[試行2](procurement-runtime-sample-2.json)に
日時・環境・全round平均・中央値/四分位/p90・ソースhashを保存している。

```sh
npm run --silent benchmark:procurement -- --backend both --rounds 15 --iterations 10 --warmup 3
```

1試行の1方式・1backendについて、warmup 30シナリオを除き、150シナリオを計測した。
2試行×3方式×2backendで計1,800シナリオ、57,600回の成功操作。
全試行で返り値と6モデルの保存状態を、共通の期待結果と計測後に照合している。
業務実装は[比較テストと共有した25操作・32回のシナリオ](procurement-runtime-benchmark.md)。

## 2試行の中央値の範囲

単位はms。1点が1シナリオ平均で、表は2試行のそれぞれのround平均中央値の最小–最大。
要求ごとのp90や、統計的な信頼区間ではない。

| backend | 方式 | 5操作者の宣言を構築 | 構築後の32操作と最終snapshot |
| --- | --- | ---: | ---: |
| memory | plain | 0.0278–0.0280 | 0.2794–0.2809 |
| memory | helper | 0.0140–0.0143 | 0.2801–0.2808 |
| memory | Koyuki | 0.4902–0.5997 | 1.0190–1.0276 |
| SQLite :memory: | plain | 0.0279–0.0281 | 2.8163–2.8780 |
| SQLite :memory: | helper | 0.0133–0.0133 | 2.7930–2.7936 |
| SQLite :memory: | Koyuki | 0.4392–0.5282 | 3.5417–3.5716 |

各試行のplainに対するKoyukiの実行区間の比率は、memoryで3.65–3.66倍、SQLiteで1.24–1.26倍。
構築区間はmemoryで17.6–21.4倍、SQLiteで15.7–18.8倍だった。
構築の絶対時間は5操作者分で約0.44–0.60msで、実行区間の数値とは分けて評価する。

## 判断と次の調査

この限定例でも、Koyukiの接続と実行の抽象化には測定できる負担があった。
通常実行の速度や構築コストまで達成済みという評価はできない。
一方、これは3方式の同等な成功経路と保存境界に限った測定であり、
実transport・ネットワーク・ファイル永続化・観測・再送・Applicationを含む性能ではない。
共有domainの正しさ、独立参加者の生産性、実運用の遅延や障害率も測っていない。

Koyuki側だけProcess loaderを使う設計差も含むため、比率を特定の関数一つの負担とは呼ばない。
import時間とRepository/schema作成、assertion、後片付けは計測外。
宣言を再利用する運用へ、毎回5操作者分を構築する合計値をそのまま適用しない。

次は構築と通常runを別々にprofileし、実際のhot pathを特定する。
構成メタデータ、診断用データ、snapshot等は調査候補だが、この測定だけで原因とは断定しない。
最適化をする場合も、所有境界・失敗停止・Result型・観測経路の契約を維持し、
同じシナリオの照合を通した後で新しいsource hashの下に再計測する。
この2記録は上記commitの履歴であり、後続commitの実測値として流用しない。
