# 共通saveと操作ごとの成功型

保存adapterの実装も宣言した型を保持する必要がある。
購買サンプルで見つかったcloneによる情報消失と再送型の修正は
[保存値と再送の型](procurement-storage-values.md)を参照。
plain DTOの制約はそのサンプルの方針であり、core全体の制約ではない。

開発版businessでは、実際のsave関数の型が保証する範囲で、通常実行の成功型を
操作の最終段階に合わせて保持する。実行APIや保存処理の順序は増やしていない。

## 同じ保存関数を使い、結果の直和を保持する

```ts
type Draft = { readonly state: 'draft'; readonly amount: number };
type Approved = { readonly state: 'approved'; readonly by: string };
type State = Draft | Approved;

const save = async <T extends State>(value: T): Promise<Result<T, 'StorageFailed'>> => {
  // 実際には、ここで保存adapterを呼び、期待する失敗をResultで返す。
  return ok(value);
};
const app = business({ name: 'request', load, save,
  operations: { create: [create], approve: [approve] },
});
```

createがDraft、approveがApprovedを返す通常のResult関数なら、成功値もそれぞれ
Draft / Approvedになる。load・各Rule・saveの失敗Unionは引き続き合成する。
`.run`、呼び出し形式、`.runDetailed`、選択値captureも同じ成功型を使う。

また、最後のRuleが`{ result: T; writes: ... }`等の保存計画を返し、
saveが`<T>(plan: Plan<T>) => Promise<Result<T, E>>`として直接のフィールドを返す場合も扱う。
プロパティ名resultを特別扱いするAPIにはしていない。検査ではrecordという名前でも確認する。
通常のレコード形式の保存結果に同名のフィールドを保持し、receiptId等を追加する
`<T>(plan: Plan<T>) => Promise<Result<{ result: T; receiptId: string }, E>>`も扱う。

## 広いsaveを推測で狭めない

```ts
const save = async (_value: Draft): Promise<Result<State, 'Failed'>> => ok({ state: 'approved', by: 'boss' });
```

このsaveはDraftを受け取ってもApprovedを返せる契約なので、公開結果はStateのまま。
単に「最後のRuleがDraftだった」ことを理由に、保存後の値までDraftと扱わない。
別の保存結果オブジェクトへ変換するsaveについても、その宣言した出力型を維持する。

内部では、最終出力自身または直接のフィールドのうち、共通成功型に代入可能な型を候補とし、
実際のsaveがその入力とGroupExecutionを受け取り、候補型のResultを返す関数として
代入可能な場合だけ保持する。直接の候補がないか、saveがその候補を保証しない場合は、通常のレコード形式について
同名フィールドの成功Unionを対応する入力フィールドで絞った候補も検査する。
この候補自体が元の成功型に代入可能であることも必要で、privateな識別を持つclass等の
型を単なるレコードへ変えてしまうことはしない。候補がない場合や、この検査を満たさない場合は共通出力型へ戻る。
任意のgeneric関数を型レベルで適用する仕組みではなく、深いオブジェクト変換や配列の写像まで
自動で特殊化する保証はない。関数が宣言した契約の正しさも利用者の責任である。

generic save自体を先に推論してから、非同期Result・入力・操作メタデータとの互換性を検査する
型宣言を追加した。従来の宣言も維持し、型注釈のないexecution引数の補完を継続する。
inline generic関数と条件付き戻り値を組み合わせる場合などには、戻り値の注釈が必要なことがある。

## 再送は現在の決定だけから狭めない

replayを有効にしたbusinessは、既存の保存成功型を維持する。
lookupから取得する過去の成功は、今回のRuleの到達型と同一とは限らないためである。
検査では、現在のRuleはDraftを生成するが、lookupが過去のApprovedを返すケースを
実行し、どちらも許す成功型と実際のreplayed結果を確認する。

購買アプリの通常procurementでは、共通saveをgenericとして宣言し、
approveの成功値をApproved | FinalReviewに保てるようになった。
procurementChangesのCommitted envelopeも、同名フィールドの対応により
Committed<Approved | FinalReview>を保持する。サンプル固有の再送tableは、lookupが現在の操作ごとの到達状態を検査する契約ではないため、
従来どおりモデル全体の保存出力型を維持する。現在のRuleの推論改善だけを理由に履歴を狭めない。
core businessのreplay設定では、上記のとおり宣言された履歴の成功型を維持する。
キーが異なる深いenvelopeやprivateなclass等まで、すべての成功型を自動特殊化できたとはしない。

## 保存する値と診断の分離

型推論の検証中（1105d3d）に、保存前の最終決定に実際のSymbol属性があると
SymbolInputで拒否される制限を発見した。その後、[通常の保存と診断用の計画を分離](opaque-decisions.md)し、
rendererなしの経路では実際の決定値をそのままsaveへ渡すよう改善した。
診断できない値はplanにinputStatus: unavailableを明記し、保存を止めない。
実際のSymbol属性をsaveへ渡すテストも成功例へ変更している。

明示的なViewのrenderer、replayのrequest snapshot、Applicationの所有境界には別の契約が残る。
型検査を通った任意の値を、DBやApplicationまで自動で同じ形に保存・復元する保証ではない。

## 検証

[src/business-save-inference.test.ts](../src/business-save-inference.test.ts)で
identity / phantom brandの検証済み型 / 直接フィールドのprojection / 保存metadata付きenvelope / privateなclass / 複数段階と個別load / 広い結果への置換 /
別形式への変換 / 従来の文脈付きcallback / 過去の再送結果を検証する。
それぞれ実行結果と入力・成功・失敗型の厳密一致を確認する。
不完全な保存計画、無関係な操作名を要求するsave、同期saveは型検査で拒否する。
実tarballの独立consumerにも同じ検査を含める。

```sh
npm run check
npx tsx --test src/business-save-inference.test.ts
npm test
npm run test:business:package
npm run check:package
npm run test:portable
```
