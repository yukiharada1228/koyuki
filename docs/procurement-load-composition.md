# 読み込み時のResult接続をProcessへ移す試作

講演でいう「イベントとイベントをResultでつなぐ記述」は、業務Ruleだけでなく、
複数のRepository呼び出しからRuleの入力を組み立てる部分にも残っている。
[共通context](../src/experiments/procurement/context.ts)の請求書・入荷の読み込みを、
既存のProcessで[別実装](../src/experiments/procurement/context-process.ts)へ組み直した。
本体のAPIと25操作の既存実装・比較対象は変更していない。

## 任せられたことと残ったこと

元の2関数には、請求書2か所・入荷3か所で、失敗ならreturnする判定がある。
試作では、成功値を名前付きで元のcontextへ追加するローカルなattachとProcessを使う。
各loaderからこの5か所の判定を除き、失敗の伝播と後続停止を共通化できた。
attach自体にはResultの判定が1か所ある。

一方で、業務上の判断は残る。

- 請求書・入荷から親注文を引くキーと取得順序。
- 在庫のNotFoundをnullとして受理し、Conflictは失敗にする区別。
- 関連請求書からvoidedを除く条件。
- 認証済みactorとgroupによる取得範囲。

試作はこれらを暗黙に推測しない。取得を並列化せず、キャッシュ・再試行・transactionも追加しない。
開始済みI/Oの取り消し、読み込み全体の一貫したDB snapshotも提供しない。

## 書き心地の評価

Resultの分岐は減るが、6つのeffect名とローカルな汎用ヘルパーが必要になる。
最初の試作に書いた4か所のコールバック引数型は、既存effectの文脈から推論できるため除去した。
中間contextの型aliasも不要になった。型注釈が必要という初回の評価は訂正する。
attachには、動的な名前付きプロパティを型へ反映する内部の型アサーションもある。
普通のasync関数で早期returnする元の実装より簡単だと示す根拠はまだない。
このため、attachを公開APIへ昇格させたり、全loaderを置き換えたりしていない。

attachはこの試作内の既知のDTOと固定キーだけに使う。任意のclassやキー衝突を安全に扱うAPIではない。
同じ入力contextを各I/Oへ残すという用途と、前段の成功値だけを次段へ渡す通常のeffectは区別する必要がある。
また、genericな入力を保持するため、今回のProcess宣言はloader呼び出しごとに作られる。
定義の再利用と初期入力の型宣言も、次のAPI候補を比較するときの評価対象になる。

## 確認した範囲

[8テスト](../src/procurement-load-composition.test.ts)をrootと実tarballの独立consumerで実行する。

- 非同期Repositoryに対する成功値とread/relatedの呼び出し順の一致。
- 追加の入力フィールド・実際のSymbol値・入力参照の保持、actorのfreeze。
- 各readでConflictが返るときの、失敗値・呼び出し数・後続停止の一致。
- 各read/relatedでrejectしたときの例外同一性・後続停止・再試行しないこと。
- 在庫NotFoundのnull化と、他groupの入荷NotFoundでの停止。
- 入荷contextを既存の純粋な返品Ruleへ渡した結果と、メモリRepositoryへ複合保存した全モデルの一致。
- 入力の追加型を保持し、元loaderと双方向に代入できる成功・失敗型。
- 無注釈callbackから得たcurrent・order・stock・関連配列・入力の型の厳密一致。
- 入力の不足、異なるモデルへの代入、存在しないfactへのアクセスのコンパイル拒否。

メモリRepositoryの比較であり、SQLiteのtransaction分離や取得中の別writerとの競合を検証したものではない。
5つの分岐を除いたことを、全体のコード量・学習負担・生産性の改善とは読み替えない。
この試作は、講演の指摘に対応する接続の記述が依然としてloaderに残ることと、
既存エンジンで実行を共通化できても利用者向けAPIの改善には別の検討が要ることを示す。
