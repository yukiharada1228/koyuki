# 申請編集の状態検証・明細解析・更新計画を宣言へ移す

[実business](../src/experiments/procurement/application.ts)の編集は、checkBuyerRequestの後に
[requestEditDecision](../src/experiments/procurement/request-pipeline.ts)を接続する。

```ts
export const requestEditDecision = workflow('require-draft', checkRequestEdit)
  .then('parse-lines', withInput(value => parseRequestLines(value.input.lines)))
  .then('edit-request-plan', ({ input, value }) => ok(requestEditPlan(input, value)));
```

権限・識別子・版の検証、下書き状態の確認、明細解析、更新計画の4段階となる。
新しいframework APIやcallbackの引数注釈は加えず、失敗時の停止と接続を既存のruntimeへ任せる。
明細解析は[申請作成](procurement-request-creation.md)と同じ通常関数を使う。

## 業務の順序と型

checkRequestEditはbuyer検証済みの文脈を要求し、現在のRequestがDraftであることを確認する。
requestEditPlanはこの文脈とprivateな解析済み配列の証明を要求する純粋な投影である。
任意状態のRequestや、未検証の空配列から直接計画を作る接続は型検査で拒否する。
既にDraftであることを型が保証する文脈まで、同じ状態検証の再実行を強制するものではない。

エラーの順序は、従来の権限等→版→状態→明細のままである。
WrongStateでは明細を読まず、ConflictやInvalidInputを別のエラーで上書きしない。
計画は所有者・group・IDを維持し、版を一つ増やし、元の版をCAS検査へ指定する。
privateな証明は検証の業務的正しさや、解析結果と入力の値レベルの同一性、検証後の変更まで証明しない。

editRequest/editCheckedRequestは互換入口として維持し、その中には手動のResult接続が残る。
実businessはこの互換入口を呼ばず、外側の関数列と明示Workflowで接続する。
通常TS/helperも同じ4段階を手動で実行し、frameworkの実行エンジンは使わない。

## 検査

[専用検査](../src/procurement-request-edit.test.ts)では、独立した期待値で更新計画・合計・元版・writesを確認する。
未認可・不正版・任意状態・未解析配列の拒否、元の文脈参照と入力の非変更も確認する。
メモリ/SQLiteの実commandで、不正明細の非保存、正常更新、申請済み状態の拒否を照合する。
下書き以外ではgetterを持つ明細へ触れないことも、通常の状態遷移で作った申請済みモデルから検査する。
このgetterの例は純粋なdomain境界の検査であり、Applicationが任意のgetterを持つDTOを受理するという意味ではない。
公開編集APIの入力・Result型を厳密一致で検査し、実tarballのconsumerにも含める。

25操作・32回の既存シナリオでは、編集が1回あり業務段階が2つ増える。
成功観測は130境界、代表失敗は不正入力66＋保存前Conflict130＋read失敗78＝274境界となる。
代表不正入力は版の検証で止まるため、その観測数は増えない。
I/O例外の72位置・178回は変わらず、入力射影374回・結果射影196回または0回を確認する。
通常TS/helper/Koyukiの観測・再送、Application経由の例外検査も同じ段階へ合わせる。
5つの選択ソースの静的診断は、6 business＋3 Workflowの9宣言、25 ID、52ラベルを解決する。
これらは有限の検査範囲であり、全入力・全経路の網羅を示す件数ではない。

旧run:2はrequire-draft/parse-lines/edit-request-planへ変わるため、名前で段階を選ぶ診断用selectorは更新が必要である。
互換関数や他の業務内部の接続、購買の3つの文脈注釈、独立利用者の評価は残る。
原音の未確認範囲や、講演全体の完全実現は未完了のままとする。
