# 成功した業務変更の共通監査記録

開発版の`auditRecord`は、タグと経費で共通の`koyuki.audit.v1`形式を作る。
診断traceや状態そのものの履歴とは別の記録で、操作ごとのログ接続を業務関数へ書く必要はない。
SQLiteサンプルでは、保存アダプターが状態・履歴・receiptと同じtransaction内で監査行を追加する。

## 記録する情報

| フィールド | 出所 |
| --- | --- |
| schema | coreが固定する形式version |
| operation | adapterが定める操作名（tag.create.v1、expense.approve.v1等） |
| actorId | 認証済み操作者の識別子をhostが注入 |
| operationId | hostがその要求へ割り当てるID |
| definitionVersion | hostが固定する業務定義のversion |
| occurredAt | hostが渡すUTCのISO日時 |
| targetType / targetId | 保存adapterが特定する変更対象 |
| beforeVersion / afterVersion | 保存時の旧・新version。初回作成の旧versionはnull |

識別子は1–200文字、前後空白なし。日時は`Date.toISOString()`と一致する形式。
versionは安全な整数で、通常の更新では旧version + 1を検査する。
recordは許可したprimitiveフィールドだけを新しいオブジェクトへ選び、freezeする。
金額、タグ名、却下理由、認証トークン、入力payload、例外は追加しない。
識別子へhost自身が機密情報を埋め込むことまでは防げない。actorId/targetIdも管理対象のデータである。

## 保存への接続

```ts
// SQLite adapterはサンプル側の実装。core npmへDB driverを含めない。
const requestAudit = Object.freeze({
  actorId: authenticated.id,
  operationId: validatedRequestId,
  definitionVersion: 'expenses-policy.2026-11',
  occurredAt: new Date().toISOString(),
});
const repository = new ReplaySqliteExpenses(path, {
  audit: { identity: () => requestAudit },
});
```

`authenticated`はhostで認証済みのidentity、`validatedRequestId`はhostが検査・割当てた要求ID。
repositoryとそのmetadataは要求単位で所有し、処理終了後は接続をcloseする。
同じ要求IDで同じ対象の別変更を実行しない。新しい操作には新しいIDを使う。
既存接続を共有するhostは、callbackが現在の要求の正しいidentityを返す仕組みを別途提供する。
**全リクエストで一つの可変globalな操作者変数を共有しない。**

業務用のActorも同じ認証結果から注入する。coreは認証を実施したり、actorIdとdomainの権限を自動照合したりしない。
業務入力内のactorId等はaudit identityへ採用しない。identity callbackは操作名だけを受け取り、入力を自動で渡されない。

実装は[共通SQLite記録器](../src/adapters/sqlite-audit.ts)、[タグ](../src/tags/sqlite.ts)、
[経費](../src/expenses/sqlite.ts)、[経費receipt](../src/expenses/sqlite-replay.ts)。
タグは作成・更新・archive・restore、経費は初回draft作成・submit・approve・reject・return・editを対象にする。
タグのgroup初期データやDB schema作成は業務変更の監査対象に含めない。

監査は新規DBでは任意。有効化すると`koyuki_audit`表を作り、その後のadapter経由の新しい変更にはidentityが必要になる。
設定なしで開き直した接続や、有効化前から開いていた接続でも、保存transaction内で表の存在を確認して更新を拒否する。
参照と既存receiptの取得は許可する。有効化前の過去の変更を自動で補完・認証しない。

## 原子性と再送

- 監査の作成・INSERTが失敗したら、状態・状態履歴・receiptもrollbackする。
- 経費receiptのINSERTが監査後に失敗した場合も、監査を含めてrollbackする。
- 成功receiptの再取得では状態を書き直さず、監査も追加しない。
- `(operationId,targetType,targetId)`と`(targetType,targetId,afterVersion)`をDBで一意にする。一つの操作が複数の対象を変更する余地を残す。
- operationId重複を監査表だけで安全な再送へ変換しない。receiptなしの競合した保存は失敗する。
- 業務規則で拒否した操作を成功監査へ記録しない。拒否・不正アクセス等の別ログは別契約。

同じ接続のローカルtransactionに限る。別DBへのログ配送や、外部監査サービスへの原子性は提供しない。
commit結果が不明な場合は、[保存境界の契約](transactions.md)に従い、勝手に再試行しない。

## 保持・削除と改ざん耐性

既定は自動削除なし。coreは保存期間、削除ジョブ、外部保管を設定しない。
運用hostが対象データの要件に基づいて保持期間を決め、削除・バックアップ・復元・閲覧権限を管理する。
receiptの保持と監査の保持は同じではない。監査行を削除しても再送可能性や同じoperationIdの再利用を保証しない。
監査を無効にする目的で表を削除する運用は提供しない。

このSQLite例には暗号署名・hash chain・WORM・別権限の保管先はない。
通常のadapter書込みでは記録漏れと重複を防ぐが、SQLを直接実行できる利用者によるDELETE/UPDATE/DROPを防げない。
従って、改ざん検出や外部第三者による真正性の保証はない。
高い保持・改ざん耐性が必要な運用への完成済み基盤とは扱わない。

## 検査と現在の範囲

[core検査](../src/audit.test.ts)は形式・余分なpayloadの除外・immutableな結果を検査する。
実tarballのconsumerと、Node globalなしのブラウザーbundleでも使う。
[SQLite検査](../src/sqlite-audit.test.ts)は、同一形式、入力による操作者の偽装を採用しないこと、
全操作の成功記録、監査/履歴/receipt障害でのrollback、再送での非重複、
別接続の競合、2つのOSプロセスによる同一要求の同時再送、identity不足による更新拒否を検査する。

[Issue #5](https://github.com/yukiharada1228/koyuki/issues/5)に対するSQLite実例の実装。
他DBの監査adapter、保持・削除の実運用、改ざん耐性、拒否ログ、全Application実行との相関は未実装・未検証。
これを講演の全内容や業務実行全体の監査の完成とは扱わない。
