# 入力保持の型計算とbusiness全体の推論を分けて調べる

## 後続：判定と要求する関数型を同時に変える

```sh
node scripts/investigate-business-pair.mjs --literal-connection
```

元の候補は判定部分を直接の関数型に変えても、DiagnosticRuleが最終的に要求する
通常関数の署名にはRule aliasを使っていた。両方を直接記述する追加候補も比較した。
既存の2候補を対照に保ち、3候補すべてで既存ソースの型検査が成功、追加診断0だった。
しかし、どの候補でもbusinessのinline設定と設定全体の先行束縛は不受理のままで、
単独の直接記述だけが受理される区別も変わらなかった。
結果は[生の記録](business-pair-binding-investigation.json)のliteralConnectionFollowUpに保存した。

正例の受理を改善していないため、この候補もcoreへは採用しない。
診断を減らすために接続検査を外したり、Contextのprivate fieldを除いたりはしていない。
これは実行エンジンの修正・独立利用者の評価・全ての改善の不可能性の証明ではない。
入荷の3つの文脈注釈、原音・独立利用者の未確認事項も維持する。

## 当初の束縛・型計算の比較

後続の[設定全体を先に推論する候補](business-raw-definition-investigation.md)も、
既存契約を保つ条件で正例を受理できず、不採用とした。

[以前の中間型補正](business-pair-specialization-investigation.md)に続き、設定全体を先に束縛する場合と、
元の入力を保持する型計算だけを切り出す場合を調べた。基準はbba2e06c0512caf1db4ba827e7497cb189907afe。
core・実行API・購買モデルは変更していない。

```sh
node scripts/investigate-business-pair.mjs --binding
node scripts/investigate-business-pair.mjs
```

1つ目は新しい調査、2つ目は以前からある中間型補正の対照検査である。
いずれもクリーンなソースの一時コピーを型検査し、作業ツリーのcoreは編集しない。
候補・fixture・collector・lockのhash、compiler、基準commitと診断は[生の記録](business-pair-binding-investigation.json)へ保存した。

## 追加した比較

| probe | 現行core | 一時コピーの候補 |
| --- | --- | --- |
| 元のbusinessのinline設定 | 不受理 | 不受理 |
| load/save/operationsを含む設定全体を先に束縛 | 不受理 | 不受理 |
| 単独の型計算で関数型を直接記述 | 受理 | 受理 |
| 単独の型計算で同じ意図のRule型aliasを使用 | 不受理 | 不受理 |

設定の先行束縛では、配列のas constだけを使い、文脈の追加注釈や接続の正しさを仮定する型アサーションは加えない。
単独の型計算は、元のgenericなwithInputが具体的なContextを受け取り、
そのContextをinput/valueのinputへ返す契約を保証する場合だけ型を補う。
成功型はclassのprivate fieldを持つContextを含む組と厳密一致で比較する。
単独probeには、元の再現例の共有定義と、具体的な注釈を使う既存の正例も含む。
問題のbusiness構築をこの単独probeへ紛れ込ませない。

一時コピーの候補は、関数型を直接記述する判定を中間型の補正と接続診断へ用いる。
既存ソースの型契約は通り、probeによる既存ソースへの追加診断も0だったが、
business全体の入力・結果の厳密一致を含む正例は通らないため採用しない。
単独の型計算の成立を、利用者のbusiness宣言も通るという証拠にはしない。

Rule aliasとの違いは、記録したTypeScript 7.0.2とこのconditional type式での受理結果である。
TypeScriptの内部処理や不具合の原因を断定するものでも、Rule alias一般の使用禁止を意味するものでもない。
今後のcompilerや別の式が同じ結果になる保証はない。

オプションなしの対照では、以前の3候補と現行宣言について、inline/operations先行束縛の不受理を維持した。
この調査はruntimeの挙動・開発時間・独立利用者の書き心地を測った記録ではない。
購買の3つの文脈注釈は残し、他の推論改善の可能性まで否定しない。
原音確認と全講演の完全実現も未完了のままとする。
