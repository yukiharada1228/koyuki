# 購買25操作のloaderをProcessへ接続する

Koyuki側の[25操作](../src/experiments/procurement/application.ts)は、
[Processを使うhost context](../src/experiments/procurement/context-framework.ts)へ移した。
13種類のload関数のうちcreateはI/Oなしの入力構築で、残る12種類の取得をProcessで接続する。
請求書・入荷は[既存のProcess loader](../src/experiments/procurement/context-process.ts)を再利用する。
新しいcore APIを増やしたものではなく、[effectの成功値投影](effect-projection.md)を実例へ適用した。

取得成功値から次の入力を組む部分に、Resultを取り出して早期returnする接続は書かない。
取得するキーと順序、actorによる範囲、関連レコードの絞り込み、booleanの業務factは明示する。
在庫のNotFoundを空在庫として受理する条件も業務解釈として残す。
policyの追加は純粋なWorkflowとして扱い、架空のI/O段階へはしない。

## 比較側との分離

通常TypeScript版plain/helperは従来の[context.ts](../src/experiments/procurement/context.ts)を使う。
このファイルは変更せず、Koyuki側のProcess contextを実行するようには置き換えていない。
したがってloadの接続処理までを比較するとき、両方が同じProcessを使う循環を避けられる。
業務型・業務関数・Repository adapter・Resultの共通型は引き続き共有する。
Koyukiのコードや依存を一切使わない別製品を作ったという比較ではない。

loaderのsourceは2系統になるため、仕様変更時には両方の取得契約を保守する必要がある。
現在のソース量や変更コストを、共通contextを共有していた[過去2変更の計測](procurement-change-measurement.md)へ
遡って混ぜない。今後の現行構成のコスト評価ではcontext-framework/context-processも除外しない。

## 検証したこと

[専用の39テスト](../src/procurement-framework-context.test.ts)で以下を比較する。

- 13関数の成功結果、問い合わせ順序、入力オブジェクトとSymbol値の保持。
- I/Oを持つ12関数の各readにConflictを注入し、後続へ進まず同じ失敗を返すこと。
- 各read/relatedの例外同一性、呼出し順、再試行しないこと。
- 在庫NotFoundを空として扱うinventory/receive/receipt。
- 呼出し元のactor・nested policy変更から切り離し、freezeした値を保持すること。
- 従来contextと双方向に代入できる型契約、genericな追加入力、必須項目の拒否。

このloader単体比較はMemory adapterを使う。別に既存の3方式×Memory/SQLiteの
25操作・32回の成功シナリオと、再送・投影・仕様変更等のテストを新しいKoyuki loaderで継続する。
実tarballのconsumerでも新しいcontextと全比較をコンパイル・実行する。

通常のbusiness loadとして渡す関数はResultを返す契約で、内部traceを自動公開しない。
今回、25操作の詳細reportへ各内部readの段階を増やしたわけではなく、従来の外側loadのtraceを維持する。
明示した詳細loader形式は従来の4操作の試作側で引き続き検査する。

## 残ること

取得順・入力構築・業務解釈をframeworkが推測するものではない。
取得全体のDB snapshot、取得中の並行writer、全操作の全失敗経路、永続再開を網羅した証明でもない。
per-requestにgenericなProcessを作るコスト、保守負担、独立利用者の書き心地は未測定。
Result接続の委譲が実際の25操作へ届いたことと、講演全内容やReact/Elm相当のDXの完成は区別する。
