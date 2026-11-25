# Applicationの操作テーブルと実行キー

Applicationは、宣言した操作をownデータプロパティとして登録する。
通常のoperationsとreplayOperationsも同じ登録規則を使う。
列挙されないownデータプロパティを落とさず、数値キーは実際のJavaScriptの
プロパティ名と同じ文字列としてイベント・実行状態へ反映する。

```ts
const table = operations({ 0: command }, reduce);
const app = defineApplication({ initial: () => initial, operations: table, view });
const session = await app.start();
await session.dispatch({ type: '0', input });
```

イベントの入力型とfailed状態の失敗型は各操作に対応したまま保持する。
数値0のイベントタグをnumberの0として扱うことはない。
従来の文字列キーのApplicationや、実行時に選ばれたcommand Unionの入力契約は維持する。

## 構築時に確認すること

- テーブルは通常のrecordまたはnull-prototype recordである。
- Symbolキーとテーブル直下のgetter/setterは、黙って無視せず構築時に拒否する。
- 全プロパティのdescriptorを確認してから操作を変換する。拒否時にテーブルのgetterを実行しない。
- dismissと@で始まる名前はApplication内部用であり、列挙されない場合も拒否する。
- constructorや明示的な__proto__データキーは、prototypeへの代入をせず登録する。

この制約は操作を格納するテーブルへの制約である。command本体のclassやreceiverを
禁止するものではない。既存のoperation/replayOperationによるreceiver保存も継続する。
直接登録した操作のrun・runDetailed・reduceも、その操作オブジェクトをreceiverとして
呼び出す。private fieldを持つclassのメソッドを使うためだけにwrapperを追加する必要はない。
状態・イベントのsnapshotは引き続き別の所有境界であり、操作インスタンス自体をcloneしない。
構造的なTypeScript型ではプロパティの所有権・prototype・descriptorを表せないので、
構築時にも検査する。genericなテーブル変換関数を壊さないよう、Symbolキーの静的な
拒否は今回の変更には含めていない。型を通っても構築時に拒否される場合がある。

## 検証

[回帰検査](../src/application-operation-table.test.ts)は、非列挙操作の通常・再送・直接登録、
数値名と入力・失敗型の対応、getter非実行、Symbolとprototypeの拒否、予約名と
prototypeに似た名前を確認する。同じ検査を実tarballの独立consumerでも実行する。
[receiverの回帰検査](../src/application-receiver.test.ts)では、直接登録したclassを
通常・観察付きで実行し、失敗時にreduceしないこと、投影がthrowしても前の状態を保持し、
操作を再実行しないことも確認する。

変更前の988eeb8では、非列挙goをoperationsへ渡すと登録結果から消え、直接Applicationへ
渡してもdispatchがUnexpectedMessageとなることを再現した。
この修正は宣言と実行の一致を改善するものであり、任意の型アサーションや外部入力の
正しさ、独立利用者の開発体験、講演の全内容の実現までを保証しない。
