# 通常の関数で業務操作を宣言する

開発版の推奨入口。公開済みnpm `0.1.0-alpha.5`にはまだ含まれない。
ソースからビルドした配布物では`import { business } from 'koyuki'`で利用できる。
[別プロジェクトへの導入からApplicationまで](development-start.md)を一続きで試せる。
既存の[Workflowを操作配列へ直接接続](business-workflow-stages.md)し、型の文脈と内部のtrace・選択観測・構成図を保つこともできる。

```ts
import { business, ok, err, type Result } from 'koyuki';

type Request = { readonly amount: number };
type Approved = { readonly kind: 'approved'; readonly amount: number };
const validAmount: unique symbol = Symbol('validAmount');
type Validated = Request & { readonly [validAmount]: true };
function validate(request: Request): Result<Validated, 'InvalidAmount'> {
  return Number.isSafeInteger(request.amount) && request.amount > 0
    ? ok({ ...request, [validAmount]: true }) : err('InvalidAmount');
}
function approve(request: Validated): Result<Approved, never> {
  return ok({ kind: 'approved', amount: request.amount });
}
const saved: Approved[] = [];
const expense = business({
  name: 'expense.v1',
  load: async (request: Request) => ok(request),
  save: async (value: Approved) => { saved.push(value); return ok(value); },
  operations: { approve: [validate, approve] },
});
const accepted = await expense.approve({ amount: 100 });
const rejected = await expense.approve({ amount: -1 });
if (!accepted.ok || rejected.ok || saved.length !== 1) throw new Error('Unexpected result');
```

これは配布consumerでも実行する接続の最小例。認証、DB、再送を実装した例ではない。
実際の業務ルールと状態は利用者が定義する。型の証拠も、対応する検証関数が正しく判定する契約が必要。
`any`や型アサーションまで排除する仕組みではない。

## 宣言と実行の契約

- `name`は操作群の名前。操作IDの既定値は`${name}.${操作名}`。
- `load`は要求から業務関数の入力を取得する非同期Result関数。内部traceも接続する場合は[詳細形式](detailed-load.md)の`{ runDetailed }`を指定する。
- `operations`は業務名と、同期Result関数の空でないtuple。成功値を順に渡す。
- `save`は最後の成功値を保存する非同期Result関数。操作群で同じ保存契約を共有する。
- 宣言時にI/Oは実行しない。`expense.approve(input)`と`.run(input)`は同じ実行入口。
- `.runDetailed(input)`は既存commandの詳細reportを返す。通常のtrace名は`run:1`等の位置。
- `.runDetailed(input, capture)`で、load・Rule・save・再送照会から選んだ値を[観測できる](workflow-observation.md)。観測失敗は業務結果から分離する。
- 最初の失敗で後続とsaveを止める。予期しないthrow/rejectionは伝播し、Resultへ自動変換しない。

取得方法が操作ごとに異なる場合は`{ load, run: [...] }`を指定する。
すべての操作が個別loadを持つなら、[共通loadは省略できる](business-local-load.md)。
配列形式の操作が一つでもあれば、その取得方法として共通loadが必要。
[inputを含む文脈のgeneric load](business-generic-load.md)では、最初のRuleに必要な文脈を
返せることを型で確認できる場合、共有loadから操作ごとの要求型を保持する。
任意のgeneric loaderの相関を自動復元する保証はない。
空配列・asyncルール・隣接型の不一致・saveに渡せない最終出力は拒否する。
共通generic saveが操作ごとの成功型を保持する場合は、[保存後の成功型](business-save-inference.md)も保持できる。
広い結果への変換や再送の成功型を、最後のRuleだけから狭めない。
voidの検証結果から元の入力を暗黙に復元しない。必要な値は関数の戻り値で表す。
通常実行では業務の成功値をそのままsaveへ渡し、Symbol属性やクラスを診断のために拒否しない。
計画へsnapshotできない場合はinputStatus: unavailableを示す。[業務値と診断の分離](opaque-decisions.md)を参照。
`then`という操作名はthenableとの衝突を避けるため予約する。
operationsはownなデータ項目を持つ通常のレコードとして宣言する。
[操作テーブルの契約](business-operation-table.md)では、数値名の文字列化、非列挙データ項目、Symbol/getterの扱いを説明する。

## 状態・再送・複数集約

返された操作は`operations` / `replayOperations`でApplicationへ登録できる。
状態・購読・viewはApplicationが管理し、businessは業務操作の実行契約を担う。

再送を有効にするには`replay.lookup`・`resolveAfter`と、原子的に保存した`Execution`を返すsaveが必要。
認証済みactor・入力・操作IDの照合、競合、receiptの永続化はadapterの契約。
操作IDの移行には`operation: name => 既存ID`を指定できる。
同じIDで意味の異なる操作を扱わないことは利用者の責務。

保存先・成功値の異なる集約は別のbusinessに分け、[Processで接続する](business-composition-study.md)。
Process自体は全体transactionや永続的な再開を提供しない。
複数の取得からloadの入力を組む場合は、[effectの成功値投影](effect-projection.md)で
前のcontextと取得成功値から次の入力を構築でき、Resultの取り出しと失敗停止を委譲できる。
[購買25操作への適用](procurement-framework-context.md)では、比較側の手続き型loaderと分けて検証している。

## 既存APIとの関係

新規の共通load/saveを持つ業務操作群にはbusinessを推奨する。
業務の中心は通常の関数と型であり、validate/require/evolveの分類を必須にしない。
[共通のgeneric検証](business-generic-checks.md)も、具体的な入力型をそのまま返す契約を検査できれば、
操作ごとの型引数やResult接続のラッパーなしで関数列へ置ける。任意の多相変換の型適用とは区別する。
[接続の診断](business-diagnostics.md)は、操作名と関数配列の位置を示す。診断用の属性を関数へ付ける必要はない。
既存のdefineUseCaseGroup / defineTransitionは互換のため維持し、既存宣言の即時移行は要求しない。
純粋な計算だけの合成にはworkflow、I/Oの区間にはProcessを使う。

[経費・休暇での移行と型検査の記録](business-api-study.md)、
[仕様変更の比較](business-change-study.md)を参照。
大規模組織での生産性・バグ率改善や、独立した開発者の習得の容易さは未実証。
アルファAPIのため変更可能性は残る。

状態Unionを分岐ごとの関数へ接続する場合は、[型ガード付きWorkflow.branch](typed-branch.md)を利用できる。
通常のswitchをRule内に書く方式も選べる。非同期I/OはProcessの境界へ置く。

既存Workflowを通常関数として再利用する場合は、runをそのまま登録できる。
[配布後の入力型の保証範囲](workflow-input-contract.md)を参照。

段階に業務上の名前を付ける場合は、既存の`step(name, rule)`も配列へ置ける。
[名前付き段階](business-named-stages.md)では、普通の関数との混在、trace・観測・構造図への反映と、
具体的な文脈を注釈したwithInputをinlineで置ける範囲を説明する。
