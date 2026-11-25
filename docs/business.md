# 通常の関数で業務操作を宣言する

開発版の推奨入口。公開済みnpm `0.1.0-alpha.5`にはまだ含まれない。
ソースからビルドした配布物では`import { business } from 'koyuki'`で利用できる。

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
- `load`は要求から業務関数の入力を取得する非同期Result関数。
- `operations`は業務名と、同期Result関数の空でないtuple。成功値を順に渡す。
- `save`は最後の成功値を保存する非同期Result関数。操作群で同じ保存契約を共有する。
- 宣言時にI/Oは実行しない。`expense.approve(input)`と`.run(input)`は同じ実行入口。
- `.runDetailed(input)`は既存commandの詳細reportを返す。通常のtrace名は`run:1`等の位置。
- `.runDetailed(input, capture)`で、load・Rule・save・再送照会から選んだ値を[観測できる](workflow-observation.md)。観測失敗は業務結果から分離する。
- 最初の失敗で後続とsaveを止める。予期しないthrow/rejectionは伝播し、Resultへ自動変換しない。

操作ごとの入力が異なる場合は`{ load, run: [...] }`を指定する。
共有generic loaderから、個別操作の入出力の相関を自動復元する保証はない。
空配列・asyncルール・隣接型の不一致・saveに渡せない最終出力は拒否する。
voidの検証結果から元の入力を暗黙に復元しない。必要な値は関数の戻り値で表す。
`then`という操作名はthenableとの衝突を避けるため予約する。

## 状態・再送・複数集約

返された操作は`operations` / `replayOperations`でApplicationへ登録できる。
状態・購読・viewはApplicationが管理し、businessは業務操作の実行契約を担う。

再送を有効にするには`replay.lookup`・`resolveAfter`と、原子的に保存した`Execution`を返すsaveが必要。
認証済みactor・入力・操作IDの照合、競合、receiptの永続化はadapterの契約。
操作IDの移行には`operation: name => 既存ID`を指定できる。
同じIDで意味の異なる操作を扱わないことは利用者の責務。

保存先・成功値の異なる集約は別のbusinessに分け、[Processで接続する](business-composition-study.md)。
Process自体は全体transactionや永続的な再開を提供しない。

## 既存APIとの関係

新規の共通load/saveを持つ業務操作群にはbusinessを推奨する。
業務の中心は通常の関数と型であり、validate/require/evolveの分類を必須にしない。
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
