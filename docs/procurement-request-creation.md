# 申請作成の検証・明細解析・計画作成を宣言へ出す

購買の実businessで、createRequestの内部にあったResultの取り出しを、既存のWorkflowへ移した。
以下の128/272境界や50ラベルはこの移行時点の記録。後続の[申請編集](procurement-request-edit.md)により、現在は130/274境界、52ラベルとなる。
[実経路](../src/experiments/procurement/request-pipeline.ts)は次の宣言となる。

```ts
export const requestCreationDecision = workflow('authorize-creation', checkRequestCreation)
  .then('parse-lines', withInput(value => parseRequestLines(value.input.lines)))
  .then('create-request-plan', ({ input, value }) => ok(requestCreationPlan(input, value)));
```

追加callbackの引数注釈やResultの手動判定はない。
businessはcreate: [requestCreationDecision]をload/saveへ接続する。
新しいframework APIは追加せず、普通のドメイン関数で業務判断を共有する。

## 型と実行の境界

checkRequestCreationはbuyerの権限・識別子を確認し、元の入力参照へprivateな作成前提の証明を付ける。
parseRequestLinesは既存の明細検証を公開し、非空・件数上限・SKU重複・正の整数・安全な合計の検査を行う。
成功する配列と各行は従来通りfreezeする。配列にもprivateな解析済みの証明を持たせ、空配列だけで計画へ渡せないようにした。
requestCreationPlanはこの2つの証明を要求し、初版のDraftと不在版のCAS検査を作る純粋な投影である。

withInputが検証済みの文脈と解析結果を保持し、Workflowが失敗時に後続を実行しない。
ドメインの検証順序、明細の意味、保存adapterの実装は利用者の責任として残る。
privateな証明は検証関数の契約を接続するもので、型アサーション・any・検証後の変更を防止しない。
任意の解析済み明細と任意の入力が同じ値から来たことまで型で証明するものでもない。
宣言した実経路では、その入力の明細だけを解析してから計画へ渡す。

従来のcreateRequestは互換入口として維持し、手動のResult接続もそこには残す。
通常TS/helperの比較版はframeworkのWorkflowを実行せず、同じ3段階を手動で実行する。
基準実装の段階名は共有のbaselineStepNameへまとめ、再送の診断も同じ手動経路を表示する。

## 期待値と比較

[専用検査](../src/procurement-request-creation.test.ts)では、独立した期待値で初版・所有者・合計・writes・不在版検査を照合する。
不正な操作者やIDでは明細を読む前に拒否し、不正明細・重複・桁あふれ・件数上限では計画作成へ進まない。
検証の省略、空配列、publicな証明の偽装は型検査で拒否する。メモリ/SQLiteで非保存と正常保存を確認する。

既存の3方式比較も実経路へ合わせた。25操作の32回シナリオは変わらない。
申請作成が2回あり、それぞれの業務段階が1つから3つになるため、成功観測は124から128境界へ増える。
代表失敗は不正入力66＋保存前Conflict128＋read失敗78＝272境界である。
I/O例外は72種類の位置・178回のまま、入力射影370回・結果射影192回または0回となる。
Application経由の例外検査も同じ新しい段階名を確認する。
これらは有限シナリオの観測件数であり、業務仕様や全入力の網羅件数ではない。

静的診断CLIは5つの選択ソースで、6 business＋2 Workflowの8宣言、25操作ID、50ラベルを解決する。
applicationだけの47参照が減ったという意味ではなく、明示Workflowを内部名へ展開した数である。
作成の旧run:1はauthorize-creation/parse-lines/create-request-planへ変わるため、段階名を指定する診断用selectorは更新が必要になる。

## 残る範囲

21操作が複数段階となったが、全ドメイン内部のResult接続がなくなったわけではない。
後続の申請編集でも実経路の明細接続を宣言へ移したが、互換関数、他の内部接続、hostの入力構築、購買の3つの文脈注釈は残る。
独立利用者の評価や講演の原音確認、全講演の完全実現は未完了のままとする。
