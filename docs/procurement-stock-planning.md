# 在庫の共通検証と計画作成を宣言で接続する

[残存接続の棚卸し](procurement-remaining-connections.md)で挙げた在庫4操作を、既存のbusinessへ接続した。
新しいframework APIは追加せず、普通の純粋関数を配列で並べる。

```ts
operations: {
  reserve: [checkStock, reserveCheckedStock],
  release: [checkStock, releaseCheckedStock],
  move: { load: context.inventory<MoveInput>, run: [checkStock, moveCheckedStock] },
  adjust: { load: context.inventory<AdjustInput>, run: [checkStock, adjustCheckedStock] },
}
```

## 保持する契約

[checkStock](../src/experiments/procurement/inventory.ts)は、認証済みactor、対象、入力、版の共通条件を確認する。
成功時に元の文脈をそのまま返し、非公開unique symbolの証明を型へ追加する。
移動先・調整理由を含む具体的な入力型を保持し、存在しない属性は補わない。
checked関数はこの証明を要求する。操作配列が検証を省略した場合も型検査で拒否する。
証明のための実行時プロパティは追加しない。型アサーションやany、検証後の破壊的変更に対する防御ではない。

共通検証の順序は元のまま、Denied→TargetMismatch→入力検証→Conflictである。
移動先・調整理由・数量0の操作別検証はその後に行う。
在庫の更新計画は新しいpositionsから作り、元の入力・在庫を変更しない。
新規在庫のexpectedVersionは0、保存時のcheckはversion:nullを維持する。
予約・解除・移動では数量0を拒否するが、調整は予約量を下回らなければ0も扱える。

reserveStock等の従来の関数は互換入口として残す。
現在のKoyuki操作宣言はその入口を経由せず、共通検証とchecked関数を直接接続する。
plain実装はResultの判定を手書きし、helper実装は既存のcheckedActionで接続する。
どちらもKoyukiのbusiness/Workflow runtimeを呼ばない。

## 検査と観測の変更

[専用検査](../src/procurement-stock-planning.test.ts)は、独立に書いた4操作の保存計画、
元文脈の同一性・非変更、多重に不正な入力のエラー優先順位を確認する。
メモリとSQLiteで、検証失敗・計画失敗では非保存、保存拒否では全6モデル非変更、
成功時は期待するpositions・版へ進むことを確認する。
未検証・偽の公開属性・移動先/理由の欠落・businessでの検証省略は型検査の拒否例に含める。
このテストも開発版tarballのconsumerへコピーして実行する。

共通検証の接続を委譲する実操作は17、複合入荷計画3操作と合わせ20操作が2段階になる。
全25操作のrule出現数は45。32回の成功シナリオでは在庫4操作の各1境界が増え、117から121境界になる。
代表失敗は不正入力64、保存前Conflict121、選んだread位置のResult失敗78で263境界。
I/O例外の位置72種類、通常I/O89回、throw/reject注入178回は変わらない。
例外検査の入力射影は356回、結果射影はモードに応じて178回または0回となる。
段階が増えた分の観測であり、業務処理やI/Oの実行回数を増やしたものではない。

型推論・接続の既存契約、3方式の結果・trace・選択観測比較を維持する。
在庫の業務計算や、入荷内部のreceiptGuard、3つの文脈注釈、hostの入力構築は引き続き利用者側にある。
この4操作の改善を、全接続の除去やReact/Elmと同等の開発体験の実証とはしない。
独立利用者の試用も未実施のままで、講演対応の9話題のpartialは変更しない。

その後、[返品・訂正の共通検証](procurement-receipt-checks.md)も分離した。上記は在庫分離時点の数値であり、
現在は成功123境界・代表失敗265境界、返品・訂正の2操作は3段階となる。
