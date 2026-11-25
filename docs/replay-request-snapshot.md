# 再送の要求を、情報を失わずに所有する

withReplayは最初のawaitより前に要求をコピーし、照会と実行へ同じsnapshotを渡す。
開発版ではnative structuredCloneを呼ぶだけでなく、対応する要求データの形式を検査する。
Symbol属性・非列挙属性・クラスの振る舞いを落として、そのまま処理を続けることを防ぐ。
新しい実行APIや実行時依存は追加していない。

## 失敗は照会より前に返す

安全な要求snapshotを作れない場合は、既存のReplayInputNotCloneableを返す。
runDetailedではtraceはsnapshot/errorだけ、attemptはnullとなる。
lookup、load、純粋な業務判断、save、障害後の再照会を呼ばない。
入力のgetterをDTOの値として自動評価せず、型付きエラーで止める。
例外文や元の要求をエラーへ埋め込まない。

```ts
const proof = Symbol('proof');
await command.run({ amount: 2, [proof]: true });
// err({ kind: 'ReplayInputNotCloneable' })
// Symbol属性を捨てた { amount: 2 } で実行することはない。
```

これは再送の要求の所有境界。通常の[rendererなしの業務実行](opaque-decisions.md)では、
Symbol属性やクラスを業務関数からsaveへそのまま渡せる。
要求がDTOでも、load後の業務モデルまでDTOに限定する変更ではない。

## 対応するデータ形式

| 形式 | 契約 |
| --- | --- |
| null / undefined / string / boolean / number / bigint | native cloneと同じデータ値。NaN等を許すかはhostの入力検証・fingerprintが決める |
| plain object | 列挙可能な文字列キーのdata属性。readonly/freezeの属性フラグは維持せず、所有したコピーにする |
| null prototypeのレコード | 属性をコピーし、native cloneが失うnull prototypeも復元する |
| 通常のArray | 疎な配列と列挙可能な文字列キーの追加data属性も維持する |
| Date | 追加の独自属性を持たない標準インスタンス |
| Map / Set | 独自属性がなく、要素・キー・値も対応する形式。共有参照・循環を維持する |
| RegExp | 独自属性がなくlastIndexが0。native cloneで状態が変わる非0のlastIndexは拒否する |
| ArrayBuffer / DataView / ES2022の標準typed array | 独自属性を持たず、共有されていないバッファ。別のバッファへコピーし、view間の参照関係は維持する |

Symbolのキー・値、非列挙の独自属性、accessor、独自クラス・subclass、関数等は対応しない。
Error / Blob / Fileや、表に含めていないhost固有オブジェクトを要求として渡す契約も提供しない。
すべてのstructuredClone可能な値を受け入れるAPIではない。

SharedArrayBufferとそのviewは、native clone後も書込みが共有されるため拒否する。
コピー後のグラフも確認し、prototypeを書き換えて隠した共有バッファやcollection内の共有メモリも拒否する。
この検査を任意のProxy・prototype操作・グローバル組み込みの変更に対するsandboxとはしない。

要求はdataとして扱い、必要なクラスの値は呼び出す前にDTOへ明示的に変換する。
以前は変質した値で実行していた入力が、今回から型付き失敗になる場合がある。
照会や業務関数が所有済みのsnapshotを変更しないことは、引き続きadapter側の契約である。

## 同一性と永続化は別の境界

この変更は要求のコピーだけを扱う。要求ID・actor・操作・payloadの一致、receiptの原子保存、
再送結果を現在のViewへどう反映するか、自動再試行や永続schedulerは別の契約のまま。
コピーできた値が、hostのJSON fingerprint・DB・ネットワーク形式でも扱えるとは限らない。

Application / Programのイベント・状態とcaptureも、[同じ内部snapshot実装](application-ownership.md)を使う。
境界ごとの失敗の扱いは別であり、任意のTypeScript値を自動で所有・永続化する保証にはしない。

## 検証

[replay-snapshot.test.ts](../src/replay-snapshot.test.ts)の8テストで以下を検査する。

- run / runDetailedとも、失われる属性やクラスを照会前に拒否する。
- root・nested・Map/Set内のaccessorを評価しない。
- SharedArrayBuffer、view、prototypeで隠した共有メモリを実行しない。
- async lookup待ちに呼出し元が値・Map・Set・Date・bytesを変更しても実行値は変わらない。
- 循環・共有参照、疎な配列の追加属性、Date/RegExp、buffer/view、undefined/bigint/NaNを維持する。
- frozenな要求、null prototypeのレコードとcollection内のaliasを維持する。
- businessの再送でも、失われる検証済みの証拠をload前に拒否する。

同じ検査を実tarballのconsumerで行う。Node globalsなしのbrowser bundleでも、
object/Date/Mapの要求が動き、Symbol属性の要求は実行しないことを検査する。

```sh
npm run check
npx tsx --test src/replay-snapshot.test.ts
npm test
npm run test:business:package
npm run check:package
npm run test:portable
```
