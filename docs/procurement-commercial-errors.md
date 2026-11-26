# 申請・発注12操作のエラー型を公開結果まで保持する

申請8操作と発注4操作について、ドメイン関数の戻り値に付けていた広いRuleError注釈を外した。
検証や遷移が実際に返すliteralな失敗から型を推論し、通常・詳細・再送の公開結果へ接続する。
業務上の成功状態はokの型引数で明示し、直和の次状態の契約を維持する。
新しいframework API、runtime処理、依存、型アサーションは追加しない。

## 公開されるkind

下表の共通部分はDenied / TargetMismatch / InvalidInput / Conflict / NotFound / WrongState。

| 操作 | 公開Resultのエラーkind |
| --- | --- |
| 申請作成 | Denied / InvalidInput / Conflict / NotFound |
| 申請編集・承認・取下げ・却下・差戻し・承認者変更 | 共通部分 |
| 申請提出 | 共通部分 + BudgetExceeded |
| 発注作成 | 共通部分 + AlreadyExists |
| 発注修正・取消 | 共通部分 |
| 発注完了 | 共通部分 + InvoiceMismatch |

これらは宣言したResultの型であり、全DB制約を考慮した到達可能性の証明ではない。
取得・保存のNotFound/Conflictも保持する。例えば作成時のNotFoundは保存adapterの契約から来る。
再送では、元の操作の集合にInvalidReplayRequest / ReplayMismatch / CommitUnknown / ReplayInputNotCloneableを加える。
履歴の成功型を現在の遷移だけの状態へ狭める変更は行わない。

## 型注釈と通常のTypeScript

成功状態の宣言とエラーの列挙は別々に扱う。
例えば発注完了の状態生成関数は、成功時のChange<Completed>を指定する一方、失敗はInvoiceMismatchだけを返すと推論できる。
保存への接続後は、共通検証と取得・保存の失敗が自動で加わる。
戻り型のRuleErrorから、その操作には関係しないAlreadyExistsやBudgetExceededが混ざることを避ける。

通常TypeScriptとhelperの比較版も同じ型を保つ。helperの解析・検証をつなぐ2つの関数は、
各段階のkindを型引数として集約し、広いRuleErrorへ変換しない。
これらは比較側自身の手書き実行処理を維持し、Koyukiのruntimeを呼ぶ実装へ置き換えていない。

## 検査の範囲

[追加検査](../src/procurement-commercial-errors.test.ts)は、12操作の通常・詳細・再送を3方式で型比較する。
ドメインの検証・遷移16関数のkindも独立した期待集合と比較し、申請作成で予算超過へ分岐するコード等を拒否する。
実行検査では、解析・作成検証の拒否と、3方式それぞれの作成時の独自保存エラーpayload・非保存を確認する。
既存の全25操作の成功・代表失敗・例外・独立した保存計画の比較も維持する。

従来の発注8関数の契約は、成功状態とエラー集合を分けて検査する。
配布consumerでは4つの状態生成元の成功型だけをOrder全体へ広げると、そこから推論する4つの互換関数を含む8つの成功型契約が失敗する。
共有の申請権限検証、または明細解析の戻り型だけをRuleErrorへ戻す対照でも、新しいエラー集合の契約が失敗する。

変更前e21ae43と変更後のdomain/helperをesbuildで型除去して比較し、出力JavaScriptが一致することを確認した。
失敗の値や優先順位、入力の非変更、保存計画、観測段階を変更するための修正ではない。

## 残る範囲

財務6操作と合わせて18操作でこの集合を検査する。入荷3操作と在庫4操作の広いエラー型は別の残件である。
独自の例外は従来どおりthrow/rejectで、Resultの型にJavaScriptの全例外が現れるとはしない。
任意の業務のエラーを本体解析で自動抽出する機能ではなく、利用者が注釈で広げていない通常関数の推論を利用する。
名前なしinline・深いgeneric変換・独立利用者の評価・原音確認も未完了で、講演全体の判定は部分充足を維持する。
