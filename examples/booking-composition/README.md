# 業務部品としてのJSXを比較する

同じ予約業務をJSXの部品と通常の関数で組み立てる実験。React互換性やJSXの優位性を前提にせず、複数操作の部品化・propsによる再利用・依存の分離を検証する。開発版tarballだけを使い、実行エンジンのコードは変更しない。

## 使い方と対象

リポジトリのルートで実行する。

```sh
npm ci
npm run test:booking:composition
```

スクリプトが独立した一時プロジェクトへ開発版SDKをインストールし、実際のこのディレクトリのソースをコピーする。TypeScript 6.0.3/7.0.2で型検査・宣言生成を行い、シナリオを実行する。元リポジトリのエンジンを相対importしない。作成した一時プロジェクトだけを終了時に削除する。npmへの公開はしない。

業務はdraft→requested→confirmed→cancelled。申請は本人、承認は本人以外のmanager、キャンセルは本人かつ指定期限内というルールを通常のTypeScript関数で表す。期限ちょうどを許可する。時計と認証済みActorはホストが渡す。

## JSXによる組み立て

```tsx
const app24 = createApplication(
  <ActorContext.Provider value={alice}>
    <BookingBusiness
      repository={bookingsA}
      cancellationHours={24}
      clock={clock}
    />
  </ActorContext.Provider>
);
const app48 = createApplication(
  <ActorContext.Provider value={bob}>
    <BookingBusiness
      repository={bookingsB}
      cancellationHours={48}
      clock={clock}
    />
  </ActorContext.Provider>
);
await app24.execute(cancelBooking, { id: 'same-id' });
```

BookingBusinessが内部のProviderと申請・承認・キャンセルの登録をまとめる。親のActorはContextから受け取り、部品固有のRepository・期限・時計をpropsから組み立てる。公開した3つの操作宣言はアプリ間で共有できるが、ハンドラーと依存はアプリごとに確保する。

## 通常の関数による組み立て

```ts
const app24 = createBookingService({
  repository: bookingsA, cancellationHours: 24, clock,
}, alice);
const app48 = createBookingService({
  repository: bookingsB, cancellationHours: 48, clock,
}, bob);
await app24.cancel({ id: 'same-id' });
```

関数版は同じ定義をdefineCommandへ渡す。比較では、両方にsubmit・approve・cancelとdetailedを持つ薄い利用口を用意した。JSX版の薄い利用口はcreateBookingApplication。上の直接利用と同じ宣言を使う。

## 比較結果

| 観点 | JSXの部品 | 通常の関数 |
|---|---|---|
| 業務単位の再利用 | BookingBusinessに3操作をまとめる | createBookingServiceに3操作をまとめる |
| 24h/48hの変更 | propsのみ | 引数のみ |
| 親からの操作者の共有 | Providerの包含関係で表す | 引数で明示する |
| 業務関数・取得保存の定義 | 共通 | 共通 |
| 結果・内部trace・失敗停止 | 同一シナリオで一致 | 同左 |
| 組み立てソースの行数 | component.tsx 30行 | functions.ts 12行 |

行数はこの例の改行・共通層の分け方に依存する。コード量・実行性能・開発速度の一般的な優劣ではない。共通domain.tsとdefinitions.tsは両方式から使い、比較の一方だけから隠さない。通常関数版はdefineCommandを直接使うため、Applicationの実行キュー通知やContextのAPIを同等に持つとは主張しない。比較するのは業務の結果・内部trace・変更範囲。

今回、propsで業務部品を再利用する書き方は成立した。一方、同じ再利用は関数引数でも成立し、単独の予約業務では関数版の方が組み立てコードが少ない。JSXの主な追加価値は親から受ける依存と包含関係の表現であり、現時点で必須にする根拠は得られなかった。JSXはReactらしい組み立てを選びたい場合の任意の入口として維持する。核や各業務ルールをJSXタグへ分解しない。

## 検証したこと

- 24h/48hの別アプリで、同じid・別Repository・別Actorを並行処理。36h前は24h側だけ成功。
- 同じ部品の設定だけを48hから24hへ変えて結果が変わる。Hook・登録・実行コードは変更しない。
- 部品評価中にはload・save・時計を呼ばない。呼び出し元のpropsやActorを後から変更しても確保済みの設定が変わらない。時計の値は操作ごとに取得する。
- 申請→承認→キャンセル、認可不足、自己承認、期限の前後1ms、取得失敗、保存失敗、不正時計、不正設定を検査。
- 入力・エラー集合・検証済み証明を型検査し、両方式の結果・traceを比較。
- cancellationHoursを部品内部で24へ固定する誤実装は型検査を通るが、48hシナリオで拒否する。

## 見つかった制約と判断

同じアプリへBookingBusinessを二回置くと、同じ操作宣言と名前が重複するためDuplicateOperationで拒否する。別アプリでの再利用は可能だが、Reactのように任意個の同名部品インスタンスを一つのアプリに置けるとは言えない。この制約も検査し、二つ目の設定へ暗黙に切り替わらないことを確認する。将来一つのアプリ内に複数インスタンスが必要になったら、操作の識別と呼び出し方法を設計する必要がある。今回の二アプリの要件には必要なく、新しい名前空間APIを先回りして追加しない。

再描画やpropsの自動更新は行わない。設定を変える場合は新しいアプリを作る。メモリRepositoryはDB競合制御や再送・永続性を提供しない。これは保守者AIによる具体例の比較であり、人間のReact経験者の読みやすさや習得速度は未評価。構成の包含関係が見えることと、認知負荷の優位性が実証できたことは区別する。

予約IDと操作者IDはdomain.tsの検証付きBookingId / ActorIdで区別する。予約データと操作入力にはbookingId、認証済み操作者にはactorIdを使う。空・空白文字列や非文字列はResultの失敗で返す。verify.tsのvalidは既知のテストデータの成功を確認する補助であり、外部入力には成功・失敗の分岐を使う。JSX版・関数版で同じ型と純粋な業務関数を共有し、ID取り違えも型検査する。詳細は[識別子と接続の安全性](../../docs/identifier-safety.md)を参照。
