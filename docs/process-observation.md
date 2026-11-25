# 途中I/OのProcessから値を選んで観測する

開発版のProcess.runDetailedに、WorkflowCaptureを任意で渡せる。
宣言したI/Oとthroughの純粋Ruleを1回だけ実行し、その前後から選んだ値を返す。

```ts
const task = process<number>()
  .effect('load', async input => ok(input + 1))
  .through(workflow('double', (value: number) => ok(value * 2)));
const report = await task.runDetailed(3, {
  input: value => Number(value),
  result: result => result.ok ? Number(result.value) : null,
});
// result: ok(8)
// observations: load: 3 -> 4, double: 4 -> 8
// observationErrors: []
```

選択関数の引数はunknown。異なる段階の値から、段階名と業務の型に応じて情報を選ぶ。
同じ設定型を使うが、純粋なWorkflow.inspectとI/Oを含むProcessでは観測失敗の扱いが異なる。

## 記録する境界

| 宣言 | 観測対象 | trace |
| --- | --- | --- |
| effect(name, function) | I/O前の入力と返ったResult | 従来のnameと成否 |
| effect(name, { runDetailed }) | command全体の入力と返ったResult | 内部traceにnameと成否を追加 |
| through(workflow) | 実行した各Ruleの入力・Result | 従来のRule・branch選択のtrace |
| commit(mutation) | 全体の入力・Resultをcommitという名で観測 | 従来のmutation内部traceを維持 |

throughでは選ばれた枝のRuleだけを記録する。predicate自体の値や未実行の枝は捏造しない。
空のProcessにはRuleもI/Oもないため、観測値・観測失敗も空になる。
通常のrunと、captureを省略したrunDetailedでは観測値を追加せず、従来のreport形を維持する。
runとrunDetailedを別々に呼ぶと、独立した2回の実行になる。

詳細形式の別commandやcommitの中のすべての値は、境界のActionReport契約からは取得できない。
その内部traceを引き継ぐことと、内部値をすべて観測することは区別する。
commitという観測名のために、既存traceへ架空のcommit行を追加しない。
独自WorkflowのevaluateがStageObserverを使わない独自段階も自動観測の対象外である。

## I/Oと観測の失敗

入力は段階実行前、結果はResultが返った後に選択し、選択後の値だけを共通snapshotでコピーする。
選択しなかった秘密情報・class・実際のSymbol属性のために、業務実行を拒否することはない。
観測値の配列とwrapperはfreezeするが、内部のcopyは再帰的にはfreezeしない。
後から元の値や観測copyを変更しても、もう一方へ反映しない。

選択関数のthrowやコピー失敗は、businessと同様にobservationErrorsへ
`{ step, phase: 'input' | 'result', kind: 'CaptureFailed' }`として分離する。
入力の観測に失敗した段階では結果の選択もしないが、段階そのものは実行する。
through内の純粋Ruleでも、このI/O実行全体の方針を使う。
直接のWorkflow.inspect(input, capture)が観測失敗をthrowする契約は変更しない。

業務Resultの失敗は観測して後続を止める。予期しないthrow/rejectionは元のまま伝播し、
完了reportや架空のResultへ置き換えない。既に行ったI/Oを自動rollback・再送しない。
選択関数は生の値を参照するため、値の変更やI/Oを行わない純粋な関数として実装する。
その制約を型だけで強制したり、任意の悪意あるcallbackを隔離したりはしない。

## 他のAPIと保証範囲

Processを詳細loaderとしてbusinessへ渡す場合、通常のbusinessのcaptureはload全体の入力・結果を選ぶ。
それだけでProcess内部の全値まで自動収集するわけではない。
今回のProcessのcaptureは、Process.runDetailedを直接呼ぶ側が明示して選択する契約である。
永続監査・保持期間・チェックポイント・処理再開・実行履歴の完全収集は提供しない。

[10テスト](../src/process-observation.test.ts)で、単一実行、失敗停止、branch、観測失敗、
参照所有、opaque値・秘密属性、nested command、例外、並行実行、空のProcess、配布型を検査する。
[顧客取込](../src/customer-import.test.ts)の3経路では、作成・更新・変更なしの状態を選び、
名前やメールアドレスを観測値へ含めず、lookup1回・必要な保存1回という挙動を確認する。
両方を実tarballのconsumerでも検査し、browser bundleでもI/Oとthroughのcaptureを実行する。
インプロセスの検査であり、分散schedulerや実製品の全状態履歴の証明ではない。
この追加は公開済みnpm alpha.5には含まれない。
