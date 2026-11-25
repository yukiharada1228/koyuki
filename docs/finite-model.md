# 明示したモデルを有限探索する

開発版の`koyuki/testing`は業務runtimeと別の入口。公開npm alpha.5には含まれない。
`exploreModel`は独立した参照モデルを幅優先で探索し、各辺を実装と比較する。
関数本体から状態機械や業務仕様を推測しない。

```ts
import { exploreModel } from 'koyuki/testing';

const result = exploreModel({
  initial: [0],
  key: state => String(state),
  events: state => state < 3 ? [1] : [],
  step: (state, increment) => ({ state: state + increment, output: state + increment }),
  check: (before, increment, expected) => before + increment === expected.output,
  invariant: state => state >= 0 && state <= 3,
  limits: { depth: 3, states: 4, transitions: 3 },
});
// kind: 'passed', states: 4, transitions: 3, maxDepth: 3
```

この最小例のcheckは説明用。実際の[経費探索](expense-state-exploration.md)では、
モデルと別に定義した既存の業務遷移を呼び、成功値・失敗・保存条件・復元を比較する。
期待結果を実装自身から計算しては、実装との一致を独立に検査できない。

## 結果と上限

- `passed`：与えた初期状態から、同一keyを統合した到達グラフを上限で切らず探索した。
- `limited`：depth、states、transitionsの少なくとも一つで未探索部分が残った。検査成功の意味ではない。
- `counterexample`：不変条件違反または実装との不一致。初期状態と操作列を返す。
- `defect`：callbackやsnapshotの例外、無効な返却形式。phase、cause、得られる場合の操作列を返す。

depthは許す操作列の長さ。statesは訪問済みkeyの最大数、transitionsは比較する辺の最大数。
states/transitionsは1以上、depthは0以上のsafe integerを必須とし、不正な設定は実行前にthrowする。
初期状態がないモデルはdefect。空の初期集合を根拠にpassedとは返さない。
件数のstatesは登録した状態数であり、全状態の処理完了数とは区別する。
未登録の次状態にも不変条件を検査してから、状態数上限による打切りを判断する。
深さの境界にイベントが残る場合は保守的にlimitedとする。

幅優先で各keyへの最初の操作列を保持する。反例は再現可能な列だが、
探索上限やkeyの統合を超えた世界での最短性は保証しない。汎用的な縮小器・seed生成器ではない。
経費では編集・再申請を繰り返すとversionが増えるため、有限の深さを探索してlimitedを返す。
別に編集を除いた一回の承認過程も探索し、その有限グラフはpassedとなる。全操作のモデルとの違いは
[経費の検査範囲](expense-state-exploration.md)に明記する。

## モデル側の契約

keyが同じ状態は、今後の遷移と実装比較が等価でなければならない。
actor、version、承認証跡等の必要な情報を落として統合すると検査範囲が変わる。
この同値性、抽象モデルと実装の対応、callbackの純粋性・停止性は利用者の責任。
有効なkeyを自動生成する機能や、不正な抽象化を一般に発見する機能はない。

状態・イベント・出力はstructuredCloneできるデータとする。各callbackへ独立したコピーを渡し、
callback内の変更が他の辺や呼出し元の入力へ漏れないようにする。
関数・private field付きの任意class等を状態として保持する契約ではない。
チェックは同期関数。DB・HTTP・認証基盤を含む実装の自動形式証明やasync検査は提供しない。
上限はモデルの探索件数であり、callback内部の計算・配列生成・cloneのサイズや時間を制限しない。

診断には指定したモデル値・イベント列・例外causeが含まれる。
実データや認証情報を渡さず、ログへの出力先・公開範囲は利用者が決める。
業務のExecutionEventに値を自動収集する機能を追加したものではない。

## 採否と追加価値

実験用の検査入口として採用し、業務宣言の必須要素にはしない。
既存の型検査は接続の型を、個別テストは具体例を検査する。この入口は、
明示した有限集合で差戻し等の組合せを探索し、不一致を操作列で返す。
意図的に誤った実装を比較して反例を検出する検査もある。

代わりに、参照仕様、keyの同値性、抽象化、実装との対応を保守する必要がある。
経費の仕様変更ではモデルと実装を独立に更新し、旧仕様の期待値を追従修正するだけにしない。
この保守負担を含むチームの生産性・品質の優位は未測定。
Issue #7の実験は前進したが、一般的な採用効果や任意システムの安全性を実証したとは扱わない。

[検査](../src/finite-model.test.ts)は上限の各種打切り、反例、初期不変条件、
重複key、例外、値の所有、意図した実装不一致を対象にする。
実tarballの`koyuki/testing`、Node型を要求しない配布宣言、Node globalのないbundleでも検査する。
