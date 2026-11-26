# 深いgeneric出力の候補を、オーバーロードの反例で不採用にする

現在の判定は部分充足のまま。深く入れ子になったgeneric出力の推論改善案は、通常の型検査と追加8ケースを通ったが、追加の反例で誤った精密化が生じたため採用しない。製品のcore・公開export・既存テストの期待型は変更前へ戻した。

## 候補と反例

候補は、`step`構築時にproducerと深い出力の対応を検査し、型だけの証拠を保持する方式だった。実行時の関数は変更しない。入れ子のrecord、readonly配列、optional、固定unknown、privateを持つ入力、失敗停止、businessへの接続を検査した。複製したdescriptorのrule差し替えや、異なる2つの呼出しシグネチャには拒否用のガードも設けた。

しかし、次の組合せはそのガードを通過した。

1. 数値入力には文字列payloadを返す、先行する特殊化シグネチャ。
2. 任意のTに対してpayloadがTだとするgenericシグネチャ。
3. 同じgenericシグネチャをもう一つ重ねる。

反射した2シグネチャの比較だけでは、先行する特殊化を検出できなかった。候補は数値のpayloadと推論し、実際の文字列に対する`toFixed()`を型検査で拒否できなくなる。既存テストの成功だけで候補の安全性を判断しない。

この例の特殊化とgenericシグネチャ自体には契約の食い違いがある。TypeScript一般の健全性や、深い推論が実現不可能であることを証明したものではない。また、反射するシグネチャ数を単に増やせば任意のオーバーロードに対応できるという結論にはしない。

## 再現

```sh
node scripts/investigate-deep-step.mjs
node scripts/investigate-deep-step.mjs --compiler /path/to/typescript6/tsc
```

collectorは一時コピーで既存契約を検査し、保存した候補patchを適用する。初期8ケースが通ることを確認した後、最後のgenericシグネチャを複製し、unknownの厳密一致と拒否指示が失敗する位置を照合する。製品ソースやcompilerのインストール先を書き換えない。

- [候補patch](../scripts/fixtures/deep-step-research/candidate.patch)
- [初期8ケース](../scripts/fixtures/deep-step-research/contracts.txt)
- [TypeScript 6の記録](deep-step-refusal6.json)
- [TypeScript 7の記録](deep-step-refusal7.json)

講演の中心的な狙いである、接続と実行の委譲には既存の実装がある。一方、この候補で推論制限が解消したとは扱わない。独立利用者の試用、直接音声10区間、連続映像の確認も未完了のまま維持する。

## genericシグネチャとの厳密一致も比較する

反射するシグネチャ数を増やす代わりに、構築したgenericシグネチャとの厳密一致を要求する案も、一時コピーで比較した。
以前の逆向きの代入可能性検査を、既存の`NestedSame`による型の一致検査へ置き換える。

```sh
node scripts/investigate-deep-step.mjs --strict-signature
node scripts/investigate-deep-step.mjs --strict-signature --compiler /path/to/typescript6/tsc
```

この案では、genericシグネチャを重ねた反例による誤った精密化は起きなくなる。一方、通常のdeep producerにも証拠が付かなくなり、privateな入力型の保持、失敗型付きの入力保持、optional・配列を含む出力の型比較、businessへの正しい接続が失敗する。既存の型をunknownへ戻すだけでは、求める改善を満たさないため採用しない。

[TypeScript 6の記録](deep-step-strict-signature6.json)と[TypeScript 7の記録](deep-step-strict-signature7.json)には、変更前の全ソースが通ること、候補の正例に現れる6件の診断、反例を加えても診断が同一であることを残した。これは厳密一致という追加案の反証であり、任意の深い推論が不可能という証明ではない。製品core・公開API・実行runtimeは変更していない。
