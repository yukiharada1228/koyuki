# 承認ルールが増えた場合の変更比較

休暇の「pendingを管理者が承認する」処理へ、**承認できる申請は2日以内**というルールを追加した。
これは評価用の仕様変更であり、公開サンプルの通常の業務仕様を変更したものではない。
一時的な独立consumer上で実際に型検査と実行を行い、変更前後のSHA-256・diffを出力する。

```sh
npm run test:business:change
```

このコマンドは実際の開発版をpackして独立consumerへインストールし、既存仕様と詳細effectの34テストを通した後、
一時ディレクトリへ新仕様を適用する。npm公開物・サンプルDBを変更しない。
初期検証ではprivate候補パッケージを使ったが、businessの開発版への昇格後はルートexportを検証する。

## 型による変更漏れの発見

追加した純粋関数は次の契約を持つ。

```ts
requireApprovalLimit: Approval => Result<LimitedApproval, ApprovalLimitExceeded>
approve: LimitedApproval => Result<Change, never>
```

LimitedApprovalにはApprovalと異なる非公開のunique symbolを持たせた。
2日以下かを検査したときだけ、その証拠を付ける。承認関数の入力をLimitedApprovalへ変更し、
新しい失敗理由をRuleErrorへ追加した直後に、未修正の接続をコンパイルしている。

以下の4方式はいずれも型エラーになった。

| 方式 | 修正した業務接続 |
| --- | --- |
| 普通のTSでResultを分岐 | 制限検査を呼び、失敗時に返す分岐を追加。成功値をapproveへ渡す |
| TSと小さなchain helper | `chain(chain(validateApproval(input), requireApprovalLimit), approve)` |
| 既存の名前付き遷移 | `require: [step('approval-limit', requireApprovalLimit)]` |
| business試作 | `approve: [validateApproval, requireApprovalLimit, approve]` |

各方式で必要なのは、同じドメインの変更と、その関数のimport・接続箇所の変更である。
普通のTSでも型付きの証拠と関数シグネチャを使えば漏れを検出できる。
この結果から「Koyukiだけが接続を型安全にできる」「TS helperでは実現できない」とは評価しない。
型アサーション等による迂回や、制限検査そのものの仕様誤りをコンパイラが防ぐわけでもない。

## 業務以外の変更

HTTPのエラーコード表がRuleErrorに対して網羅的なので、新しい失敗理由の未対応も型エラーになった。
`ApprovalLimitExceeded: 422`を追加して修正した。
GraphQLは既存のLeaveFailure.codeで表現できるため、schema・resolverを変更していない。
Applicationのviewも、既存のfailedとerror.kindで表現できるため変更していない。
repository・GraphQL・serverのソースが変更前と一致することをスクリプトでも確認する。

比較全体の変更ファイルはdomain.ts、application.ts、application-named.ts、approval-baselines.ts、http.tsの5つ。
これは比較用の実装を同時に置いた場合の件数で、各方式で5ファイルの修正が必要という意味ではない。
TSの2方式は**純粋な承認判断のみ**の比較であり、Koyukiと同等の再送・HTTP・Application基盤を
通常TSで構築するコストまで測っていない。コード量の総合的な勝敗や生産性の点数へ変換しない。

## 実行時の確認

変更後の専用5テストで次を確認した。

- 2日・3日の境界、本人による承認、対象なしで4方式のResultが一致し、元の入力を変更しない。
- RESTでは3日の承認を422で返す。traceは制限検査で止まり、状態変更・承認receiptを残さない。
- GraphQLは新しい失敗codeを返す。2日の申請は引き続き承認でき、既存宣言でもreplayできる。
- Applicationは最新のaccountを維持し、failedと新しいerror.kindを公開する。
- 仕様変更**前**に実際に保存した3日の承認は、仕様変更後もhistorical successとしてreplayする。
  再送で新しい規則を再実行せず、変更履歴・receiptが増えない。

最後の動作は意図した再送契約である。過去の成功の再取得と、新しい業務要求の可否は区別する。
過去の結果へのアクセスまで取り消す仕様であれば、認証・認可やreceipt閲覧方針を別に変更する必要がある。
単に新しいruleを差し込むだけで、保存済みreceiptにもそのruleが適用されるとは主張しない。

## 得られた判断

今回の新APIは、業務ルールの追加を関数配列の1要素として表せる。
既存APIもrequireへの1要素追加、helper版も合成1箇所の変更で済んだ。
この小さな変更において、新APIが修正範囲を大幅に減らすという証拠はない。
役割名を覚えず普通の関数を並べられることは設計上の違いだが、読みやすさや学習時間は未測定。
接続の型保証・実行時の失敗停止・再送契約を保ったまま、利用者向け記法を簡単にできることを確認した段階である。

[認可エラー追加の比較](authorization-change-study.md)も追加した。
成功型の証拠を変える変更とは異なり、今回は既存の接続を維持し、HTTPの未対応エラーを型検査で検出した。
GraphQLのString型コードと、権限停止後の過去receiptの読取りは別の保証として記録する。
