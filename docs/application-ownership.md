# Applicationの状態・イベントを情報を失わずに所有する

Application / Programは、再送と同じ内部snapshot実装を使う。
単にstructuredCloneが成功するかではなく、[対応するデータ形式](replay-request-snapshot.md)を確認する。
Symbol属性、クラスの振る舞い、非列挙属性等を消したまま、型だけ元のモデルとして扱わない。
新しい利用者向けAPIや実行時依存は追加しない。

## 境界ごとの挙動

| 境界 | snapshotが作れない場合 |
| --- | --- |
| Program / Applicationの初期状態 | startをDataCloneErrorという名前の例外でreject。初期commandを実行しない |
| 外部dispatchのイベント | queueへ入れる前にreject。update、revision、購読通知、副作用を進めない |
| Programのupdateが返した状態 | 状態とrevisionを変更せずreject。後続commandを実行しない。traceはevent/error |
| Applicationのreduceが返したデータ | 前の業務データを維持してcrashedへ進む。自動で操作を再実行しない |
| Applicationがfailedへ保存するエラー | 情報を落とした別のエラーを格納せず、crashedへ進む |
| businessのcaptureで選んだ値 | CaptureFailedへ記録し、その観測値を省略。業務結果は変えない |
| Workflow.inspectのcapture | 従来どおり観測の例外としてthrowし、業務のResultへ混ぜない |

Applicationはtype/inputを読み取って内部イベントを作る前にも、公開イベントを検査する。
公開イベントのgetterをルーティングのために評価したり、rootのSymbol属性を無視したりしない。
外部イベントのsnapshotは以前と同じくdispatch時点で作り、先行するcommand待ちの間の
呼び出し元による変更を受けない。失敗したdispatchは後の正常なdispatchを妨げない。

## 状態の受理と副作用の順序

Programでは、updateのResultがokであることだけを状態の受理とはしない。
返された状態のsnapshotに成功した後で、event/okを記録して状態を交換しrevisionを進める。
snapshotに失敗した場合はevent/errorを記録し、購読へ新しい状態を公開しない。
updateが受け取ったコピーを書き換えてから不正な状態を返しても、前の状態は変わらない。

command実行後の完了イベントでも同じ順序を使う。ただし、完了までに実行済みのI/Oを
取り消すものではない。既に実行したcommandはcommand/ok、その後の状態受理の失敗はevent/errorとなる。
後続commandを止めることと、既に確定した別工程をrollbackすることを混同しない。
再送・永続化・障害後の照会方針はhost側の契約である。

## 業務オブジェクトとViewは別の役割

外部イベントと保存するモデルは、対応するdata形式で構成する。
private fieldや実際のSymbol属性を持つドメインオブジェクトは、[通常の業務処理](opaque-decisions.md)で使い、
Applicationへ保存する部分をreducerでDTOへ投影できる。
commandが生成した内部の完了値は、この投影前に無理にcloneして振る舞いを壊さない。
生成側が返した値を後から変更しない契約は引き続き必要である。

```ts
operation(command, (_state, domain) => ({ amount: domain.amount() }))
```

Viewの戻り値はモデルの保存形式ではない。viewが返すSymbolや関数はcloneしないので、
JSX等の表示用オブジェクトをモデルのsnapshot制約へ巻き込まない。
過去のsnapshotに含まれるviewが、後の状態更新で書き換わらないことも検査する。

null prototypeのレコード、Map/Set、Date、対応するbuffer/view等は共通のsnapshot契約に従う。
null prototypeや同じオブジェクトへの参照関係も保つ。
すべてのTypeScript値を状態として保存・復元できる機能や、永続的なElm runtimeではない。

## 観測値も型だけを保って変質させない

captureで選択した値も共通のsnapshotを使う。
クラスやSymbol属性を選んだ場合に、その情報を落とした値を観測結果へ格納しない。
必要な情報をboolean、数値、通常のレコード等へ明示的に投影する。
getterをデータの値として自動評価しない。

businessのI/O付き観測は失敗を診断へ分離し、saveやreplayの成否を変えない。
純粋なWorkflow.inspectは、input capture失敗ならRule前、result capture失敗ならRule後にthrowする。
この2つの契約は区別する。観測が永続監査ログになることは保証しない。

## 検証

[application-ownership.test.ts](../src/application-ownership.test.ts)の14テストで、
初期化・dispatch・状態受理・完了イベント・crashed/dismiss・観測とViewの境界を検査する。
初期commandの未実行、不正イベント後のqueueの復帰、状態・revision・通知の維持、
実行済みI/Oと後続commandの区別、opaque完了値のDTO投影、null prototypeも含む。
同じ検査を実tarballのconsumerでも行う。
Node globalsなしのbrowser bundleでは、通常のcollection状態、イベント拒否、Symbol/関数を返すViewも検査する。

```sh
npm run check
npx tsx --test src/application-ownership.test.ts
npm test
npm run test:business:package
npm run check:package
npm run test:portable
```
