# 購買25操作の構築時間と実行時間を測る

3方式の実行結果が等しいことを先に確認し、各試行も計測後に全結果・保存状態を照合する。
新しい性能用の簡略な業務を作らず、[既存の32回の成功シナリオ](procurement-comparison.md)を
[共通fixture](../src/experiments/procurement/comparison-scenario.ts)として比較テストと計測で共有する。
計測で不正な結果を返した場合はレポートを成功出力しない。

```sh
npm run --silent benchmark:procurement -- --backend both --rounds 15 --iterations 10 --warmup 3
```

stdoutはkoyuki.procurement-runtime.v1のJSON。結果を保存する場合は呼出し側でリダイレクトする。
通常TypeScript、最小helper、Koyukiの3方式をそれぞれ測る。

## 区間

- construction：buyer・approver 2名・warehouse・financeの、操作者とpolicyに結び付いた5つのアプリ宣言を構築する。
- execution：構築後の25種類・32回の成功操作、結果の収集、最終6モデルのsnapshot取得を行う。

新しいRepository、SQLite schemaの作成、assertion、後片付けは区間外。
各試行で新しい保存先を使い、同じID・version・入力を適用する。
SQLiteは:memory:の実DBエンジンであり、ファイル同期やネットワークI/Oの負担ではない。
通常の操作だけを対象とし、再送・Application session・capture・live観測は無効。
importと型チェック、cold start、失敗経路、transport、全機能を揃えた運用コストも測らない。

1 roundでは各方式をiterations回実行して平均する。方式の順序をroundごとに回転し、
warmup roundは分布に含めない。出す中央値・四分位・p90は**round平均の分布**であり、
個々の要求のp90や本番のtail latencyではない。
scenarioの実行は直列で、明示的なGC・CPU固定・他プロセス停止は行わない。

## 来歴と解釈

日時、Node/V8・OS種類・CPU種類、tool版、Git commit、対象ソースとpackage情報のSHA256を記録する。
対象ソースが未commitならsourceDirtyがtrue。実行中にsourceやHEADが変われば停止する。
hostname・ユーザー名・絶対homeパスは記録しない。

共有domainとadapterを使う比較なので、共有した業務規則の正しさを速度測定で証明しない。
KoyukiはProcessのloaderを使い、plain/helperは手続き型loaderを使う。
比率はその設計を含むこの試行の値であり、framework関数一つの単独コストではない。
5つの宣言を毎回構築する負担と、既存宣言を再利用する実行負担を混ぜて結論しない。
この計測を独立利用者の開発速度、保守費用、実障害率、実運用性能の証明へ一般化しない。

[smoke検査](../src/procurement-benchmark.test.ts)は2 backend×3方式の形と来歴、非有限値がないこと、
失敗した操作が完了計測として扱われないことを確認する。速度の閾値をテストへ固定しない。
