# 明示的rendererが業務判断を差し替えない照合

完了条件の点検で、bindMutationの明示的なrender経路に不具合を再現した。
通常の関数・mutableなTypeScriptの値だけで、次の2つの置換が保存まで進んでしまった。

- rendererが判断結果のamountを変更してSaveへ渡す。照合時には元の判断結果も変更済みだった。
- 追加属性を持つ配列を、異なる追加属性の配列へ差し替える。JSON照合が追加属性を落としていた。

また、判断結果のgetterがSaveのcloneや照合で呼び出される例も再現した。
追加した最初の3検査は修正前にすべて失敗した。

## 修正した境界

rendererを呼ぶ前に、判断結果のcanonicalな表現を記録する。
登録済みの保存能力・bindingの一致を確認した後で、ノードの入力と元の判断結果を
それぞれ最初の表現へ照合する。ノード生成前・後の改変、ノード生成後だけ元に戻す改変も保存前に拒否する。
この拒否はChangedDecisionであり、rendererの誤りを業務Resultへ自動変換しない。

明示的rendererの判断結果はplainなJSONデータに限る。
データdescriptorから値を読み、getterを呼ばない。関数・undefined・非有限数・-0、
Symbol属性・非列挙属性・accessor・custom prototype・循環・配列の穴や追加属性を拒否する。
-0はJSON化すると0になるため、ここでは受け付けない。通常の0、null prototypeのrecord、
キーの順序の違い、同じ値への循環しない共有参照は許可する。
これは明示的rendererの照合用形式の制約であり、全ドメイン値の制約ではない。

rendererなしのbindMutation/defineCommand/businessはopaqueな判断結果を直接adapterへ渡す。
そちらのクラス・関数・Symbolを使う通常処理と、診断用planのunavailableの区別は維持する。
明示的rendererのSave/viewを単独で呼ぶpreviewまでgetterを隔離する変更ではなく、
run/runDetailedがrendererを実行する保存前検証を修正した。

## 検証と限界

[7件の回帰検査](../src/mutation-renderer-identity.test.ts)で、3つの改変時点、配列属性の置換、
getter未実行、情報を失う値の拒否、通常データの一度だけの保存を検査する。
実tarballのconsumerにも同じ検査を追加し、既存の別binding・偽造ノードの拒否、
opaque値の通常保存、再送・Application・観測の検査も継続する。

任意のProxyやrendererの外部副作用を隔離したり、rendererが一時的に値を変えて完全に戻す
全行為を検出したりする保証ではない。保存後の別工程の巻戻しでもない。
Viewの構文が業務仕様の正しさを証明する機能も追加していない。
講演がこの照合方式を指定したという主張ではなく、宣言した判断を保存するというKoyuki自身の契約の修正である。
講演全体の完全実現、原音・独立利用者の評価は引き続き未確認である。
