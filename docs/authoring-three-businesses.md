# 経費・休暇・会員登録を同じ公開APIで組み立てる

原音の未確定を理由に開発を止めず、資料で根拠づけられる設計とユーザー指定のReact風体験を具体化する。講演の完全再現という判定とは分ける。

## 利用する契約

全例で、純粋関数を `workflow(...).then(...)` で合成し、カスタムHookが `useOperation({ name, load, execute, save, replay })` を返す。`operationKey(name, useHook)` が入力・成功・エラー・詳細レポートを推論する。Repositoryと操作者はProviderで渡す。組み立て時にはI/Oを実行しない。

複数の業務部品は `Fragment` で並べる。これは新しい依存スコープも実行状態も持たない。Reactの再レンダリング・Effect・非同期コンポーネントの再現ではない。

公開の開発版importだけで組み立てる例は [three-businesses.tsx](../examples/authoring/three-businesses.tsx)。ホストがアダプターを渡し、呼出し側は同じアプリから次を使う。

```ts
await app.dispatch(replayedApproval, { requestId, input: { id, expectedVersion } });
await app.dispatch(replayedLeaveApproval, { requestId, input: { id } });
await app.dispatch(registrationRequest, { requestId, id, email });
await app.dispatch(registrationConfirmation, { requestId, id, token, now });
```

`inspect`は同じ入力で実行し、内部traceと再送のattemptを返す。第3引数のcaptureは明示した項目だけを記録する。`subscribeExecution`または生成時のobserverでlive spanを受け取る。inspectも保存を実行するので、プレビュー用途で重ねて実行しない。

## 各業務の境界

| 業務 | 純粋な合成 | I/O・保存・再送 |
| --- | --- | --- |
| 経費 | validateApproval → approve | 既存ReplaySqliteExpenses。承認保存とreceiptを同一transactionで保存 |
| 休暇 | authorizeLeave → approveLeave | SqliteReplayLeaves。pendingの確認・状態更新・receiptを同一transactionで保存 |
| 会員登録 | validateStart → start、validateConfirm → confirm | ReplayRegistrationRepository。登録状態・outbox・receiptを同一transactionで保存。メールと人の応答を待つ間はtransactionを保持しない |

会員登録のsecret生成・digest・読取りは明示的なProcess段階で、純粋な関数へは準備した入力だけを渡す。操作者は登録の本人認証を代用するものではなく、ホストが決めたセッション等の再送スコープである。確認はtokenを照合する。実メール配送は既存のoutbox worker/adapter契約を使う。メール事業者・常駐schedulerの完成は主張しない。

DBアダプターは例示用で、Node/SQLiteは公開runtimeに入れない。公開runtimeの外部依存は追加していない。古いAPIも維持し、npm公開は行わない。

## AIによる書き心地の評価と修正

この評価は保守者AIによる3業務の実装・導入・失敗経路の確認である。独立した人間の初回利用評価、開発速度の実測、一般的な生産性優位の証明ではない。

| 実際に詰まった点 | 修正 | 残る利用者の仕事 |
| --- | --- | --- |
| 複数のOperationを1コンポーネントから自然に返せない | 公開experimentalへFragmentを追加。Providerを共有する兄弟部品をそのまま並べる | コンポーネントと業務操作の構成を決める |
| 登録の合成関数をexportすると、privateな証明型により宣言生成がTS4023で失敗 | 検証証明は非公開のまま、StartChange / ConfirmationChangeを名前のある公開interfaceにする | 状態・業務関数・失敗型の定義は必要 |
| 登録と確認でload文脈の構築を重複記述 | 通常のgeneric関数loadRegistrationへ共通化 | token準備と確認用digestは異なるI/Oとして宣言する |
| digestの実装が旧入口・Hook・再送adapterで重複 | Web CryptoのdigestTokenをサンプル内で共有 | secretの生成・時刻・ホストの信頼境界を決める |
| 再送がメモリ上のハンドラだけで完成したと誤認し得る | 休暇・登録に永続DBの原子的receiptを接続 | 本番DBのtransaction、保管・権限、運用を設計する |

