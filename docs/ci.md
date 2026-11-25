# 開発版の継続検査

[GitHub Actions](../.github/workflows/checks.yml)で、mainへのpush・pull request・手動実行時に検査する。
Node 26系、Ubuntuのhosted runnerを使い、actionsは確認したreleaseのcommit SHAへ固定する。

| job | 実行する検査 |
| --- | --- |
| Core and portable package | npm ci、型検査、全rootテスト、実tarballの依存・配布宣言・Node型なし検査、Node globalなしの実行 |
| Installed consumer and policy change | 開発版を別ディレクトリへinstallしたHTTP/GraphQL/Application・再送・移行・型推論・SQLite writer等と、承認規則変更の比較 |
| Installed registration adapter | 永続outbox・lease・ack回復・人の確認・別OSプロセス |
| Installed prisma adapter | Prisma context・typed rollback・複数行の原子保存・commit失敗・migration |
| Lecture record consistency | 原文を必要としない対応記録の整合性と、検査モードの回帰テスト |

各jobは別runnerで実行する。adapterの一方が失敗しても他方の結果を収集する。
consumer検査は一時ディレクトリの開発版tarballを使う。npm registryにある同じ版番号の内容と混同しない。
Coreの依存ゼロと、host adapterが利用するPrisma等の依存は別々に検査する。

## 原文を使う照合と記録だけの検査

CIでは以下の記録だけの検査を行う。区間・ページの割り当て、根拠パス、未解決事項、
manifestとレビュー記録の宣言が整合するかを点検する。

```sh
npm run check:lecture-audit -- --records-only
npm run check:lecture-decks -- --records-only
npm run test:lecture-records
```

このモードはsourceIdentityVerified: falseを出力し、字幕行の実際の時刻割り当ても検査しない。
ページレビュー済みのflagを受け付けても、人が読んだことをプログラムが証明する意味ではない。


講演の保存済み字幕・PDF本体はリポジトリに含めていない。
以下の検査には、それらを保存したディレクトリが必要。

```sh
npm run check:lecture-audit -- /path/to/functional-business-talks
npm run check:lecture-decks -- /path/to/functional-business-talks
```

CIの成功から、原資料の同一性・全編音声映像・意味解釈・実製品の全仕様を確認したとは判断しない。
[現在の要件別判定](lecture-acceptance.md)と、各検査の対象範囲を併読する。
独立利用者の学習負担や実運用の品質も、これらのjobだけでは測定できない。
