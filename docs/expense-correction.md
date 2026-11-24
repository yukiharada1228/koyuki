# 差し戻し・修正・再申請で検証したこと

alpha.2の実例。フレームワークの追加変更なしで、既存の経費精算に2操作を追加した。
再申請は既存のsubmitを再利用する。却下は終端のままにし、差し戻しを別の状態にした。

| 入力状態 | 操作 | 成功状態 | 主な失敗 |
| --- | --- | --- | --- |
| manager / finance | return | returned | 自己承認・権限不足・理由なし |
| returned | edit | draft | 所有者以外・無効な金額 |
| draft | submit | manager / approved | 権限不足・領収書など既存ルール |
| rejected / approved | edit | なし | InvalidState |

修正は金額と領収書の有無を変更する。修正後は改めて申請が必要。
再申請では承認経路を計算し直すので、少額への修正で自動承認になる場合もある。

## 追加した宣言

[実装](../src/expenses/application.ts)では、業務関数を次の形で登録する。

```ts
export const returned = {
  validate: step('authorize-return', validateRejection),
  require: [] as const,
  evolve: step('return', returnForCorrection),
};
export const edited = {
  validate: step('validate-edit', validateEdit),
  require: [] as const,
  evolve: step('edit', edit),
};
```

純粋な関数は取得済み状態・信頼済みActor・業務入力を受け取り、Resultで判断を返す。
検証済み入力にはbrandがあり、未検証のLoadedをeditへ直接渡すと型エラーになる。
TypeScriptのエラーにはbrandやStepの型も現れる。診断文の分かりやすさは改善の余地がある。

## 再利用できたもの、追加が必要だったもの

- 検証→遷移→保存、Resultの短絡、traceとplan、実行中／失敗状態は既存runtimeを再利用。
- 元の要求と保存の接続はdefineRequestTargetを再利用。要求ごとのclosureは利用側で不要。
- 事前照会、保存競合後の再照会、過去の結果でViewを巻き戻さない処理も既存APIを再利用。
- 操作名と入力型、onによる遷移の登録、Applicationの操作登録は利用側で追加。
- 状態の復元検証、許可する保存前後の組み合わせ、fingerprintへの修正項目の追加はアダプター／ドメイン側で必要。

単に2つの純粋関数だけを足せば永続化まで対応できるわけではない。
保存境界は、DBから復元した値の検証と競合制御を担うため、業務状態の追加に追従する。
操作登録の繰り返しは残るが、異なる入力型と業務名を明示する小さな宣言であり、今回新しい自動登録APIは追加していない。

## versionと申請の周回

以前のモデルは状態と絶対versionを結び付けていたため、再申請できなかった。
versionは全操作で単調増加させ、修正後のdraftにdraftVersionを記録する。
復元時は現在の申請周回で何段階目かを検証する。旧データはdraftVersion省略を1として扱う。
旧3操作のfingerprintの計算形式は維持し、既存の成功記録を無効にしない。
申請周回の情報は業務モデルに属し、フレームワークには追加していない。

## 保存と検証

SQLiteは更新・変更履歴・成功記録を同一トランザクションに保存する。
CASには全体のversionを使う。修正が競合したら一方だけ保存し、成功記録の保存失敗でも全体をrollbackする。
メモリアダプターは単一プロセス用で、分散・DBトランザクションの代わりではない。

検証した内容：通常Applicationとメモリ保存、SQLiteと再送、財務からの差し戻し、複数周回、
承認経路の再計算、権限・入力・終端状態の拒否、修正内容の異なるキー再利用、
競合、rollback、再オープン、純粋関数の不変性、型による未検証呼出しの拒否。

## ローカルで試す

Node.js 22以上でリポジトリをcloneした後：

```sh
npm ci
npm run check
npm run demo:expenses:correction
npm test
```

デモは一時SQLiteを作り、申請→差し戻し→修正→再申請→過去の修正の再送を実行し、終了後に削除する。
APIの一般的な導入は[再送境界の説明](replay.md)を参照。
defineRequestTargetなどの新APIはnpmのalpha.2に含まれる。
