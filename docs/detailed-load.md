# 読み込み内部の詳細記録を接続する

開発版のloadは、通常の非同期Result関数に加えて、ActionReportを返す`{ runDetailed }`を受け取る。
複数の取得をProcessで宣言した場合、その内部traceを業務操作へ引き継げる。
新しい実行エンジンや、traceを取得するための再実行は必要ない。

```ts
import { business, process, ok } from 'koyuki';

const load = process<number>()
  .effect('read', async input => ok(input + 1));
const counter = business({
  name: 'counter',
  load: { runDetailed: load.runDetailed },
  save: async (value: number) => ok(value),
  operations: { double: [(value: number) => ok(value * 2)] },
});
const report = await counter.double.runDetailed(3);
// result: ok(8)
// trace: read / counter.double:load / run:1 / counter.double
```

これは接続の最小例で、readやsaveは実際のDBではない。
Processインスタンスのように、runDetailedを持つ非callable objectを直接loadへ渡すこともできる。
関数として渡した値は、その値にrunDetailedプロパティがあっても通常のResult関数として扱う。
詳細形式への切り替えは、Process.effectのobject形式と同じく明示的である。

## 実行と型の契約

- runDetailedを1回呼び、そのresultの成功値だけを純粋な業務判断へ渡す。
- 内部traceの後に、loadName（businessでは操作ID:load）の成否を追加する。
- loadの失敗なら、実行済みの内部traceとload/errorを残し、後続Rule・保存を止める。
- loadのplanは全体planに採用しない。全体planは最後のmutationに属し、load失敗ではnull。
- objectのrunDetailedは元のreceiverで呼ぶ。予期しないthrow/rejectionは伝播し、自動再送しない。
- 通常の関数と詳細形式のいずれも、入力・成功・失敗型を保持する。後続は成功Unionの全要素を受け取る必要がある。

実行時に複数のloader候補から選ぶ宣言では、要求は全候補の入力条件を満たす必要がある。
片方がleft、他方がrightを必要とするなら、要求には両方が必要になる。
片方の条件だけで通っていた宣言は、開発版では型エラーになる。

共通loadと操作ごとのloadの両方で使える。
defineAction / defineCommand / defineTarget / defineRequestTarget / defineUseCase / defineUseCaseGroupも同じActionLoad型を受け取る。
ReplayReportはActionReportと形式が異なるので、詳細loaderとして渡せない。
再送境界のreceiptが見つかった場合は、詳細loaderも実行しない。

## 観測と保証範囲

businessの選択値captureはload全体の入力・結果を観測する。
内部のreadごとの値を自動収集するものではなく、traceの名前・成否だけを接続する。
captureが失敗しても業務結果と内部traceは維持する。
内部trace名を自動的に一意化・階層化しないため、識別しやすい名前は宣言側で付ける。

runも同じ詳細loaderを1回実行してResultだけを返す。
runとrunDetailedを両方呼ぶと、独立した2回の業務実行になる。
詳細loaderは読み取り専用だと型で強制していない。そこで実行した副作用のrollback、
DB snapshotの一貫性、永続的な再開・監査保持は提供しない。
通常のResult関数へ変換した時点で捨てたtraceを復元することもできない。

[共通実行・型の7テスト](../src/detailed-load.test.ts)と、
[購買の27テスト](../src/procurement-load-composition.test.ts)をrootと実tarballのconsumerで実行する。
購買の4操作はメモリ／SQLiteで通常形式と詳細形式の結果・保存状態を比較する。
Web標準だけのbrowser bundleでも詳細loadとcaptureを実行する。
この機能は公開済みnpm alpha.5には含まれない。
