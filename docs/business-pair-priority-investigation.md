# 入力保持の判定順・接続方法・設定全体の推論を分けて調べる

購買に残る3つの文脈注釈を減らすための追加調査。製品のcoreは変更していない。
前の[関数契約の比較](business-pair-binding-investigation.md)で、単独の型計算の成功と
business宣言全体の成功が一致しないことを踏まえ、別の3仮説を切り分けた。

## 調べた候補

| 変更 | 単独の内部型検査 | businessのinline宣言 | 設定全体を先に束縛 |
| --- | --- | --- | --- |
| 現行core | 入力保持の段階出力だけ不一致 | 不受理 | 不受理 |
| 従来のliteral契約による補正2候補 | 5項目とも一致 | 不受理 | 不受理 |
| 入力の組の補正をidentity/proof判定より先に置く | 5項目とも一致 | 不受理 | 不受理 |
| 上記に加え、段階を再帰的に接続して中間tupleのindex参照を避ける | 5項目とも一致 | 不受理 | 不受理 |
| 制約のないobjectとして設定を推論してから、NoInfer内で既存契約を検査するoverload | 5項目とも一致 | 不受理 | 不受理 |

最後のoverloadは、以前の設定全体の調査と異なり、推論対象のDにload/save/operationsの
構造制約を最初から置かない。共有loadあり・再送なしの候補だけを調べ、既存overloadは維持する。
これも正例が通らないため採用していない。新しい利用者向けAPIを追加した記録ではない。

単独の5項目は、先頭Ruleの要求型、取得後のContext、元のcallableとの一致、
広い段階出力の型、具体的Contextを渡した段階出力の厳密一致。
調査用type aliasを一時コピーからだけexportし、どの項目で失敗したかを診断位置で区別する。
現行coreの不一致は最後の段階出力だけで、loadの型まで壊れていることを示す結果ではない。

## 根拠と再現

- [判定順と再帰接続の生の記録](business-pair-priority-investigation.json)：7995a05を基準に5候補。
- [設定全体の推論の生の記録](business-pair-unconstrained-investigation.json)：6fff88eを基準に現行と1候補。
- 両基準間のcore、fixture、package/lock、tsconfigは同一。collectorの変更は各hashで区別する。
- 各候補の既存ソース全体の型検査は成功し、probeによる既存契約への追加診断は0。
- import欠落・暗黙anyで正例が落ちた結果ではない。runtime・独立利用者の評価ではない。

```sh
node scripts/investigate-business-pair.mjs --pair-first
node scripts/investigate-business-pair.mjs --unconstrained
```

記録の再現には各JSONのsourceGitCommit時点のcollectorを使う。
現在のpair-firstには後続の設定全体の候補も含むため、過去の記録と候補件数が同じとは限らない。

collectorはsrcを一時コピーし、候補と内部検査用aliasをそのコピーにだけ追加する。
JSONのbusinessSourceSha256は内部aliasも含む検査対象のhash。製品の公開exportには追加しない。
既存のliteral関数契約の単独検査とRule aliasの対照も残し、都合のよい検査だけを採用しない。

## この結果から決めること

この3変更だけでは、元のbusiness宣言の不受理を解消できなかった。
単独検査を根拠に「型推論を修正した」とはしない。compiler内部の原因や、
別の設計もすべて不可能であることを証明した結果でもない。

次の設計案には、宣言全体の正例と既存の拒否契約の両方を先に要求する。
成功値の形だけを見て元の入力を保持したと仮定する補正は採用しない。
たとえば別の入力から作ったinput/valueの組を返す通常関数に、取得したContextが保持されたという保証はない。
入力保持を表す新しい証拠を導入する場合も、実際の関数契約との結び付きと、
既存のhigher-order推論への影響を別に検証する必要がある。

購買の3つの文脈注釈・一般のgeneric推論・独立利用者の未実施は引き続き未解消。
講演対応のpartialをsupportedへ変更しない。
