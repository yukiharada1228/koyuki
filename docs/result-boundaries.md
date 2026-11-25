# 既存の例外・Promiseとの接続

開発版API。公開alpha.5には未収録。
講演[qBf910_YiqAの29:36付近](https://www.youtube.com/watch?v=qBf910_YiqA&t=1776s)で扱う、
既存の命令的な処理をResultへ接続する境界を用意する。

```ts
const parse = fromThrowable(
  (text: string) => JSON.parse(text) as unknown,
  () => ({ kind: 'InvalidJson' as const }),
);
const load = fromPromise(
  (id: string) => client.load(id),
  () => ({ kind: 'StorageUnavailable' as const }),
);
```

どちらも関数を返し、定義時に実行しない。元の引数の型・個数、成功値と失敗型を保持する。
fromThrowableは同期throwを変換し、Promiseをawaitしない。
fromPromiseは呼び出し時の同期throwと、Promise／thenableのrejectを変換する。
失敗のmapperにはunknownを渡す。mapper自身の例外は隠さず、例外／rejectとして伝播する。

これらは既存Resultを平坦化しない。すでにResultを返すadapterは、そのまま接続する。
純粋な業務の想定内失敗は従来通りerrで返し、例外を業務の分岐構文に使わない。
どの例外をどの失敗に変換するかは境界側の判断。

高階generic関数を複数入れ子にしたinline定義ではTypeScriptがunknownを推論する場合がある。
上例のようにload・saveを変数として定義してからdefineUseCaseへ渡す。
[テスト](../src/result-boundary.test.ts)は同期throw・reject・thenable・mapper不具合と、
接続先のworkflowがload失敗後に検証／遷移／保存を実行しないことを確認する。
