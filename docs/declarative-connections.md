# 業務の依存とイベント接続を宣言する

開発版`koyuki/experimental`の新しい操作宣言。必要な情報を`needs`、発生イベントを`emits`、受け手を`On`で一度宣言すると、取得の順序・値の組み立て・失敗停止・保存後の配送をruntimeへ任せられる。Reactらしい業務部品を推奨する組み立て方とし、業務の核は通常のTypeScript関数のままにする。実行時外部依存は追加しない。

## 試す

リポジトリのルートで実行する。SQLite統合検証はNode.js 26で確認する。公開済みnpm alpha.5にはこのAPIは含まれず、開発版tarballを用意する。

```sh
npm ci
npm run prepare:connections -- ../my-connected-bookings
cd ../my-connected-bookings
npm install
npm run check
npm start
npm test
```

既存フォルダーは上書きしない。準備後は元リポジトリのimportを使わず、配布パッケージだけで実行する。実メールは送らない。startはメモリ、testはSQLiteの永続化・rollback・再接続も検証する。

## 取得と業務の接続

実際の[予約業務](../src/experiments/declarative-booking/business.tsx)は次の宣言を持つ。

```ts
const approveBooking = defineOperation('booking.approve.v1', {
  needs: { booking, actor },
  execute: approval,
  useSave: useSaveBooking,
  emits: [emit(bookingConfirmed)],
});
```

`booking`は一度定義したresource。同期のカスタムHookでRepositoryを取得し、要求ごとにロードする関数を返す。`actor`はホストが認証したProviderの値を使うresourceであり、操作入力のactorを採用しない。

```ts
const booking = defineResource('current-booking', () => {
  const repository = useContext(Bookings);
  return (input: Input) => repository.load(input);
});
const actor = defineResource('authenticated-actor', () => {
  const value = Object.freeze({ ...useContext(ActorContext) });
  return () => ok(value);
});
```

runtimeが`{ booking, actor }`を組み立て、`approval`へ渡す。各操作でloadのResultを分岐して値を取り出す必要はない。操作入力はresourceの要求から推論し、業務関数へ渡すフィールドや保存の型も検査する。resourceを使わないホスト提供値は、引き続きContext内で確保できる。

業務関数は次のような普通の合成であり、JSXやRepositoryなしで実行・テストできる。

```ts
const approval = workflow('validate-approval', validateApproval)
  .then('approve', approve);
```

権限確認が必要という判断と業務上の順序は、この合成で一度記述する。runtimeは受け渡し・停止・実行を担当する。同じ型だから業務上も接続してよい、と推測しない。

## 取得同士が依存する場合

`defineResource(name, { needs, useLoad })`で、取得に必要な事実を宣言できる。

```ts
const profile = defineResource('profile', {
  needs: { booking },
  useLoad: () => {
    const directory = useContext(Directory);
    return ({ booking }: { booking: Booking }) => directory.load(booking.owner);
  },
});
```

booking→profileという取得順序を組み立て、同じ操作のneedsが両方を要求してもbookingを一回だけ取得する。循環はマウントで拒否する。取得失敗なら依存する取得・業務計算・保存へ進まない。独立した取得は宣言順に実行し、並列化を勝手に選ばない。キャッシュは一回の操作実行内に限り、別要求や別のイベント受け手で使い回さない。

新しい操作形式は要求データをI/O前にsnapshotし、取得と保存へ同じ要求を渡す。要求はWeb標準で複製可能なデータとする。resourceが返すRepository等のサービス自体を複製するものではない。loaderや業務関数を任意に純粋にする保証はなく、resourceに隠れた書き込みを入れない。

## イベントの接続

通知部品は受け取るイベントと操作を一度宣言する。

```tsx
function NotificationBusiness({ sender }: { sender: MailSender }) {
  return (
    <MailContext.Provider value={sender}>
      <On event={bookingConfirmed} operation={notifyBooking} />
    </MailContext.Provider>
  );
}
```

`On`は、そのProvider内で消費側操作を登録し、イベントを接続する。呼び出し側で`if (approved.ok) await sendMail(...)`を書く必要はない。受け手の入力型がイベントのpayloadを受け取れなければコンパイルエラーとなる。同じpayload型だけを理由に別イベントへ配送しない。

