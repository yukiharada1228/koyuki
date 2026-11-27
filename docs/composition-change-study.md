# 業務部品の合成による仕様変更の試用

2026-11-27。AIによるコード追加・検証であり、人間の初回利用評価や開発時間の比較実験ではない。

## 変更した仕様

既存の日程変更に「このリクエストの実行権限があること」を追加する。予約の所有者・変更期限・状態の検証は既存の純粋関数に残す。権限取消し後は、過去の成功要求の再送にも応答を返さない。通知ハンドラーは実行者の権限とは別の処理として登録し、保存済みイベントを処理する。

実装例は`src/authoring-rescheduling.test.tsx`の`composed access policy can revoke receipt access without changing rescheduling, storage or notification wiring`。同じツリーを既存の`createApplicationTemplate`で再利用する。

```tsx
const template = createApplicationTemplate(<Fragment>
  <Guard useCheck={() => {
    const allowed = useContext(Permission);
    return () => allowed ? ok(undefined) : err('ReschedulingDisabled');
  }}>
    <ReschedulingBusiness repository={repository} clock={() => now} noticeHours={24} />
  </Guard>
  <ReschedulingNotifications sender={sender} />
</Fragment>);

const session = template.scope(children => (
  <ActorContext.Provider value={authenticatedActor}>
    <Permission.Provider value={requestPermission}>{children}</Permission.Provider>
  </ActorContext.Provider>
));
```

`Permission`は`createContext<boolean>()`で業務側が定義する。認証と権限の取得はホストが担当し、本文からの自己申告で置き換えない。booleanは要求時点のスナップショットであり、外部の権限変更を自動購読するものではない。

## 何を書かずに済んだか

| 対象 | 今回の変更 |
| --- | --- |
| 純粋な状態遷移・所有者検証 | 変更0 |
| 既存Operation・Resource | 変更0 |
| メモリ・SQLiteの保存アダプター | 変更0 |
| 再送lookup・成功記録の保存 | 変更0 |
| 通知の接続・payload | 変更0 |
| フレームワークの公開API | 追加0 |
| アプリケーション構成 | 権限Contextを1つ定義、Guardを1箇所追加、Actorと権限をscopeで供給 |

これはこの変更で触らなかった対象の記録で、通常のTypeScriptとのコード量・速度の優位を測定したものではない。通常のTypeScriptでも共通ラッパーは書ける。Koyukiでは登録済みハンドラー・再送・イベントを含む既存の実行境界へ同じGuardを適用できることを確認した。

## 機械的に確認した結果

1. 構成時のlookup・load・save・通知はすべて0。
2. 許可された所有者の初回要求ではlookup・load・save・通知が各1。
3. 権限のない別scopeで同じ要求を送るとExecutionDenied。4種類のカウンターはいずれも増えない。
4. 許可scopeで同じ要求を再送するとreplayed。lookupだけ1増え、load・save・通知は増えない。
5. 権限を持つ別の操作者が別requestIdで変更を要求しても、業務関数がForbiddenを返す。保存・通知は増えない。

既存の日程変更テストは同時更新、SQLiteの原子的な保存とrollback、DB再接続、応答喪失、永続イベントの再配送も検証する。今回の追加例自体はメモリ版であり、権限ストアの分散整合性や本番認証を検証したとはしない。

## 残る手書きと判断

実行権限をどこから得るか、どの部品へ適用するか、通知側にも同じ権限を要求するかは利用者が定義する。今回通知をGuardの外へ置くのは、保存済み業務の通知を操作者の権限取消しで止めないという選択である。全体をGuardで包めば同じ意味になるわけではない。

Guard拒否は型付き業務Resultに混ざらずExecutionDeniedでrejectする。HTTP変換は利用側に残り、配送記録と実行通知でもdeniedとなり、想定外の不具合のdefectと区別する。権限のスナップショットと保存の間に権限が変わる競合まで防ぐには、保存境界での再確認など別の契約が必要。

今回、新しい構文やResource並列化は追加していない。取得待ち時間の計測なしに並列化の価値を主張せず、失敗後に実行されるI/Oの増加も自動で持ち込まない。

## 検証コマンドと結果

- `npm run check`: 成功。
- `npx tsx --test src/authoring-rescheduling.test.tsx`: 11テスト成功。
- `npm test`: 全1320テスト成功。
- `npm run test:connections:package`: 公開importの44実行テスト成功。TypeScript 7.0.2 / 6.0.3で型検査・宣言生成・宣言consumerと型精度の負例を検査。
- `git diff --check`: 成功。

今回フレームワーク本体の変更はない。npm公開・リモートCI再実行は行っていない。
