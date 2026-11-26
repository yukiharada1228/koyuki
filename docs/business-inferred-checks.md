# 早期returnで推論された検証関数を、そのまま接続する

本稿の15→3箇所は80bff83時点の記録である。後続の[要求型を先頭から収集する推論](business-request-prefix.md)で残る3箇所も省略し、操作定義のload型引数指定は0箇所になった。

通常のTypeScriptでは、異なる失敗を早期returnする関数の戻り型は、複数のResultの和として推論される。
明示した`Result<成功, エラーの和>`と業務上は同じでも、型の逆向き比較では同じように扱われない場合がある。
共通検証が入力Tを保持して証明を加える関数でも、この違いで後段の要求型をloadへ推論できていなかった。

## 通常関数を変更せずに比較する

成功の候補と失敗の各variantを分けた型を、既存の逆向き比較に用いる。
検証関数へResultの戻り型注釈を追加したり、複数の早期returnを一つのreturnへ書き直したりする必要はない。
入力保持のfreshな型証拠、関数全体の比較、各段階の接続検査は維持する。
この比較は宣言した契約についてのものであり、業務仕様や関数本体の純粋性の証明ではない。

追加のrequest保持検査では、loadが要求へ加えたfreshなプロパティを出力のinputにも残すことを確認する。
これにより、具体的な要求型へ特殊化済みのloadは元の契約を保持し、後段に現れる入れ子の文脈から要求型を作り直さない。
さらに、実際の要求型に対してloadが文脈全体を保証する検査も残す。freshな要求を保持していても、操作固有の要求ではactorの型が変わるconditional loaderは拒否する。

型だけの変更であり、検証・取得・保存の実行処理や公開APIは追加しない。

## 購買の実コードへ適用する

[購買Application](../src/experiments/procurement/application.ts)のloadの型引数指定を15箇所から3箇所へ減らした。
7箇所は既存の基本要求型の推論でも省略でき、次の5箇所は今回の早期returnへの対応によって省略できる。

- 申請の却下：reasonを後段の判断から推論する。
- 発注の変更：supplierを後段の判断から推論する。
- 請求書の無効化：reasonを後段の判断から推論する。
- 在庫の移動：destinationを後段の判断から推論する。
- 在庫の調整：reasonを後段の判断から推論する。

```ts
reject: { load: context.request, run: [checkApproverRequest, rejectCheckedRequest] }
move: { load: context.inventory, run: [checkStock, moveCheckedStock] }
```

業務ルール、失敗の優先順位、保存計画、adapter実装は変更しない。
申請編集・返品・数量訂正は、後段に元の文脈をinputとして持つ入れ子の段階があるため、この段階では操作別loadの型引数3箇所を維持した。
後続で解消した範囲は冒頭の記録で区別する。

## 確認範囲

[専用の契約](../src/business-inferred-checks.test.ts)は、注釈なしの検証、全エラー型、後段の要求型、失敗停止、保存抑止、特殊化済みloadと入れ子の段階、呼出し元のgenericなエラーを検査する。
[要求型の拒否契約](../src/business-later-request.test.ts)には、要求型に応じてactor型が変わるloaderも追加した。

[配布物検査](../scripts/test-business-package.mjs)は実tarballで同じソースを使う。
以前のResult比較へ戻す対照は正しい早期returnの例を拒否し、request保持のgateを外す対照は既存の特殊化済み購買経路を壊す。
文脈全体のload保証を外す対照は、conditional loaderへの誤った要求型の精密化を検出する。

講演の中心である「普通の業務関数を書き、接続と実行を任せる」ための具体的な記述負担を減らす変更である。
名前なしinline、一般の深いgeneric変換、外側のactor型を持つfactory、原音確認等の残件をすべて解消したものではない。
