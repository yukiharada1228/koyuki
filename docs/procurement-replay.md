# 購買25操作の永続再送境界

`procurementReplay`が既存の25操作を再利用し、実行要求ごとの再送制御を接続する。
coreのwithReplay/replayOperationsを使い、別の再送エンジンは実装しない。
SQLiteの実行記録と業務writesを同じtransactionに保存する。

```ts
const commands = procurementReplay(repository, authenticatedActor, policy);
const result = await commands.requests.create.run({
  requestId: 'call-001',
  input: { id: 'rq-001', lines: [{ sku: 'a', quantity: 2, unitCents: 500 }] },
});
```

成功は`Execution<Committed<Model>>`。committedは今回保存した結果、replayedは過去の結果である。
業務IDとrequestIdは別物。同じgroup内のrequestIdを異なる入力・actor・操作へ使うとReplayMismatchになる。
入力型と結果モデルは元の操作から維持する。操作ごとのResult接続や再送定義は不要。

## 要求の同一性と権限境界

Web CryptoのSHA-256で、操作ID・actorのID/role/group・入力をまとめたfingerprintを作る。
objectのキー順を正規化し、配列順は維持する。循環・undefined・非有限数・関数・Date等、
JSON DTOとして扱えない値は拒否する。requestId・操作ID・actor/group IDは前後空白なしの1〜200文字。
coreが先に入力をcloneできない場合はReplayInputNotCloneable、DTO正規化の拒否はInvalidReplayRequestとなる。

actorとpolicyはfactory生成時にsnapshotする。lookup前にactiveとactor識別情報を検証し、
無効なactorは保存済み成功にもアクセスしない。SQLite hostはtrusted groupをconstructorで固定する。
これは認証基盤ではなく、hostが認証・現在の権限を確認して渡したactorを信頼する設計である。
権限変更を反映するにはfreshな認証contextからfactoryを作る等のhost側の境界が必要。
ユーザー入力のactorやfingerprintを、そのままtrusted contextとして採用しない。

操作IDは`procurement.request.v1.create`等で固定する。同じIDの意味や正規化方式を変更すると、
過去の記録との互換性を検討する必要がある。hashは要求の同一性の比較であり、署名・DB改竄検知ではない。

## 保存と競合

lookupで過去成功がなければ元のload → domain → saveを実行する。
各呼出し専用のRepositoryを生成し、そのcommitを実行要求に結び付ける。
共有の「現在のrequestId」変数は置かない。変わるのはhostの保存境界で、25操作のdomainを複製しない。

SQLiteのBEGIN IMMEDIATE内でも記録を再照会する。
同じ要求の先行成功があれば、その出力をreplayedとして返し、古い計画を書き込まない。
未保存なら業務の全writesと実行記録を保存してCOMMITする。
実行記録の挿入が失敗した場合も業務writesをROLLBACKする。
保存前の業務失敗は成功記録を残さない。

競合相手が先に保存すると、後発のload/domainがConflict以外のAlreadyExists等で止まる場合もある。
そのため共通境界は想定内の失敗後に成功記録を照会する。再実行はしない。
同じ要求の記録があれば過去成功を返し、なければ元の失敗を返す。
actorの無効化・要求不一致はlookupでも拒否する。

hostが明示的にCommitUnknownと分類した結果も、この照会で解決できる。
任意の例外を自動的にCommitUnknownへ変換しない。想定外の例外はrejectし、
後から同じ要求で明示的に照会／再送する際に保存済み記録を確認する。
外部の送金・メールまで含めたexactly-once、自動retry、バックグラウンドschedulerは提供しない。

実行記録はresultと全writesを状態別に復元し、結果がwritesに含まれること・group・重複を検査する。
不正記録はCorruptProcurementExecutionで停止し、missingとして再実行しない。
既存データの履歴全体や悪意あるDB書換えを証明するものではない。

## Applicationと観測

`procurementReplayApplication`は同じ25操作を既存replayOperationsで登録する。
committedだけを投影し、replayedの古い値を現在のViewへ適用しない。
initialが空の新sessionで過去要求を照会しても、その過去値でViewを初期化しない。
最新状態の初期取得・他sessionとの同期はhostが行う。

runDetailedは実行した場合に元のbusiness traceを保持する。
lookupだけの再送はattemptがnullで、load/domain/saveを実行しない。
通常businessにある任意capture引数を、このサンプルの再送wrapperへ転送するAPIはまだ用意していない。

## 検証した範囲と残る評価

`src/procurement-replay.test.ts`の12シナリオを実配布consumerでも実行する。
キー順によらない要求同一性と変更拒否、actor/group境界、DB再開後の過去結果、
記録挿入失敗のrollback、2接続の同要求保存、型付き25操作の登録、実行trace、
応答消失の照会、Applicationの投影維持、複数の重複呼出しを確認する。
2つのlookupをmissingで待ち合わせ、後発loadに作成済み発注を読ませることで、AlreadyExistsから過去成功を取得する経路も決定的に検証する。
申請から承認・発注・入荷・請求照合・返品までを再送版でつなぎ、
返品時の発注・検収・請求・在庫と実行記録の原子性も検証する。

25操作を再送可能な型付きテーブルへ登録したことと、全25操作のあらゆる障害経路を網羅したことは別である。
残る操作の再送シナリオ拡充、別OSの同時writer、高負荷、停電復旧、他DBは未検証。
成功記録の保持期間・削除・監査用途のschemaと権限はhostの運用方針が必要。
記録を削除した後まで、過去要求の再実行を防ぐ保証はない。
通常TS/helperとの同条件比較と独立利用者による開発体験評価は引き続き未実施。
