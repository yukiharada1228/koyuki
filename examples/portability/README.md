# Browser / Cloudflare Workers compatibility

同じscenario.tsをブラウザとHono Workerで実行する検証例。
[実環境の検証ページ](https://koyuki-portability-alpha4.yukiharada1228.workers.dev)で「検証する」を押す。

確認済み：Chromium 156、ローカルworkerd 1.20261123.1、Cloudflare Workersの公開環境。
Workerはnodejs_compatを指定せず、Node polyfillを追加しない。Honoはアプリ側の依存であり、Koyukiの実行依存ではない。
バージョンと結果は[RESULTS.json](RESULTS.json)を参照。

## ローカルで再現

npmのalpha.4を参照する独立したサンプル。リポジトリをcloneした後：

```sh
cd examples/portability
npm ci
npm run types
npm run check
npm run build
npm run audit:bundle
npm run dev
```

http://localhost:8794 を開いて「検証する」を押す。
別ターミナルから `npm run smoke` でもWorkerへの5回の独立リクエストを確認できる。
任意の公開先は `npm run smoke -- https://YOUR-WORKER.workers.dev`。

Cloudflareへの配置は、自分のアカウントを指定して `wrangler deploy`。
名前は検証用であり、認証・永続DB・秘密情報・外部サービスへの呼出しは含めない。
Worker名と配置先は自分の用途に合わせて変更する。

## 検証範囲と制限

通常実行、同一要求の再送、入力拒否、保存応答が失われた場合の成功記録照会を同じコードで再現する。
再送で業務を実行しないことと、回復時に元の失敗と境界traceを保持することをassertする。
ブラウザはNode系グローバルなし。観測したWorkers環境ではprocessとBufferが存在したが、検証コードやコアからは使用しない。
環境のグローバル一覧だけは異なり得るため、業務結果の比較から除外する。

バンドルのmetafileでは全てのimportが解決済みで、Node shimが入っていないことを確認する。
さらにルートのcheck:packageでコアの実行依存ゼロ、Node型なしの公開宣言、全JSモジュールのローカルimportを検証する。

状態と成功記録は各runScenario呼出し内だけのメモリに保持する。
HTTP要求をまたぐ再送や、本番DBトランザクション、認証の検証ではない。
Safari / Firefox / Deno / Bun / 他のエッジ基盤は未確認。

Workers構成は[公式Wranglerドキュメント](https://developers.cloudflare.com/workers/wrangler/commands/)と
[HonoのWorkersガイド](https://hono.dev/docs/getting-started/cloudflare-workers)を確認して作成。
