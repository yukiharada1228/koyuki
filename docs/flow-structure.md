# 業務処理を実行せずに構成を確認する

開発版の`describeFlow(command)`はJSONで保存できる構成を、`flowMermaid(command)`はMermaidのテキストを返す。
どちらも入力値を受け取らず、業務関数・分岐predicate・load・save・描画callbackを実行しない。
公開alpha.5には含まれない。

```ts
import { describeFlow, flowMermaid } from 'koyuki';

const graph = describeFlow(expense.approve);
const diagram = flowMermaid(expense.approve);
```

expenseはhostで宣言したbusiness等の操作群。通常の関数を並べる業務宣言へ図のための接続コードを追加する必要はない。
coreが宣言を組み立てる際に、データだけの構成をprivateなWeakMapへ登録する。
run/runDetailedの既知の関数参照にも同じ構成を保持する。
関数本体の文字列、関数名、型の反射、未登録hostオブジェクトのプロパティを走査して構造を推測しない。
登録済みの実行参照を確認する際はrun/runDetailedのdata descriptorだけを照合し、getterを呼び出さない。

## 何が分かるか

| 宣言 | 記録する構成 |
| --- | --- |
| workflow / then | 名前付きのruleと宣言上の順序 |
| transition / defineTransition | validate・require・evolveの役割と順序 |
| Workflow.branch | 明示したyes/no両経路と合流用のsynthetic node |
| Process.through / effect | ruleとの接続と、明示したIO境界 |
| bindMutation / Process.commit | 既知の最終判断・save。未知のcommit実装はunknown |
| defineAction / defineCommand / Target | load境界、既知の詳細loader、判断、save |
| business | 共通/個別load、runの配列、save |
| withReplay | coreが明示するsnapshot・照会・cached判定・command・失敗後の回復条件 |

普通の関数の内部はopaque。その関数がDBへ何回アクセスするか、どんな業務条件で分岐するかは推論しない。
未登録のhost・手書きのWorkflow constructor・独自wrapper等はunknownとして残す。
既知のrun関数を別の関数で包んだ場合、その新しい関数へ勝手に構成を引き継がない。
明示したlegacy rendererはrender-and-verifyというunknown境界を含め、構成の取得では呼び出さない。

metadataは宣言作成時の構成。[宣言の所有権](declaration-ownership.md)として関数・名前・分岐先を保持する。
元の設定recordを後から書き換えても、既存処理の接続先は変更しない。
実行objectのrun/runDetailed自体を変更した場合は、元の構成を表示せずunknownへ戻す。
同じmodule instanceに登録した構成だけを認識する。別のpackageコピー・workerの実行オブジェクトを反射して復元しない。

## JSONと構成の意味

graphのschemaはkoyuki.flow.v1、semanticsはdeclared-composition。
nodeはフレームワークが採番したid、kind、name、role、implementationを持つ。
branchのpredicateや各stepの本体はimplementation:opaque、図の合流点はsynthetic。
データはfreezeした新しいオブジェクト/配列で、関数、入力値、認証情報、DB接続を含めない。

edgeは構成上の接続、choiceは明示したyes/no。
これは業務状態の状態遷移図や、任意の例外経路まで列挙した完全な制御フローグラフではない。
通常のResult失敗で後続が止まること、例外・キャンセル・hostのtransactionのすべてを別の矢印で表してはいない。
replayの条件も関数本体や保存adapterの正しさを証明するものではない。

## 既存の実行記録を重ねる

```ts
const report = await command.runDetailed(input); // 一度だけ実行
const graph = describeFlow(command, report.trace);
const diagram = flowMermaid(command, report.trace); // 再実行しない
```

重ねるのはstep/statusという既存Traceのメタデータだけ。
名前が一意に対応したnodeはok/error、重複した名前はambiguous、対応する記録がなければnoneとする。
不明な記録はunmatchedTraceへ残す。余分なpayloadをコピーせず、step/statusのaccessorや不正なstatusは拒否する。

**matchは名前の対応であり、node IDによる実行証明ではない。**
noneは「未実行」の証明ではなく、記録に対応する名前がないという意味。
同名の枝を推測で一つに決めたり、未知の関数の内部を実行済みとして補完したりしない。
callerは一回分の記録を渡す。別実行のtraceを混ぜた場合の経路を復元する保証はない。

