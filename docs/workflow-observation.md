# 段階の入力・結果を選んで観測する

開発版の`Workflow.inspect(input, capture)`で、実行した各Ruleの前後から選んだ情報を取得する。
通常の`run(input)`と`inspect(input)`は値を記録せず、従来の結果と成否traceを返す。

```ts
const flow = workflow('increment', (n: number) => ok(n + 1))
  .then('double', n => ok(n * 2));
const report = flow.inspect(2, {
  input: value => Number(value),
  result: value => value.ok ? Number(value.value) : null,
});
// report.observations:
// [{ step: 'increment', input: 2, result: 3 },
//  { step: 'double', input: 3, result: 6 }]
```

callbackの第2引数は段階名。異なる型を通るため、値はunknownとして渡し、必要な情報を選ぶ。
input callbackはRuleの実行前、result callbackはResultが返った後に呼ぶ。
**選んでからstructuredCloneする**ため、選ばなかった秘密情報やcloneできない関数を履歴へ混ぜる必要はない。
ただしcallback自体は生の値を参照できるため、値の変更や外部I/Oを行わない設計が必要。

選択した入力は実行前にcloneされ、次段階や呼び出し元による後の参照変更から隔離される。
観測結果の配列・wrapperはfreezeするが、その中のcloneを再帰的にfreezeはしない。
記録を読む側が自分のcopyを書き換えても、元のドメイン値には反映されない。

Ruleは再実行しない。失敗したRuleも記録し、後続のRuleは実行・記録しない。
branchでは選択した経路のRuleだけを記録し、predicateによる経路選択は従来のtraceに残す。
transitionのvalidate/require/evolveも同じ仕組みで観測できる。

input/result callbackやcloneの失敗は観測時の欠陥としてthrowする。
inputの取得が失敗すればそのRuleは未実行、resultの取得で失敗した場合はRuleは実行済み。
純粋な計算の検査APIであり、この失敗を業務エラーへ自動変換しない。
Ruleの想定外のthrowにはResultがないため、完了した観測reportは返らない。

この入口はWorkflowとtransitionに対するもの。businessの非同期操作・load/save・再送reportの
全体へ同じ設定を渡せるAPIはまだ提供していない。独自にnew Workflowでevaluateを実装する場合も、
内部のStageObserverを使わない独自段階までは自動で観測できない。

観測結果はメモリ上の戻り値。永続監査ログ・チェックポイント・再開機能ではない。
保存・公開項目・保持期間はホストの責務で、全データの自動dumpは行わない。
3本目23分台の「引数と戻り値から途中状態を観測する」という説明へ対応を広げるが、
これだけで全アプリケーションの履歴を自動取得できるという意味ではない。
