# 財務操作のエラー型を関数列から公開結果まで保つ

財務6操作のドメイン関数・通常実行・詳細実行・再送で、操作ごとのResultのエラー型を保持する。
新しいframework APIや実行処理は追加しない。利用者が実際の業務関数を並べた結果へ、既存の型計算が反映されるようにする。

## 広がっていた場所

ドメインのfailure helperが常に全RuleErrorを返し、検証関数もResultのEを全RuleErrorに注釈していた。
支払記録でも、数量超過や予算超過まで扱える型になっていた。
また、再送の表は全操作共通のFailureを使い、通常実行で絞った情報も広げていた。

failure helperをliteralなkindを保つgeneric関数にし、5つの検証関数と6つの互換関数の戻り型を通常のTypeScriptで推論する。
承認・無効化のchecked関数では、次状態の戻り型を維持したまま、Error側をそれぞれのkindへ限定する。
通常の関数にResultを明示注釈しない例も、workflow・transition・businessで複数のエラーと追加情報を保持できることを検査する。

## 公開操作のkind

以下の共通部分は、Denied / TargetMismatch / InvalidInput / Conflict / WrongStateと、取得・保存のNotFoundである。

| 操作 | 共通部分に加わるkind |
| --- | --- |
| 請求書登録 | AlreadyExists |
| 請求書照合 | InvoiceMismatch |
| 請求書承認 | なし |
| 請求書無効化 | なし |
| 支払記録 | AlreadyExists |
| 支払取消 | なし |

これは宣言したResultのエラー集合であり、DBの全制約を考慮した到達可能性の証明ではない。
ドメイン関数だけを直接呼ぶ場合は、取得・保存のNotFoundを含まない。
保存adapterが別のEを返すなら、そのEも加わる。例えばAdapterRejectedとcode:numberを持つ保存エラーは、kindによる分岐後もcodeを失わない。

支払記録の失敗kindをQuantityExceededと比較するコードは型検査で拒否する。
起こらないエラーへ分岐していた利用コードでは、その不要な分岐を削除する必要がある。
業務上の失敗値、拒否順序、保存計画、観測の段階は変更していない。

## withInputも、推論したエラーの和を受け取る

既存のwithInputはEを引数から直接推論し、異なるオブジェクトのエラーを返す関数で最初のエラーだけを選び、呼び出しを拒否する場合があった。
新しい型宣言は関数のResult全体を先に捕捉し、その成功値とエラーを別々に抽出する。実行本体は変更しない。
この変更時点では公開呼び出しsignatureを一つに保ち、既存のgeneric関数の入力・値の対応が伝播することを検査した。
後続の[選択した関数の対応](with-input-alternatives.md)では、これを先に置いたまま、関数の直和だけに適用するsignatureを追加した。
従来の明示的な3型引数と、従来の関数型への代入も保つ。新しい型引数を利用者が指定する必要はない。

withInput(checkPaymentRecording)のように、推論した複数のエラーを返すgenericな検証も直接渡せる。
追加のprivateな文脈、入力と成功値の参照、エラーの追加情報、失敗Resultの参照を保つ。
asyncや非Resultの関数、違う入力型は引き続き拒否する。

動的に選んだ複数の関数signatureのunionは、この変更時点ではdispatch関数を必要としていた。
後続ではwithInput(selected)を直接受理し、全候補が受け取れる入力と、成功・失敗の和を保持する。
従来のdispatch関数も引き続き使える。名前なしinlineや遷移全体の深いgeneric変換まで解消したものではない。

## 再送と履歴

再送は、元の操作のエラーにReplayMismatch / InvalidReplayRequest / CommitUnknown / ReplayInputNotCloneableを加える。
Deniedは元の集合にもある。lookupやsnapshotの失敗を、ドメインの型を絞るために消していない。
通常実行・runDetailed・再送のrun/runDetailedについて、財務6操作のkindを独立した期待値と比較する。

エラーの情報を保つことと、履歴の成功状態を狭めることは別である。
保存された履歴から確認できるのはモデルのkindであり、現在のrecord遷移が生成するrecordedという状態まで証明しない。
Koyuki側は既存の広い履歴型を維持し、比較用の再送driverも同じモデル全体の型へ修正する。
現在の支払生成の成功型はrecordedだが、再送の公開成功型はPayment全体のままである。

## 検証と比較

[検査](../src/procurement-finance-errors.test.ts)では、3方式の通常操作・詳細操作・再送の型を照合する。
比較用helperも、このドメインのkindを型引数で集約し、検証や生成段階のエラーを一律にRuleErrorへ広げない。
通常TypeScriptでも保持できる情報を、比較用実装だけ意図的に失わせる評価にはしない。

10の実行ケースでは、実際の状態不正と取得失敗が保存しないこと、保存エラーのpayload、再送時のドメイン・lookup・snapshot・不一致の失敗を確認する。
commit後の履歴再取得も検査する。普通の関数から推論したZero/Negative等の異なるpayloadも、3つの接続入口で保持する。
既存25操作の成功・代表失敗・I/O例外の比較は継続する。

[配布consumer](../scripts/test-business-package.mjs)では、literalのfailure helperだけを全RuleErrorへ戻す対照と、Koyuki/比較用の再送のエラー写像をそれぞれ広げる対照を実施する。
旧withInputのsignatureだけに戻すと、推論した複数の構造化エラーを渡す正例が失敗する。
前者では、存在しない支払エラーの分岐を再び受理し、kindの契約も失敗する。後者も再送の閉じた集合の契約が失敗する。
6つの生成元の成功型を広げる対照では、そこから推論する互換関数6つを含む12関数の状態型契約が失敗する。

## 残る範囲

他の業務で明示的に広いRuleErrorを宣言した関数まで、自動で本体を解析して絞る仕組みではない。
Application全体の状態が複数の操作の失敗を表す場合、その和を財務1操作だけの集合にはしない。
予期しない例外は従来どおりreject/throwであり、Resultのエラー集合だけでJavaScriptの全例外を表すとはしない。

一般のgeneric推論、直接音声の未確認、独立利用者の評価は未完了のままで、講演全体は部分充足を維持する。

全体1,195件、TypeScript 6.0.3/7.0.2の配布consumer各851件、宣言診断47件が成功。literal helper・2つの再送写像・旧withInputの4対照も両版で失敗することを確認する。

[TypeScript 6.0.3](inferred-error-context6.json)・[7.0.2](inferred-error-context7.json)の記録は966e9b3のクリーンなソースによる。その基準では構造化エラーとdispatchは受理され、直接の関数union・元の名前なしinline・深い入れ子は不受理。
直接の関数unionは後続で対応し、名前なしinline・深い入れ子は引き続き別の制限とする。既存契約の追加診断は0。
