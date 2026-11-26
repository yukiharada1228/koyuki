# businessの関数列で元の文脈を保持する

後続の[入荷・返品の直接接続](procurement-direct-receipt-stages.md)で、valueにある計画の状態型も保持し、
購買の文脈注釈を3つから1つへ削減した。以下の件数・残件はda7b550時点の記録である。

開発版では、genericなwithInputを先に束縛すると、関数列の中間でも元の文脈を保持できる。
withInput用のcallbackへContextを重ねて注釈したり、接続だけのWorkflowを作ったりする必要がない例を追加した。

```ts
import { business, withInput, ok, err, type Result } from 'koyuki';
type Context = Readonly<{ amount: number; currency: string }>;
type Quote = Readonly<{ currency: string; total: number }>;
function calculate<T extends Pick<Context, 'amount'>>(input: T): Result<number, 'Declined'> {
  const total = input.amount * 2;
  return Number.isSafeInteger(total) && input.amount > 0 ? ok(total) : err('Declined');
}
const calculated = withInput(calculate);
const finish = (pair: Readonly<{ input: Context; value: number }>) =>
  ok<Quote>({ currency: pair.input.currency, total: pair.value });
const saved: Quote[] = [];
const quotes = business({
  name: 'quote.v1',
  load: async (amount: number) => ok<Context>({ amount, currency: 'JPY' }),
  save: async (value: Quote) => { saved.push(value); return ok(value); },
  operations: { create: [calculated, finish] },
});
const accepted = await quotes.create(100);
const rejected = await quotes.create(-1);
if (!accepted.ok || accepted.value.currency !== 'JPY' || accepted.value.total !== 200
  || rejected.ok || rejected.error !== 'Declined' || saved.length !== 1) throw Error('Unexpected quote');
```

要求はnumber、成功はQuote、失敗はDeclinedと推論する。saveは説明用のメモリ配列で、DB・認証・再送は実装していない。
このコードをpack済みconsumerでも型検査・実行し、Node型なしの検査にも含める。

## なぜ型を保持してよいのか

最初の関数が実際に取得済みの値を受け取れ、宣言済みの入力型と戻り型にも適合するなら、そのloaderを保持する。
比較の前に宣言済みの型を固定し、広いoverloadによって操作の必須入力や保存時の要求情報が失われることを防ぐ。
従来の、先頭関数の引数型を取り出して比較する経路はfallbackとして維持する。
これにより、genericな関数からの型抽出だけでloaderの対応が未確定になる例を避ける。

中間の成功値にinput/valueがある場合、元の文脈をinputへ戻した候補を作る。
**実際の関数が、その入力に対して候補の成功型を保証し、候補が宣言済みの成功型の部分型になる場合だけ**採用する。
これにより、関数がinputへ追加した検証済みの事実も残す。
通常の関数が広いBaseだけを返す場合や、取得済みの値に必要な事実がない場合は拒否する。
次の関数の要求だけを根拠に、存在しないclassの事実や権限を補う仕組みではない。

## 検証範囲

最初の候補は53f84c5で採用し、そのbusiness.tsのhashが[一時コピーの合格候補](business-input-retention-adoption.json)と一致することを確認した。
その後の追加検査でoverloadと検証済み情報の保持に不足が見つかったため、2534f46とda7b550で補正した。
現行の検査基準はda7b550。この初期候補の記録だけを現行実装の安全性の根拠にはしない。
同じ調査のほかの候補は正例を通しておらず、次の関数の要求から接続する案等は採用していない。
64段の不正接続の検査は、同じ不整合な2関数を一行へ置き、producer/consumerのどちらの診断位置でも拒否を確認できる配置にした。

[現在の6.0.3](business-input-retention6.json)・[7.0.2](business-input-retention7.json)では、
record・公開class・privateフィールドのclassを、それぞれinline設定と先行束縛の操作表で検査し、6形式すべてが成功した。
ここでのinline設定は、withInput自体は先に変数へ束縛した形式である。

`business-input-pair.test.ts`の5件は、追加の文脈注釈なしの接続、入力/成功/失敗の厳密型、
失敗停止・保存回数・trace・選択観測・privateな文脈の同一性、最終pairのgeneric保存を検査する。
広い通常関数、不完全なloader、保証しない分岐を含む関数unionは型で拒否する。
monomorphicなsaveの広い戻り型も勝手に狭めない。
overloadの必須入力・保存時の要求情報と、関数が追加する検証済み情報の保持も検査する。
配布物では合計788件、不正宣言15件・既存対照を両compilerで検査する。リポジトリ全体は1,132件。

## 残る制限

`[withInput(calculate), finish]`と配列内で直接呼ぶ例は、7.0.2でinputがneverとなり不受理。
設定全体のcontextual typingを外す[追加overload候補](business-input-retention-inline.json)でも改善しなかったため採用しない。
現在は上のようにwithInputの呼出しを先に束縛する。

任意の多相変換を適用できる保証ではない。monomorphicな入力契約を超える事実を推測する保証でもない。
購買の3つの文脈注釈と既存Workflowは維持し、状態型の精度や内部traceを落として省略したことにはしない。
独立利用者の評価と講演全体の部分充足という判定も維持する。

過去の候補調査は各JSONのsourceGitCommitで再現する。現在の宣言へ古いpatchを重ねないためcollectorが拒否する場合がある。
現行の形の確認は`--current-contexts`、配列内の呼出しの調査は`--inline-definition`を使う。
