# 宣言の所有権と実行参照

宣言を作った後に、元の設定オブジェクトの関数や名前を書き換えても、
既に作成した処理の接続先は変更しない。開発版で関数参照を保持する境界を統一した。

```ts
const validate = { name: 'original', rule: (n: number) => ok(n + 1) };
const flow = transition({ validate, require: [], evolve: step('finish', (n: number) => ok(n + 1)) });
validate.name = 'changed';
validate.rule = n => ok(n + 100);

flow.run(1); // 元のvalidateとfinishを実行し、ok(3)
```

ok/step/transitionはcoreからimportする。検査例は[宣言の所有権](../src/declaration-ownership.test.ts)。
以前は構成図がoriginalを示す一方、実行はchangedを参照する場合があった。
修正前の再現テストで、このずれを確認してから修正した。

## 保持するもの

| 境界 | 保持する情報 |
| --- | --- |
| transition | 段階のnameとrule参照を、framework所有のrecordへコピー |
| Workflow.branch | yes/noの参照。callerのpathsオブジェクトは所有しない |
| bindMutation | workflow、operation、save、rendererの有無と関数参照 |
| defineAction | load、loadName、mutationの実行メソッド |
| 詳細loader | runDetailedと元のreceiver |
| Process | throughのinspect、effectとcommitの詳細メソッド |
| request Target / 操作group / business | 既定経路とcapture経路で同じloader参照を利用 |

Targetやgroupでイベントを結び付ける場合は、その宣言が作られた境界で保持する。
新しい設定を適用したい場合は、新しく宣言を作成する。
Stepやpaths等のcaller側のrecordをfreezeする変更ではないため、それらはcaller自身が更新できる。
更新を既存処理のhot replacementとして扱わない。

保存や詳細loaderのメソッドがthisを使う場合、従来の呼出し形のreceiverを保持する。
単に関数を取り出してreceiverを失う変更にはしない。
bindMutationのsave/rendererと、defineActionに直接渡したload関数はその設定objectへ束縛し、
object形式のrunDetailedは元のloader/mutationへ束縛する。
他のhostメソッドを通常関数として渡す際に必要な明示的bindまで省略できるという意味ではない。

## 固定しないもの

保持するのは関数参照と接続の宣言であり、関数が読むDB・clock・host状態・closureをコピーまたはfreezeしない。
同じ関数が後の呼出しで違うDB結果を返すのは通常の動作。
同じreceiverの可変フィールドを関数内で読むことも可能で、テストでも保持を確認する。
認証済みActorをいつsnapshotするか、業務入力の所有権、DBのversion検査はそれぞれ別の契約である。

callbackが他の可変メソッドへ自分で委譲する、共有prototypeを変更する、型を偽ってprivateフィールドを書き換える等まで、
宣言から実行全体を固定する保証ではない。型安全性や純粋性の完全証明とも区別する。

## 構成metadataの無効化

返された実行objectのrun/runDetailed自体を差し替えた場合、既知の構成として表示し続けない。
[構成図](flow-structure.md)は登録時の実行参照と現在のdata descriptorを比較し、
違っていればunknownを返す。getterへ変更されてもそのgetterを呼び出さない。
未登録のhost objectを走査して関数やプロパティを推測する処理も追加しない。

保持しておいた元のrun関数を直接呼ぶ場合は、その元の関数の構成を引き続き取得できる。
同じ関数aliasに異なる構成が登録された場合は曖昧として扱い、最後の登録で静かに上書きしない。
いずれも関数本体を検証・解析したという意味ではない。

## 検査

7ケースで、段階名と関数・分岐先・load/save/renderer・詳細IOの差替えを確認する。
既定business経路と選択値capture経路の結果も比較する。
誤った既知metadataの表示、getter実行、caller recordのfreeze、receiverの喪失を防ぐ。
rootと、開発版tarballをinstallした独立consumerの両方で実行する。