withReplayのtop-level ReplayTraceはstep/status形式ではない。
内部commandだけを重ねたい場合はreport.attempt?.traceを使えるが、receipt条件の実行経路までは自動で色付けしない。
[Applicationの実行ID](application-execution.md)も構成node IDとは別。完全なspan対応は未提供。

## タグ・送料で確認する

```sh
npm run --silent demo:flow
```

[demoの定義](../src/examples/flow-structure.ts)はタグ作成、送料、明示したbranchのJSON/Mermaidを出力する。
DBや配送APIを呼ばず、保存済みの業務データも不要。
送料のportは呼ばれたらthrowするようにしてあり、タグrepositoryの呼出しもゼロであることを確認する。

タグはload→validate→require→require→evolve→saveを表す。
送料は入力検証→注文取得→注文の事前条件確認→国内/海外サービスの分岐→見積IO→見積検証→saveを表す。
serviceWorkflowはshipping-serviceというWorkflow.branchを明示し、国内/海外の両経路を記録する。
図の取得では両経路を実行せず、実行後のtraceでは選択したselect-domestic-serviceまたは
select-international-serviceにだけ一致する記録を重ねる。
これは明示した宣言の取得であり、任意の通常関数内部のifを解析した結果ではない。
注文の一致・未発送の確認と各サービスの生成は通常の純粋関数として分け、
通常TSの比較版はこれらを直接呼ぶ。Workflowの実行を比較版から使わない。
成功と各業務失敗を含む10条件×3入力の30ケースで、結果とI/O順序を比較する。
業務の状態遷移や関数内の分岐まで図示したい場合は、別途明示した仕様・metadataが必要。

この変更で送料例の診断traceは、従来のselect-shipping-service一段から、
ensure-shipping-order、shipping-service:yes/no、選択したサービス生成の段階へ変わる。
診断名に依存する比較・表示は更新が必要。操作ID shipping.save.v1、入力・結果・失敗の型とI/Oの順序は維持する。

## Mermaidと検査範囲

coreはMermaid packageやDOMをimportせず、構文テキストだけを返す。
IDはframeworkの採番だけを使い、ラベルの構文文字・改行等は
[Mermaid公式のentityコード](https://mermaid.js.org/syntax/flowchart.html#entity-codes-to-escape-characters)でエンコードする。
実際のHTML/SVG表示とそのセキュリティ設定は呼出し側のrendererの責務。

2026-11-25、Node 26.12.0の一時環境でMermaid 12.3.0＋jsdom 31.0.1を使い、
直列・branch・空のProcess・タグ・送料・特殊文字入りの6例がmermaid.parseを通ることを確認した。
この一時検査は構文の検証であり、SVGの見た目やすべてのMermaid versionの保証ではない。
検証用packageをcoreの依存やrepoの依存へ追加していない。
これは送料を明示分岐へ変更する前の出力を対象とした構文検査の履歴である。

[coreの検査](../src/flow-structure.test.ts)は関数/IOの非実行、両経路、役割、freeze、unknown、
名前重複、入力trace、特殊文字、business/replayの構成を確認する。
構成の走査は再帰呼出しを使わず、1001段の宣言を実行なしで取得できることも検査する。
[実例の検査](../src/flow-examples.test.ts)はタグ・送料の構成と、国内/海外それぞれ一回の実行traceとの対応を確認する。
実tarballのconsumerとNode globalなしのbundleでもAPIを検査する。
CIはこれらの意味・出力検査を継続するが、一時環境のMermaid parser検査を自動実行する構成ではない。

[Issue #3](https://github.com/yukiharada1228/koyuki/issues/3)に対する構成図の実装。送料の明示分岐も同じ例で確認できる。
業務状態図の自動導出、関数内部の分岐解析、完全なnode/span対応、全条件での経路検証は未完了。
[Issue #6](https://github.com/yukiharada1228/koyuki/issues/6)の[非実行のソース診断CLI](declaration-diagnostics.md)は別の開発ツールとして一部実装した。構成図やCLIの追加を、全宣言の診断・業務規則の証明の完成とは扱わない。
