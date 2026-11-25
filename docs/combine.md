# 固定tupleの検証結果を接続する

開発版のcombineは、すでに評価済みのResultを位置どおりの成功tupleへまとめる。
講演1本目の公開PDF55ページ、2本目25ページの固定tuple合成に対応する。

```ts
import { combine, workflow, ok, err, type Result } from 'koyuki';

const toLabel = (value: string): Result<string, 'EmptyLabel'> =>
  value.trim() ? ok(value.trim()) : err('EmptyLabel');
const toCount = (value: number): Result<number, 'InvalidCount'> =>
  Number.isSafeInteger(value) && value > 0 ? ok(value) : err('InvalidCount');

const create = workflow('validate-fields', (input: { label: string; count: number }) =>
  combine([toLabel(input.label), toCount(input.count)]))
  .then('create', ([label, count]) => ok({ label, count }));
```

成功時の型はreadonly [string, number]。関数ごとに異なる失敗型はUnionとして保持する。
検証付きconstructorのbrandも保持する。const tuple推論のためにas constを毎回付ける必要はない。
通常の同種配列と空tupleも受け取れる。PromiseやResultでない値は拒否する。
このWorkflowはProcess.throughへ渡すか、runをbusinessの通常関数として登録できる。

## 失敗規則と所有権

- 入力順で最初に見つかった失敗Resultを、そのオブジェクトのまま返す。errorへのラベル追加や全失敗配列化はしない。
- 後続Resultの検査は止めるが、配列を渡す前に評価されたconstructorはすべて実行済み。
  遅延実行・非同期中断・rollbackを提供するものではない。
- 成功時は新しいreadonly tupleの容器をfreezeする。入力配列・要素・失敗オブジェクトはclone/freezeしない。
- 予期しない例外を期待失敗へ変換しない。純粋性と入力の実行時整合性はdomain/adapter側の責任。

| 用途 | API | 失敗の扱い |
| --- | --- | --- |
| 評価済みの固定tupleや同種配列 | combine | 最初の失敗を変更せず返す |
| 評価済みの名前付きフィールド | collect | field付きで全失敗を集める |
| 各要素を独立に検証する | collectEach | index付きで全失敗を集める |
| 前要素の成功状態に依存する | foldEach | 検証・更新を順次実行し、最初の失敗で停止 |
| 独立した非同期I/O | collectEffects | 指定並列数で実行し、業務失敗をすべて集める |

このAPIはneverthrowのメソッド互換ではない。Result.map/andThenの言語組込みや暗黙unwrapも提供しない。
普通の関数とWorkflow/businessの接続で次の処理へ進める。

[src/combine.test.ts](../src/combine.test.ts)と、実際の開発版tarballをインストールしたconsumerで、
型の保持・先頭失敗・所有権・後続保存の停止を検査する。
