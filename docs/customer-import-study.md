# 非同期照合後に状態Unionで分岐する実例

2本目の公開PDF16ページの「入力検証→非同期名寄せ→特定できたかで更新/作成」を、
既存APIだけで接続する検証。元製品の予約取込全体の再現ではない。

実装は[domain](../src/examples/customer-import/domain.ts)、
[application](../src/examples/customer-import/application.ts)、
[回帰テスト](../src/customer-import.test.ts)。

```ts
return process<Input>()
  .through(workflow('validate-visitor', validate))
  .effect('identify-customer', ports.identify)
  .through(workflow('decide-customer', decide))
  .effect('save-customer', ports.save);
```

validateは未検証値を検証済みVisitorへ変換する普通の同期Result関数。
identifyはhostが実装する非同期境界で、タグ付きUnionを返す。
decideは通常のswitchでUnionを絞り込み、作成・更新・変更なしのいずれかを返す。
未分解のUnionをそのままcreateCustomer/updateCustomerへ渡すコードは型エラーになる。
入力型・成功型・失敗型の推論も検査する。

実行順序、成功値の受け渡し、Result失敗後の停止、段階traceは既存のProcess/Workflowに委ねる。
Promiseを同期のbusiness関数列へ混ぜたり、終端に空の状態遷移を置いたりする必要はない。

## 検証できたこと

- 新規の場合は作成し、再度同じ内容を取り込むと変更なしになり、余分な書込みをしない。
- 既存の場合は更新し、expectedVersionを保存側へ渡す。
- 入力不正なら照会をしない。照会失敗・異なるgroup/emailなら保存しない。
- 同時更新の片方はhostのCASでConflictとなり、確定済みの状態を壊さない。
- 予期しないadapter例外はrejectし、業務失敗へ偽装しない。

実際の開発版tarballを別ディレクトリへinstallするtest:business:packageでも、
同じdomain/applicationをkoyukiルートimportへ置換して検査・実行する。

## 残った弱点と境界

1. 純粋な計算と非同期I/Oを交互に置く場合、through/effectの構造は利用者が宣言する。
   接続の実行は任せられるが、業務工程の選択まで自動推測するものではない。
2. switchは業務判断として残る。現在のWorkflow.branchはbooleanの選択であり、
   predicateから片側の型を自動で絞り込むAPIではない。
3. traceはdecide-customerという段階を記録する。内部switchの各caseを自動で別段階としては記録しない。
4. この検証のRepositoryはメモリ上のテストhost。scope付き照会・保存値の復元・ID採番・
   createの一意制約・updateの原子的CASは実adapterの責任。永続DBでの名寄せ競合は未検証。
5. 変更なしの再実行は、receiptによる冪等な再送と同一ではない。再照会・業務判定は実行される。
   一連の処理に対するtransaction・自動再試行・外部副作用のrollbackも付与しない。
6. 元資料後半のテーブル割当・予約取込・影響スロット探索の全仕様はこの例に含めない。

APIを増やす前に、既存の明示的境界でこの形を表せることを確認した。
一般的な生産性やReact/Elmと同等の書き心地を実証したという評価ではない。