イベントの宣言には名前とpayloadの型を与える。保存済みイベントを外から配送する場合には同期の`decode`も定義し、未検証の保存データをそのまま業務へ渡さない。`emit(event)`は業務計算の成功値をpayloadにし、`emit(event, project)`は公開するpayloadを選ぶ。射影は保存前に実行されるため、射影の不具合で保存済み処理を未保存扱いにしない。

マウント時に、イベント名の衝突・受け手の欠落・イベント接続の循環を拒否する。外部システムだけが受け取るイベントは`defineEvent(name, { external: true })`で明示する。自動配送は幅優先・受け手の登録順。同一イベントの独立した受け手は、一つが失敗しても残りを実行し、それぞれの結果を記録する。既定の配送上限は1000で、`maxDeliveries`で設定できる。

## 申請→承認→通知

人の承認を待つ場合はBookingBusinessを登録し、本人の申請とmanagerの承認をそれぞれ明示的な要求として実行する。承認後の通知は自動で接続される。

自動承認を業務上の方針として選ぶ場合は、サンプルのAutomaticBookingBusinessを使う。

```tsx
const app = createApplication(
  <ActorContext.Provider value={applicant}>
    <Fragment>
      <AutomaticBookingBusiness repository={repository} approver={approver} />
      <NotificationBusiness sender={sender} />
    </Fragment>
  </ActorContext.Provider>
);
const report = await app.executeDetailed(requestAutomaticApproval, { id: 'one' });
```

この一回の実行から、申請保存→申請イベント→承認→承認イベント→通知が進む。自動承認用のActorはホストが明示して渡す。申請者が入力でmanager権限を指定できる設計ではなく、runtimeが人の承認を推測して省略することもない。純粋な承認ルールと、どのイベントを承認操作へつなぐかというポリシーを区別する。

`report.result`は元の申請操作の結果であり、後続処理の最終状態ではない。後続の成否は`report.deliveries`で確認し、確定した状態を取得したい場合はRepositoryへ問い合わせる。

## 保存と配送の契約

`useSave`はProvider内で一度評価する同期Hookで、保存関数を返す。その関数には、業務計算の成功値・要求・発生イベントの配列を渡す。保存adapterは状態とイベントを一つのtransactionで保存する。runtimeは保存成功を確認してから配送し、取得・業務・保存の失敗では配送しない。

業務の成功と配送の成功は別である。承認の保存後にメールが失敗しても、承認を未保存扱いにせず、`deliveries`へerror/defectを記録する。`execute`は業務のResultを返す。配送を観測する場合は`executeDetailed`または`subscribeDelivery`を使う。実行通知は操作単位、配送記録はイベントidと受け手単位であり、親のcompleted通知だけで全配送完了を判断しない。

`useReplay`を宣言した操作は、成功済み要求を再送しても新しいイベントを発生させない。途中で停止して未配送になったイベントは、保存済みのenvelopeを`app.deliver(envelope)`へ渡して復旧する。イベント名で接続済みの受け手を選び、decode後に配送する。受け手の欠落・未知のイベントは黙って成功にしない。

workerは一つのイベントidに対する全受け手が成功したときに、そのイベントをackする。後続で新たに保存されたイベントは別のoutbox項目として扱う。配送はat-least-onceであり、送信完了後のクラッシュ等で重複し得る。受け手には永続的な冪等性や送信先のidempotency keyが必要。自動承認例は保存した承認イベントをreceiptとして再利用し、再配送でも承認を二重保存・再発行しない。メール事業者のexactly-once、本番scheduler、backoffやdead letterを提供したという意味ではない。

SQLite例は承認状態とoutboxを同時保存し、イベントINSERT失敗のrollback、再接続後の配送、壊れた保存データの拒否を検証する。receiptとして使う履歴の保持期限・削除方針は別途設計する。メモリ例は再起動すると記録を失う。

## 組み立てと制限

カスタムHookで取得したハンドラーをProcess.effectへ渡す詳細合成でも、子操作のイベントを引き継ぐ。通常の非同期関数で`handler.run`を包むと内部はopaqueになるため、自動接続が必要な場合はハンドラーのオブジェクト全体を使う。アプリ外でハンドラーだけを実行しても、JSXで登録した受け手は存在しない。

同じ操作宣言を一つのアプリ内で二回登録できない点は従来どおり。Onが登録する操作を別のOperationとして二重登録しない。別アプリでは同じ業務部品・宣言を再利用でき、取得結果とイベントのキューは要求・アプリごとに分離する。設定変更は新しいアプリを作って適用する。再描画やuseState/useEffectの実装ではなく、状態・viewの既存APIとの統合まで完成したとはしない。

