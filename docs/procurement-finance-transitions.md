# 財務4操作も検証と状態生成を関数列で宣言する

請求書登録・照合、支払記録・取消を、それぞれ検証と状態生成の2段階へ分けた。
これで購買Applicationの25操作すべてが、複数の業務関数をbusinessの配列で接続する。
新しいframework APIを追加せず、既存の実行エンジンへ接続・失敗の伝播・保存を委譲する。

```ts
const invoices = business({
  // load/saveはhostの既存の取得・保存契約。
  name: 'procurement.invoice.v1',
  load: context.register,
  save,
  operations: {
    register: [checkInvoiceRegistration, registerCheckedInvoice],
    match: { load: context.match, run: [checkInvoiceMatching, matchCheckedInvoice] },
  },
});
const payments = business({
  name: 'procurement.payment.v1',
  load: context.record,
  save,
  operations: {
    record: [checkPaymentRecording, recordCheckedPayment],
    cancel: { load: context.payment, run: [checkPaymentCancellation, cancelCheckedPayment] },
  },
});
```

## 状態と証明

| 操作 | 検証後の現在状態 | 生成する次状態 |
| --- | --- | --- |
| 請求書登録 | placedの注文、請求書未登録 | registeredの請求書と注文の版更新 |
| 請求書照合 | registeredの請求書、関連データと数量・金額の一致 | matchedの請求書 |
| 支払記録 | approvedの請求書、支払未記録 | recordedの支払 |
| 支払取消 | recordedの支払、有効な理由 | cancelledの支払 |

[domain.ts](../src/experiments/procurement/domain.ts)の検証関数は、成功時に同じ入力の参照を返す。
追加の文脈とprivateな値も保持し、現在状態を直和の該当variantへ狭める。
操作ごとに異なるprivateな証明を型へ加え、遷移関数はその証明を要求する。
状態生成段階はResultのエラー型がneverで、検証後に業務エラーを新たに判定することはない。

検証を省略した4つのbusiness宣言は型検査で拒否する。
共通のcheckInvoiceが成功しただけでも、数量・金額まで検証した照合の証明を得たことにはならない。
証明のcastは、検証関数の全条件が成功した境界に限定する。接続を通すためのcastは追加しない。

## 拒否の順序と互換関数

元の権限、対象、版、状態、入力、重複の確認順序を維持する。
特に照合は、現在の請求書の状態を関連注文・入荷の確認より先に判定する。
既存のcheckInvoiceは関連注文の確認が先なので、そのまま共通化すると複数の不正があるときの結果が変わる。
今回の操作ごとの検証は、この順序も保持する。

registerInvoice、matchInvoice、recordPayment、cancelPaymentは、従来の呼び出し口として残す。
これらの互換関数ではcheckのResultを取り出して次へ渡すが、実Applicationは互換関数を呼ばず、検証と状態生成を直接並べる。
plain/helperの比較実装は、それぞれ自身の通常のTypeScript接続を持つ。frameworkのruntimeを呼んで比較を成立させる変更ではない。

## 検証

[追加検査](../src/procurement-finance-transitions.test.ts)は7ケースで、独立した期待保存計画、同時に不正な入力の拒否順序、文脈の参照、状態型、検証省略、共通証明の流用、失敗後の非保存を確認する。
[成功型の検査](../src/procurement-finance-state-types.test.ts)は既存8関数と新しい4遷移関数の成功型を確認する。

4操作のrun:1は検証、追加のrun:2は状態生成となる。成功時のrun:1の選択結果も、保存計画から検証済みの文脈へ変わるため、trace/captureの利用側ではこの段階の違いを扱う必要がある。公開操作の業務結果と保存計画は維持する。

3方式とメモリ/SQLiteの既存シナリオも継続する。対象25操作・成功32回・実保存回数は維持し、登録を2回含む財務5回の実行に新たな境界が各1つ加わる。
そのため成功観測は130から135境界、代表失敗の選択観測は274から279境界へ増える。
I/Oの72位置・178回の例外注入は維持し、例外前に完了する追加段階の観測は入力384回・結果206回となる。
これらは固定した独立の段階期待値を使い、実装宣言から期待値を自動生成していない。

静的な宣言診断は、選択した5ソースで6宣言・25操作ID・56段階名を解決し、診断・未解決とも0。
Application単独では13段階名と未解決43箇所となり、import先の関数まで見たという誤認を避ける。

実tarballのconsumerにも検査をコピーする。財務12関数の次状態型だけをモデル全体へ広げる対照と、4つの証明タグだけを外す対照も実施する。
後者では、検証を省略できないという拒否契約が失敗することを確認する。

## 残る範囲

業務ルール、操作の順序、hostの取得・保存・回復方針は引き続き利用者が宣言する。
全25操作が複数段階になっても、業務判断内の全分岐、互換関数内の接続、任意のgeneric推論を解消したという意味ではない。
独立利用者の評価と原資料の未確認範囲は残し、講演全体は部分充足のままとする。

全体1,185件、TypeScript 6.0.3/7.0.2の配布consumerは各841件、宣言診断47件が成功。新たなcore実行処理・実行時依存は追加していない。