操作ハンドルの型引数、Hookの戻り型注釈、Resultの手書き接続は3例とも追加していない。業務関数の通常の引数・戻り値と、Repositoryの構造的な契約は残す。異なる入力形状や失敗型を、見た目を統一するためだけに潰さない。

`save`と`replay.lookup`へ同じホスト由来のidentityを渡す接続は残る。これは保存の原子性・再送スコープを決めるadapter契約であり、単なる関数配列から安全に推測できない。汎用の再送helperは今回追加しない。

## 検証範囲

- 登録・休暇の追加テスト：DB接続を閉じた後の再送、同時要求で一度のcommit、receipt失敗によるrollback、操作者の分離、内部captureとlive終端通知。
- 登録の失敗：誤ったtokenで遷移・保存へ進まない。別tokenで作った保存identityに正しい決定結果を付けても保存しない。
- 兄弟部品の並行実行：Providerの操作者と実行IDを分離する。
- 配布物：3業務を開発版tarballからimportしてTypeScript 6/7、Node型なしで型検査・宣言生成。その宣言だけのconsumerでも閉じた戻り型と必須入力を維持する。

人の応答や外部配送を待つアプリケーションの運用は別の課題である。また、任意のgeneric変換・inline推論を無制限に保証してはいない。experimental入口の契約を上記の具体例で固定するが、正式な安定版公開を宣言するものではない。

## 今回固定したAPIの受け入れ条件

1. 部品の評価だけでは業務を実行しない。dispatch/inspectが実行境界になる。
2. Workflowを渡せば内部ルールのtraceを保ち、失敗した後の遷移・保存を実行しない。
3. Providerの操作者はリクエストpayloadから取得せず、各Hookで実行に必要な値を確保する。兄弟部品・同時実行で混ぜない。
4. 再送のreceiptが見つかった場合は業務を再実行せずattempt:nullとする。DB保存とreceiptはadapterが原子的に保存する。
5. 操作の入力・成功・失敗型はHookから推論し、export後の宣言ファイルでも維持する。型アサーションによる利用者の回避まで禁止するものではない。

今回のローカル検査は以下で成功した。

| コマンド | 結果・範囲 |
| --- | --- |
| npm run check | 全ソースの型検査 |
| npm test | 1266件成功 |
| npm run test:authoring:package | TS6/7、実tarball、3業務の構成・宣言生成と宣言consumer、既存の実行例と拒否対照 |
| npm run test:registration:package | 既存登録例の19件、別OSプロセス、狭い戻り型を広げる対照の拒否 |
| npm run test:portable | Fragmentを含む公開runtimeをNode globalなしで実行 |
| node scripts/check-runtime-package.mjs | 実行時依存ゼロ、29個のローカルJS moduleと公開宣言 |
| npm run test:lecture-records | 9件成功。原音確認とは区別 |

その後、3業務を同一Fragmentへ並べる並行実行テストを拡張し、該当3件と全ソースの型検査を再確認した。GitHub CIの結果や未実施の本番検証を、このローカル結果へ含めない。

配布物検査の後続確認では、新しい登録HookのSQLite統合も実tarball側へ移した。別workspaceの `integration` 内に例示用adapterと5件のテストを配置し、frameworkへの参照をすべてインストールしたkoyuki / koyuki/experimentalへ向けて実行する。DB再接続後の再送、確認、outbox/receiptのrollback、同時要求、tokenのidentity対応を確認した。Nodeを使うこの実行時検査は、Node型なしで検査する利用者コードとは分けており、Node型の追加インストールで宣言検査を通したものではない。さらに休暇の永続再送・rollbackと3業務の同時実行の3件も、同じインストール環境で成功した。ホストのSQLite adapterとその業務用コードだけを開発ツールでbundleし、koyukiはexternal importに残す。bundleの入力にsrc/frameworkが含まれないこと、出力の依存がkoyukiとnode:に限られることを検査する。これにより、元リポジトリのエンジンを混入させた検証と区別する。
