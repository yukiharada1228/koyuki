# 休暇の承認前提を型へ残す

React風の組み立てを追加した後、講演の「状態・検証・遷移」と現行モデルを再照合し、休暇の例の認可前提が不十分だったことを確認した。

基準はa15c936af4a8d21475f2bf8956969df0a2119402。旧approveLeaveはcurrentがpendingであることだけを型で要求し、actorは一般のActorだった。元ファイルを一時的な同階層のprobeとして読み込み、認可を省いたWorkflowへinactiveな本人を渡すと、型検査が通りapprovedを返すことを実行で再現した。probeは検査後に削除し、元ファイルやユーザーの未追跡ファイルは変更していない。

旧ファイルへ追加して再現した式は次の形だった。

```ts
workflow('approval-without-authorization', approveLeave).run({
  current: { kind: 'pending', id: 'leave-1', owner: 'owner', days: 2 },
  actor: { id: 'owner', role: 'employee', active: false },
});
```

これは全アプリの認可が破られていたという意味ではない。通常のleaveDecisionは認可を呼んでおり、従来の成功・失敗テストも通る。問題は、状態をpendingだけに限定したloadなどから認可を省略しても、型による接続検査では検出できなかったことにある。

## 状態と失敗の条件

| 入力状態 | 操作者・操作 | 成功状態／想定失敗 |
| --- | --- | --- |
| pending | activeなmanagerが他人の申請を承認 | approved、byは検証したmanagerのID |
| approved | 承認 | AlreadyDecided |
| pending | 本人が承認。roleやactiveとは独立 | SelfApproval |
| pending | inactiveな他人が承認 | Forbidden |
| pending | manager以外の他人が承認 | Forbidden |

拒否の優先順位は、状態 → 本人 → active/role。既存の挙動を維持する。休暇申請の作成・日数検証・変更等はこの小例の操作には含めていない。

## 純粋な業務関数とI/O

[leave-domain.ts](../src/experiments/react-business/leave-domain.ts)へ状態型と純粋関数を分離した。

- authorizeLeaveは状態・本人・active・roleを検証し、成功した場合だけAuthorizedLeaveを返す。
- AuthorizedLeaveは非公開のunique symbolによる認可の証明を要求する。actorはLeaveApproverとしてrole:manager・active:trueを型にも残す。
- 検証したcurrentとactorの宣言済みスカラー項目をコピーしてfreezeする。呼出し元の後の変更で、取得済みの認可文脈が変わらない。
- approveLeaveはAuthorizedLeaveを受け取り、新しいApprovedLeaveを返す。元のpendingを書き換えない。

[leave.tsx](../src/experiments/react-business/leave.tsx)は業務関数の合成、Repositoryのload/save、Provider・Hook・Operationの組み立てを担当する。新しいフレームワークAPIは追加していない。既存の型名は同じ入口から再exportし、経費と同じuseOperationを使う。

HTTP側は認証済みidentityを注入し、保存側は競合条件を守る責務を引き続き持つ。brandの存在だけで検証関数の実装内容が正しいと判定することはしない。

## 検証の役割を分ける

[専用テスト](../src/authoring-leave-domain.test.ts)で、各拒否条件・優先順位・元の値の非変更・認可文脈の所有を確認する。型検査では、全ての公開フィールドが正しいcontextであっても、認可の証明がなければ承認へ渡せないことを確認する。roleやactiveの不一致で偶然拒否されたケースを、証明の検査には使わない。

実tarballのTypeScript 6/7検査にも同じ省略の拒否を入れ、生成宣言だけを読むconsumerでmanager/activeの型を確認する。保存までの通常のHook実行も従来どおり動く。

二つの対照を別々に実行する。

1. 型から認可の証明だけを取り除く。公開フィールドは正常のまま、直接呼出しとpending専用loadからの省略が通るようになり、二つの拒否テストが検出力を失うことを確認する。
2. 自己承認の条件だけを実装から取り除く。型検査は成功するが、activeなmanager本人の承認が許可され、業務仕様に基づいた実行検査が失敗することを確認する。

型の接続と業務仕様テストの役割を区別するための検査であり、実装の返却値から期待仕様を作っていない。これは保守者のAIによる点検・再現・修正であり、独立した人間の利用者評価や原音確認の代わりにはしない。講演全体の完成という判定は変更しない。
