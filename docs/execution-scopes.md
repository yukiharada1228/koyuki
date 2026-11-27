# 実行スコープと業務部品の認可合成（実験API）

`koyuki/experimental`の`createApplicationTemplate`は、操作者を含まない業務ツリーを再利用する入口である。`scope`にProviderを適用する関数を渡し、リクエストごとのApplicationを構成する。共有ApplicationのContextを書き換える機能ではない。各scopeでコンポーネント・Hooksを同期評価し、独立したハンドラーと購読を作る。構成時には業務I/Oを行わない。

```tsx
import {
  h, Guard, createContext, useContext, createApplicationTemplate,
} from 'koyuki/experimental';
import { ok, err } from 'koyuki';

const Actor = createContext<{ id: string; roles: readonly string[] }>();

// Expenses等は既存のOperation宣言を登録する、再利用可能な業務部品。
const business = createApplicationTemplate(
  <Guard useCheck={() => {
    const actor = useContext(Actor);
    return () => actor.roles.includes('admin')
      ? ok(undefined)
      : err('AdminRequired' as const);
  }}>
    <Expenses repository={expenses} />
    <Leaves repository={leaves} />
  </Guard>
);

const session = business.scope(children => (
  <Actor.Provider value={authenticatedActor}>{children}</Actor.Provider>
));
await session.execute(approval, input);
```

この抜粋の業務部品・Repository・操作・入力・認証済みActorはアプリケーション側が定義する。認証自体はホストで行い、リクエスト本文のActorを信頼しない。Providerへ渡す値を共有可変オブジェクトとして後から書き換えず、リクエストごとに所有する値を渡す。

## Guardの契約

`useCheck`は構成時に依存を取得し、実行時の検査関数を返す。検査関数は操作の`name`を受け取り、同期または非同期の`Result<void, E>`を返す。Hooksは検査関数の実行中には呼ばない。複数のGuardは外側から内側へ実行し、最初の拒否で停止する。

Guardは配下で組み立てる操作・Queryのハンドラーを保護する。取得・Workflow・保存だけでなく再送lookupよりも前に毎回検査する。カスタムHook内の`operation.use()`でも保護される。イベント受信側はその宣言を登録した位置のGuardを使い、直接実行・自動配送・永続イベントのdeliverで迂回しない。送信側のGuardを受信側へ暗黙に引き継ぐ仕様ではない。

拒否は`ExecutionDenied`例外となり、`operation`と`reason: unknown`を持つ。業務ResultのエラーUnionへ隠れて追加しない。`execute` / `executeDetailed`はrejectするため、HTTP境界などで明示的に扱う。イベント配送ではdenied配送記録に入り、送信元の成功Resultを取り消さない。実行通知でもdeniedとして観測され、想定外の不具合のdefectと区別される。

Guardはサービスの入口のポリシーであり、純粋な業務関数の所有者検証・状態検証を代替しない。信頼したアプリケーション構成を前提とし、任意コードに対するサンドボックスではない。純粋関数やRepositoryを直接呼べばこの入口は通らない。Guard自身がI/Oを行う場合、そのI/Oまでゼロになる保証はない。

## 再送・監査との関係

認可を毎回検査するため、権限を失った操作者は過去の成功receiptにもアクセスできない。許可された呼び出しの再送契約、保存後のイベント配送、通知失敗時の業務結果保持は従来どおりである。

監査の永続保存を自動追加する変更ではない。既存の実行・配送購読を利用できるが、監査先の障害で保存済み結果を失敗へ変更しないことと、監査を確実に残すことは別の契約である。

## 検証

`src/authoring-scope.test.tsx`で、並行スコープの操作者分離、拒否時のlookup/load/save停止、イベント経由の保護、保存済み結果の保持、入れ子Guard、カスタムHook経由の保護を検証する。このテストを`test:connections:package`にも含め、公開import経由で実行する。既存の接続・再送・SQLite・view検証も同時に維持する。

このAPIは実験版。既存`createApplication`はそのまま利用できる。固定ProviderのApplicationを共有する方法と、リクエストごとにscopeを作る方法を混同しない。コンパイル済みの単一ハンドラー群を操作者間で使い回す最適化は行っていない。

2026-11-27の検証: 型検査・全1319テスト成功。公開importだけの配布物検証は43テスト成功し、TypeScript 7.0.2 / 6.0.3で型検査・宣言生成・宣言consumerを確認した。実行時依存ゼロ、31ローカルJSモジュール、Node型なしの宣言、Nodeグローバルなしのブラウザ実行を維持した。リモートCIとnpm公開は実施していない。

[既存の日程変更へ権限を追加した試用](composition-change-study.md)では、業務関数・Operation・保存・再送・通知の接続を変更せず、Guardの構成で追加できた範囲と残る判断を記録している。


## 記録形式の変更

認可拒否の実行完了通知・配送記録は`defect`から`denied`へ変更した。`execute`のrejectと`ExecutionDenied`自体は維持する。statusのUnionを網羅するconsumerはdeniedを追加する必要がある。保存失敗や業務拒否のResultをこの例外へ変換していない。
