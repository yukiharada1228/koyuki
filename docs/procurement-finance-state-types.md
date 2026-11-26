# 請求書・支払の成功型を次状態まで保持する

[財務のエラー型](procurement-finance-errors.md)を、ドメイン・通常・詳細・再送まで保持する。6つの互換関数の結果も推論し、保存エラーの追加情報と広い履歴の成功型を維持する。独立利用者の評価や講演全体の未確認範囲は残る。

請求書・支払は既に直和で状態を定義していたが、遷移関数の戻り型がモデル全体へ
広がっていた。承認成功後でも、approvedByへ触るために再びstateを判定する必要があった。
これはframeworkの接続型だけでは直らない、ドメイン関数自身の宣言の不足である。

registerInvoice、matchInvoice、approveInvoice/approveCheckedInvoice、
voidInvoice/voidCheckedInvoice、recordPayment、cancelPaymentの8関数を、
実際に生成するvariantのChangeへ精密化した。実行本体・検証順序・業務エラーは変更しない。
Extractを使い、直和モデルの定義を複製しない。新しいcastやframework APIは追加しない。

既存businessの通常実行は、既存generic saveを通してregistered/matched/approved/voided、
recorded/cancelledをそのまま返す。procurementChangesのresultにも届く。
入力がその状態であることの証明を省略する変更ではなく、従来の入力検証は引き続き行う。

[保存値と再送の型](procurement-storage-values.md)の区別も維持する。
procurementReplayの履歴は今回の遷移で作った値とは限らないため、Invoice/Payment全体を返す。
状態型だけでDB保存の事実、任意adapterの正しさ、過去履歴の意味までは証明しない。

[検査](../src/procurement-finance-state-types.test.ts)で、8個の生成関数、6個の通常公開操作、
詳細結果、再送の広い型を厳密一致で確認する。メモリ/SQLiteの実シナリオでは、
成功した7回の財務操作の次状態と、登録・取消・承認の具体的な値を照合する。
実tarballのconsumerでも同じソースを型検査・実行し、8関数の戻り型だけを
以前の広い型へ戻す対照検査が失敗することを確認する。

講演との関係は、状態を直和で表し、関数の入出力へ変更前後を表す論点である。
全84話題のstatusや9件のpartialは変更しない。型推論の3つの文脈注釈、
独立利用者の未実施、原音の未確認箇所は残る。接続の構造と観測ラベル数も変更しない。
