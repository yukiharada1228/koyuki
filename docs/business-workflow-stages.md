# businessで既存Workflowの型と内部観測を保つ

開発版のbusinessは、普通の関数・Stepに加え、Workflowオブジェクトを操作配列へ直接受け取る。
公開済みnpm alpha.5の機能ではなく、開発版tarballで検査する。

```ts
import { business, workflow, ok, err, type Result } from 'koyuki';

const calculation = workflow('positive', (value: number): Result<number, 'Invalid'> =>
  value > 0 ? ok(value) : err('Invalid'))
  .then('double', value => ok(value * 2));

const counter = business({
  name: 'counter',
  load: async (value: number) => ok(value),
  save: async (value: number) => ok(value),
  operations: { calculate: [calculation] },
});
await counter.calculate(2);
```

thenのcallbackは前段の成功型から推論する。businessの外側のload・入力・全失敗型・saveとの接続も検査する。
Workflowへ渡す最初の関数には必要に応じて引数の型を明示する。任意のgeneric変換の推論制限を解消したものではない。
Workflowを使うことは必須ではなく、従来の普通の関数とStepの配列も維持する。

## 明示した構成だけを接続する

オブジェクトを直接渡した場合、traceはload→positive→double→saveとなり、余分なrun:1の包みを追加しない。
内部の失敗では後続とsaveを止め、元のResultまたは想定外の例外を維持する。
runDetailedの選択capture、Applicationのlive span、describeFlowの構成図も内部の宣言を使う。
branchは選択した経路だけ実行し、構成図には両経路を残す。
branchの選択markerはtraceへ現れるが、独立したRuleの入出力captureを捏造しない。
機密値の選択・保持方針や永続監査を追加するものではない。

calculation.runを普通の関数として渡す従来の形式は、引き続き一つのopaqueな段階となる。
関数本体を調べて内部の処理を推測しない。Stepのruleへrunを入れた場合も同じである。
Workflowと混在する普通の関数の既定名run:nは配列の位置を使う。内部の段階数で番号をずらさない。

実行の参照と構造はbusinessの構築時に取り込む。構築後のWorkflowのrun/inspect/nameの差し替えで、
取り込み済みの操作の処理や構成図を変更しない。任意のprivate実装への改変を防ぐ機能ではない。
実行対象はこのruntimeのWorkflowインスタンスであり、同じ形のオブジェクトをメソッド名だけで認識しない。
ruleも持つWorkflowや、内部のWorkflow実行能力をコピーした呼び出し可能関数は本体が曖昧なため、
構築時にAmbiguousBusinessStageで拒否する。

ソース診断CLIのbusiness配列内のWorkflow展開は未対応で、該当段階をunresolvedに残す。
Workflow自体の構文検査と、実行時の構成図は別の入口である。全診断が対応済みとはしない。

## 数量訂正の試作で確認した改善

[前の比較](procurement-correction-decomposition.md)に、Workflowを直接渡す4つ目の候補を追加した。
追加callback注釈を省くthenの推論を保ったまま、revalidate-correctionとfinish-correctionの両方が
trace・選択capture・外側の構成図へ現れる。成功計画と失敗停止も元の期待値で確認する。
domainの現行経路はまだ変更しておらず、テスト内の計画投影の重複を本採用したものではない。

[専用検査](../src/business-workflow-stages.test.ts)は、関数/Stepとの混在、classの文脈と入力参照、
generic load、分岐、live span、保存停止、例外の同一性、参照の取り込み、再送、曖昧な値の拒否を対象とする。
型検査には、証明の省略、saveとの不一致、動的候補の一部だけが不適合な場合を含める。
同じ検査を配布物consumerでも実行する。再送の追加例は検証用の保存境界であり、外部副作用のexactly-onceを証明しない。

これはiz-22/24・qbf-19の記述負担と、w0o-13の明示的な途中状態を両立するための改善である。
独立利用者による書き心地の評価、任意の関数の透明性、原音の確認、全講演の完全実現は未達のままである。