この変更で、取得結果の組み立てや配送先の呼び出しという定型処理をruntimeへ移した。どの業務を接続すべきか、どの情報が必要かという業務上の意味は一度宣言する。自動推測で補うものではない。

## 検証

```sh
npm run test:connections:package
```

実tarballへTypeScript 6/7を接続し、入力・文脈・保存・イベントpayloadの不適合を拒否すること、宣言生成、実行、SQLiteでのrollback・再接続を確認する。自動配送を取り除いた反例が業務テストで失敗することも確認する。`npm run test:portable`は依存取得とイベント配送をNodeグローバルなしのブラウザー用bundleで検査する。

## JSXの構成から状態とviewへ

`createApplication(JSX)`で登録した操作は、`app.start(...)`から既存のApplicationの状態管理にも接続できる。新しい状態機械を増やさず、`ready / running / failed / crashed`、購読、要求のsnapshot、同一セッション内の実行順序とrevision検査を再利用する。

```ts
const screen = defineView({
  initial: (): { accepted: readonly string[] } => ({ accepted: [] }),
  operations: {
    request: projection(requestAutomaticApproval,
      (state: { accepted: readonly string[] }, result) => ({
        accepted: [...new Set([...state.accepted, result.value.id])],
      })),
  },
  view: state => ({
    accepted: state.data.accepted,
    busy: state.kind === 'running',
    error: state.kind === 'failed' ? state.error : null,
  }),
});
const session = await app.start(screen);
const unsubscribe = session.subscribe(snapshot => console.log(snapshot.view));
await session.dispatch({ type: 'request', input: { id: 'two' } });
unsubscribe();
```

`defineView`・`projection`は`koyuki/experimental`からimportする。`defineView`は再利用する定義の型推論を保持するための関数で、同じ内容をstartへ直接渡してもよい。operationはJSXに登録した同じオブジェクトを参照する。ここでは再登録せず、表示用の操作名と成功値の反映方法を宣言する。要求・成功・失敗の型を保持し、viewのstateとエラーは推論する。通常の業務型や表示データ型は必要である。

- startと購読では業務I/Oを実行しない。未登録操作・同じ操作の重複したprojectionはstartで拒否する。
- dispatchごとにrunningを通知し、取得・計算・保存・自動配送には同じ実行経路を使う。業務失敗はfailed、例外やprojectionの例外はcrashedとなり、直前の表示データを保持する。dismissでreadyへ戻れる。保存後の表示計算が失敗してもDBは巻き戻らないため、再実行時は業務の再送契約が必要である。
- 各startは独立した表示状態と実行キューを持つ。snapshotや購読へ返す値を変更しても内部状態は変わらない。複数セッションは同じRepositoryを共有できるが、DB側の競合制御は引き続き必要。
- sessionのdispatchが返すResultは「状態機械が要求を受け付けたか」である。業務の成否はsnapshot.stateのkind/errorを見る。業務Resultや詳細traceそのものが必要な箇所ではapp.execute / executeDetailedも引き続き使える。
- projectionはdispatchした**起点操作の結果**を表示データへ反映する。自動配送先の状態を勝手に表示へマージしない。例のacceptedは申請受付であり、DBの最新承認状態を表すものではない。後続状態が必要なら認可済みqueryで読み直す等の表示方針を実装する。
- 再送でもprojectionは実行する。成功件数を無条件に加算するのではなく、idで置換・重複除去する等、表示側でも再送の意味を扱う。receiptは過去の結果であり、最新のDB状態とは限らない。
- app.executeや別セッションのdispatchで、既存のsessionの表示状態は自動更新されない。session.subscribeはそのsessionの状態だけを購読する。subscribeExecution / subscribeDeliveryは同じapp全体の通知であり、セッション専用のフィルターではない。操作者の境界は引き続きアプリのProviderで分ける。

実行例は`connected/demo.tsx`に含む。経費・休暇・会員登録のSQLite例でも、同じstart / defineView / projectionで再送結果から表示を更新し、表示セッションが独立することを検査する。Reactの再描画やuseState/useEffectを実装したという意味ではなく、業務操作の実行と表示用の状態管理を同じ入口から使えるようにしたものである。
