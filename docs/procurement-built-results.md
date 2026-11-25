# 配布物の比較と構築時の割り当て削減

従来のソース計測にはtsxの変換ヘルパーが含まれる。今回は実際にbuild・packした
開発用tarballを一時ディレクトリに展開し、比較アプリもTypeScriptでES2022/NodeNextの
JavaScriptへコンパイルしてから、tsxを使わずNodeで実行した。npmへの公開はしていない。

## 再現方法と対象

```sh
node scripts/benchmark-procurement-built.mjs --revision fd1977b --backend both --rounds 15 --iterations 10 --warmup 3
node scripts/benchmark-procurement-built.mjs --revision fd1977b --patch /tmp/allocation.patch --backend both --rounds 15 --iterations 10 --warmup 3
```

修正前はfd1977b392fd7b49b3f664ad01bfb9f604191c6b。修正後は同commitに
structure.tsだけのパッチを適用した実験である。各JSONにパッチ・tarball・全配布JSのhashを記録した。
ホストのpackage名とimportを一時的に書き換えるため、両方ともsourceDirty:true。
未変更のcheckoutと偽っていない。`git diff fd1977b -- src/framework/structure.ts`で変更を確認できる。
一時worktreeで実施し、呼び出し元のnode_modulesにはインストールしない。

Node 26.12.0 / Apple M4 / macOS arm64で、修正前1→修正後1→修正後2→修正前2の順に
別プロセスを逐次実行した。各方式・backend・試行で150シナリオ、32成功操作と最終状態を照合。
全4試行で3,600シナリオ、115,200成功操作。warmupはこの数に含めない。
計測範囲・除外項目は[共通手順](procurement-runtime-benchmark.md)と同じ。

## 結果

単位ms。各試行のround平均中央値の範囲であり、信頼区間ではない。

| backend | Koyuki | 5操作者分の構築 | 構築後32操作とsnapshot |
| --- | --- | ---: | ---: |
| memory | 修正前 | 0.4266–0.5285 | 0.8632–0.9008 |
| memory | 修正後 | 0.2772–0.3077 | 0.8403–0.8598 |
| SQLite :memory: | 修正前 | 0.2605–0.3560 | 3.3638–3.8353 |
| SQLite :memory: | 修正後 | 0.2456–0.2504 | 3.2873–3.3841 |

[修正前1](procurement-built-before-1.json)、[修正前2](procurement-built-before-2.json)、
[修正後1](procurement-built-after-1.json)、[修正後2](procurement-built-after-2.json)に全方式の生データを保存。
修正前2ではplainのSQLite実行も約3.34msまで増え、試行間の環境変動がある。
構築時の改善を支持する限定結果だが、通常実行の高速化や統計的有意性は主張しない。
plainに対する速度優位も示していない。

## 変更とprofileの限界

構成グラフ登録時、run/runDetailedプロパティがない関数には、非公開の凍結済み不在記録を共有する。
構成の参照時は比較用配列・記録を作らず、毎回両方のown descriptorを従来順で読む。
利用者の関数は凍結せず、getterは評価せず、可変の実行参照・曖昧なaliasの検出は維持する。

調査用ツールは次のとおり。Node Inspectorは開発ツールだけで使い、コアへの依存は追加しない。

```sh
node --expose-gc --import tsx scripts/profile-procurement.mjs construct 1000
node --expose-gc --import tsx scripts/profile-procurement.mjs execute 100
```

構築profileはIOを禁止。実行profileは5操作者の宣言構築を計測外にし、memoryの共通シナリオを実行する。
100μs sampling、開始前に明示GC、シナリオの小さな不変条件検査は実行profile内に残る。
完全な結果比較はprofile停止後。source hashとcollector hashをsummaryに記録する。
raw profileには絶対パスが含まれ得るためローカルに保存し、Gitには入れない。
これはtsx経由の原因調査であり、配布物の所要時間計測ではない。
Inspector自身、GC、変換ヘルパーのサンプルも大きいため、self割合を実時間の因果的寄与とは扱わない。

この最適化は講演の全内容の実現や、独立参加者による開発体験の実証にはならない。
[受け入れ状況](lecture-acceptance.md)の部分充足という評価は変わらない。
