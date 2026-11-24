# 休暇申請：公開済みKoyukiで作った別業務の例

`koyuki@0.1.0-alpha.2`をnpmから取得する独立したサンプル。
フレームワーク本体の変更・ソース内部へのimportは行っていない。

Node.js 22.13以上（`node:sqlite`が必要）。Node.js 26.12.0で検証。

```sh
cd examples/leave
npm ci
npm run check
npm test
npm start
```

作業ツリー外で再現する場合は、ルートで`npm run test:leave:package`を実行する。
一時ディレクトリへこのサンプルをコピーし、lockfileからnpm ciして型チェック・14テスト・デモを実行する。

## 業務の範囲

単一年度の整数日単位の休暇台帳。従業員本人が申請・取り下げ、管理者が承認する。
管理者はこのサンプルでは全従業員を担当する。自分の申請は承認できない。
承認済みの取り下げ、日付や祝日の計算、半休、重複期間、年度繰越は扱わない。
既に取り下げた申請IDは再利用せず、新しいIDで申請する。
実際の休暇制度を規定するものではなく、実行境界を検証する題材。

| 元の状態 | 操作 | 次の状態 | 日数への影響 | 主な拒否 |
| --- | --- | --- | --- | --- |
| 申請IDなし | submit | pending | 仮確保を増やす | 本人以外、無効な日数、残日数不足 |
| pending | approve | approved | 仮確保を消化済みへ移す | 管理者以外、自己承認 |
| pending | withdraw | withdrawn | 仮確保を解放 | 本人以外 |
| approved / withdrawn | approve / withdraw | なし | 変更なし | InvalidState |

`available = granted - pendingの日数 - approvedの日数`。
申請時に残日数を確保するので、承認時にもう一度残日数を取り合わない。
withdrawnは日数計算から外すが、申請の履歴として台帳に残る。

## 定義と実行

- [domain.ts](domain.ts)：状態の直和、検証、requireDays、純粋な遷移と保存値の復元。
- [application.ts](application.ts)：取得・保存の接続、操作登録、再送、View。
- [repository.ts](repository.ts)：SQLite、version比較、成功記録、原子的な保存。
- [leave.test.ts](leave.test.ts)：業務・競合・再送・型の検証。
- [FINDINGS.md](FINDINGS.md)：使って分かった点と残る接続コード。

```ts
export const submitted = {
  validate: step('authorize-submit', validateSubmission),
  require: [step('require-days', requireDays)] as const,
  evolve: step('submit', submit),
};
```

権限確認、残日数の確認、台帳更新の間でResultを手動でつなぐ必要はない。
requireDaysを通過した入力には別のbrandがあり、検証だけ済ませた値をsubmitへ渡せない。
残日数をDBから別途取得する処理はなく、loadした台帳を純粋関数で調べる。

## 保存と実行の契約

従業員一人の台帳を一つの集約として保存する。取得後のversionをCASで比較し、
台帳更新・変更履歴・成功記録を一つのSQLiteトランザクションで確定する。
残日数と申請を別テーブルにして複数集約へ分ける設計は、今回は必要ない。
その代わり、同じ従業員の異なる申請もversion競合する。件数が多い場合の性能検証はしていない。

`withReplay`で要求をcloneし、`defineRequestTarget`で元の要求を保存へ渡す。
同一要求の再送は過去の成功結果を返し、`replayOperation`で現在のViewを巻き戻さない。
キーが同じで入力・Actor・操作が異なる場合はIdempotencyConflict。
キーはこのサンプルではDB全体で一意。テナントなどのスコープは実運用に合わせて設計する。
認証済みActorはホストが注入する。認証と、再送前のアクセス制御は呼出し元の責任。
成功記録があれば業務検証を再実行しないため、このサンプル単体をHTTP公開して認証の代用にはできない。

復元時は残日数の非負、申請IDの一意性、承認者の証跡、状態ごとの操作数とversionの一致を検証する。
保存時は元の台帳の無関係な申請を変えていないことも確認する。
復元検証は許可された履歴全体の証明ではない。成功記録の期限・移行・削除も未実装。

## 検証したこと

14テストで、仮確保・消化・解放、権限・入力・状態の拒否、キー衝突、
別接続で同じversionを読ませた同時申請、同一要求の競合、承認対取り下げ、
成功記録保存失敗のrollback、応答を失ったcommit結果の解決、
過去の再送によるViewの維持、新規プロセスでの成功記録復元、壊れた保存値の拒否、純粋関数の不変性を確認。
型チェックでは残日数確認の省略、入力項目不足、異なる遷移の接続を拒否する。
