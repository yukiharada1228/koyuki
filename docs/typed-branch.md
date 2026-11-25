# 状態Unionを型ガードで分岐する

開発版のWorkflow.branchは、booleanに加えて通常のTypeScript型ガードを受け取る。
各枝へ、絞り込まれた型を入力とするWorkflowをそのまま登録できる。

```ts
import { workflow, ok, type Result } from 'koyuki';

type Found = { kind: 'found'; id: string; version: number };
type Missing = { kind: 'missing'; newId: string };
type Identification = Found | Missing;

const isFound = (value: Identification): value is Found => value.kind === 'found';
const checked = workflow('check-identification',
  (value: Identification): Result<Identification, 'InvalidIdentity'> => {
    const id = value.kind === 'found' ? value.id : value.newId;
    return id ? ok(value) : { ok: false, error: 'InvalidIdentity' };
  });
const decision = checked.branch('customer-exists', isFound, {
  yes: workflow('update', (value: Found) => ok({ kind: 'updated' as const, id: value.id, expectedVersion: value.version })),
  no: workflow('create', (value: Missing) => ok({ kind: 'created' as const, id: value.newId })),
});
```

yesはFound、noはExclude<Identification, Found>、つまりMissingを受け取る。
成功型と失敗型は両方の枝と前段から合成される。branchの入力型を枝の型から逆算しない。
枝の取り違え・追加の未検証条件を要求する枝・booleanしか返さない関数による型の絞り込みは拒否する。
両枝が元のUnionを受け取る従来のboolean形式は維持する。

前段が失敗したらpredicateも枝も実行しない。成功した場合はpredicateを一度評価し、選ばれた枝だけ実行する。
traceにはcustomer-exists:yes/noと実行した枝の段階が残り、captureも選択されたRuleだけを記録する。
Processの途中I/Oから接続する場合も同じWorkflowをthroughへ渡せる。

## 境界

- 型ガードの内容が正しいことは利用者の責任。通常のTSと同様、虚偽のpredicateを型だけで証明・防止できない。
- Excludeは構造的型の除外であり、すべての値の数学的な補集合を計算するわけではない。タグ付きUnionでの利用を基本にする。
- inlineの型ガードは `(value: Identification): value is Found => ...` のように入力型も明示する。
  入力型を省くとoverloadの文脈推論により失敗するケースがある。名前付き関数なら通常の定義をそのまま渡せる。
- 業務上の選択をruntimeが推測するものではない。switchを通常のRule内部に書く方式も引き続き使える。
- 内部switchを自動で別traceへ変換しない。分岐ごとの段階を観測したい場合に、この形式を選ぶ。
- 既存の成功・失敗・I/O実行や保存の契約は変えない。自動再送・transactionは付加しない。

[src/branch-narrowing.test.ts](../src/branch-narrowing.test.ts)で、両枝・失敗停止・観測・
非同期照合後の接続を検査する。実際の開発版tarballをインストールしたconsumerでも実行し、
Nodeの型を読み込まない配布宣言の検査では成功型・失敗型・不正接続の拒否を確認する。

配布宣言の検査では、ソース内のprivate実装型に依存していた入力の検査が弱まるケースが見つかった。
branchの各枝とProcess.throughは、runを関数プロパティとしても要求する契約へ変更した。
そのため、同じ問題のある接続をソース内だけでなくインストール後にも拒否する。
この検査は型ガードの真偽自体や任意の型アサーションを検証するものではない。
