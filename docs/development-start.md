# 開発版で最初の業務アプリケーションを書く

開発版の入口はbusinessである。通常のTypeScript関数で状態・検証・遷移を書き、loadとsaveを宣言する。
実行状態とviewも必要な場合に、defineApplicationとoperationsを加える。
公開済みnpm alpha.5にはbusinessが含まれないため、この手順はソースからpackした開発版を使う。
公開版から始める場合は[alpha.5向けチュートリアル](getting-started.md)を参照する。

開発版の宣言は[TypeScript 6.0.3と7.0.2のconsumerで検査](typescript-compatibility.md)している。
以下の手順ではリポジトリと同じ7.0.2を固定して使う。

## 別のプロジェクトへ準備する

Node 26と、このリポジトリの依存を使う開発手順である。
リポジトリのルートから、存在しない新しい作業フォルダーを作る。
次の例はmktempで新しいフォルダーを作り、既存プロジェクトへ上書きしない。

```sh
npm ci
npm run build
koyuki_app=$(mktemp -d "${TMPDIR:-/tmp}/koyuki-first-app.XXXXXX")
npm pack --ignore-scripts --pack-destination "$koyuki_app"
cd "$koyuki_app"
npm init -y
npm pkg set type=module
npm install --ignore-scripts --no-audit --no-fund ./koyuki-*.tgz
npm install --save-dev --ignore-scripts --no-audit --no-fund typescript@7.0.2 tsx@4.23.15
```

npmへ公開する操作はない。作成先はecho "$koyuki_app"で確認できる。
tarballのversion表記がalpha.5でも、ここでpackした開発版とregistryのalpha.5は内容が異なる。
このフォルダーで次のapp.tsとtsconfig.jsonを作る。

## app.ts

承認待ちと承認済みを直和で分ける。操作者は取得adapterの外から注入し、要求の入力には含めない。
検証は権限・版・状態を確認し、遷移関数は承認待ちの値だけを受け取る。

```ts
import { business, defineApplication, operations, ok, err, type Result } from 'koyuki';

type Base = Readonly<{ id: string; ownerId: string; amount: number; version: number }>;
type Submitted = Base & Readonly<{ kind: 'submitted' }>;
type Approved = Base & Readonly<{ kind: 'approved' }>;
type Expense = Submitted | Approved;
type ApprovalInput = Readonly<{ id: string; expectedVersion: number }>;
type Actor = Readonly<{ id: string; role: 'manager' | 'employee' }>;
type Context = Readonly<{ input: ApprovalInput; current: Expense; actor: Actor }>;
function validateApproval({ input, current, actor }: Context): Result<Submitted, 'Forbidden' | 'InvalidInput' | 'Conflict' | 'WrongState'> {
  if (actor.role !== 'manager' || actor.id === current.ownerId) return err('Forbidden');
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) return err('InvalidInput');
  if (input.expectedVersion !== current.version) return err('Conflict');
  if (current.kind !== 'submitted') return err('WrongState');
  return ok(current);
}
function approve(value: Submitted): Result<Approved, never> {
  return ok({ ...value, kind: 'approved', version: value.version + 1 });
}

// Host adapters for this in-process example.
const initial: Submitted = { id: 'expense-1', ownerId: 'employee-1', amount: 100, version: 1, kind: 'submitted' };
const actor: Actor = { id: 'manager-1', role: 'manager' };
const stored = new Map<string, Expense>([[initial.id, structuredClone(initial)]]);
let saves = 0;
async function load(input: ApprovalInput): Promise<Result<Context, 'NotFound'>> {
  const current = stored.get(input.id);
  return current ? ok({ input, current: structuredClone(current), actor }) : err('NotFound');
}
async function save(value: Approved): Promise<Result<Approved, 'Conflict'>> {
  if (stored.get(value.id)?.version !== value.version - 1) return err('Conflict');
  stored.set(value.id, structuredClone(value)); saves++;
  return ok(value);
}
const expense = business({ name: 'expense.v1', load, save,
  operations: { approve: [validateApproval, approve] },
});
// HTTP handlers may call expense.approve(input) directly.
const application = defineApplication({
  initial: (): Expense => structuredClone(initial),
  operations: operations(expense, (_state: Expense, value) => value),
  view: state => ({ expense: state.data, busy: state.kind === 'running',
    error: state.kind === 'failed' ? state.error : state.kind === 'crashed' ? 'UnexpectedException' : null }),
});
const session = await application.start();
const phases: string[] = [];
session.subscribe(snapshot => { phases.push(snapshot.state.kind); });
await session.dispatch({ type: 'approve', input: { id: 'expense-1', expectedVersion: 1 } });
if (session.snapshot().view.expense.kind !== 'approved' || saves !== 1
  || phases.join(',') !== 'ready,running,ready') throw Error('Approval did not complete');
await session.dispatch({ type: 'approve', input: { id: 'expense-1', expectedVersion: 1 } });
if (session.snapshot().view.error !== 'Conflict' || saves !== 1) throw Error('Stale input was not stopped');
const blocked = await session.dispatch({ type: 'approve', input: { id: 'expense-1', expectedVersion: 2 } });
if (blocked.ok || blocked.error.kind !== 'UnexpectedMessage') throw Error('Failure must be dismissed');
await session.dispatch({ type: 'dismiss' });
if (session.snapshot().state.kind !== 'ready' || saves !== 1) throw Error('Dismiss must not retry');
console.log(session.snapshot().view);
```

## tsconfig.jsonと実行

```json
{
  "compilerOptions": {
    "target": "ES2022", "module": "NodeNext", "moduleResolution": "NodeNext",
    "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true,
    "types": [], "lib": ["ES2022", "DOM"]
  },
  "files": ["app.ts"]
}
```

```sh
npm exec -- tsc
npm exec -- tsx app.ts
```

最後に、承認済み・version 2のexpense、busy: false、error: nullが表示される。
失敗した要求の後はdismissだけを受け付け、dismissは再保存せず表示上の失敗を解除する。
その後の実行には新しいdispatchが必要になる。

## 利用者が決めること

| 利用者が書くもの | runtimeへ任せるもの |
| --- | --- |
| 状態Union・validateApproval・approve | 型の接続、最初のResult失敗での停止 |
| 認証済みactor、loadとsave | load→業務関数列→saveの実行 |
| 保存成功後のデータ更新とview | ready/running/failed/crashed、購読通知 |

approveだけをoperationsへ並べても、このloadはContextを返すため型が接続しない。
ただし、権限判定の内容や検証関数自体の正しさまで型で証明するものではない。
[検証済みのprivateな証明](business-generic-checks.md)、[入力を残す接続](workflow-context-inference.md)は必要になってから参照する。
役割別のvalidate/require/evolveや、stepの命名はこの例では不要である。

この保存例は単一プロセスのMapであり、DBの原子保存・永続再送・未知のcommit結果への対応は含まない。
実際の入力のruntime検証、認証、競合制御、トランザクションはhostの契約として設計する。
HonoなどのHTTP層はこの業務宣言の外へ置く。

本文のTypeScriptは実tarballのconsumerで型検査・実行し、@types/nodeなしの宣言検査も行う。
これは保守者の再現検査であり、[独立利用者の課題](../examples/onboarding/README.md)の試用結果ではない。
