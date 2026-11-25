# 複数モデルの更新結果をApplicationへ渡す

購買評価アプリの25操作を既存Applicationへ接続した。
新しいcore APIは増やさず、サンプルの保存結果と投影の契約を整理した。
ブラウザ画面の描画を実装したものではなく、Viewへ公開する状態と実行ライフサイクルの検証である。

## 通常結果と変更全体

`procurement(repository, actor, policy)`はこれまでどおり業務結果Entityを返す。
`procurementChanges(repository, actor, policy)`は同じ操作宣言・domain・repositoryを使い、
成功時に`{ result, writes }`を返す。resultは通常結果、writesは保存へ渡した全モデルのsnapshotである。

例として返品は、検収のreturnedに加えて発注version、請求の未照合化、在庫数も変える。
この4モデルを一つの結果へ含め、単一の検収結果から副次的な変更を推測しない。
保存前にwritesをcloneし、保存が失敗したときは変更結果を公開しない。
テスト済みのMemory/SQLite adapterは指定されたwritesを同じ保存単位で確定する。
任意のadapterが値を変換した場合やDB triggerが保存値を変更した場合に、DBから実値を読み直す機能ではない。

通常版・変更全体版は内部の一つの宣言を共有する。
保存モードに対応する型のassertionは内部へ限定し、利用者が操作ごとに結果型を指定する必要はない。
共通saveの結果がRequest Unionである制限はそのままで、approveのresultをApprovedだけへ狭めたとは主張しない。

## Applicationと投影

`procurementApplication(repository, actor, policy, initial)`が既存defineApplicationを組み立てる。
操作名はrequest.create、receipt.return、invoice.approve等とし、requestとinvoiceのapproveが衝突しない。
モデル別の6テーブルを名前付きで登録し、25操作をApplication用に一つずつ書き直さない。
名前の付与はサンプル内の小さなhelperであり、フレームワークの新しい汎用namespace APIではない。

`applyCommitted`はwritesをkind/idで投影へ反映する純粋関数である。
groupの違う値を拒否し、既知versionより古い値で状態を巻き戻さない。
入力を破壊せず、更新値をcloneして取り込む。削除ではなく終端状態を残す、このサンプルのモデルに対応する。
同versionで異なる値が来る等、任意の分散同期プロトコルを検証するものではない。

Applicationがrunning → ready/failed/crashed、通知、入力型、完了とView更新を管理する。
業務失敗やadapter例外のときは前の投影を保持する。
これは「DB保存が常に失敗している」という意味ではない。DB結果が不明な例外には再送照会などが必要で、
追加した[再送版](procurement-replay.md)では成功記録を照会する。任意の例外を不明commitへ自動変換しない。

initialの読込みはhostが用意する。別sessionや別ユーザーの更新を自動購読しない。
空のinitialなら、このsessionで保存したモデルだけがViewへ現れる。
actorはsessionに固定されるため、承認者・倉庫担当等の間で投影を共有する場合は、hostが再取得や配送を設計する。
永続projection、再接続時の全自動同期、JSXでの画面表示までを追加したものではない。

## 検証

- 返品で返る全4モデルがMemory adapterの保存値と一致する。
- Applicationの一回の完了で発注・検収・請求・在庫が更新され、runningとreadyを通知する。
- 認可失敗とadapter欠陥は投影を変えない。
- 別groupを拒否し、古いversionの結果で既知の値を巻き戻さない。
- 25操作を同じ宣言から登録し、名前空間と操作固有の必須入力を型で維持する。
- SQLiteの最後の在庫書込みを失敗させ、rollback後のApplication投影も維持する。dismiss後の明示的な再実行成功で全モデルを反映する。

`src/procurement-projection.test.ts`と`src/procurement-sqlite.test.ts`で実行し、
`npm run test:business:package`でも実tarballの公開APIを使って検査する。
大規模開発の認知負担や通常TS/helperとの差は未測定。再送シナリオの拡充・比較評価は継続する。


[独立Applicationとの比較](procurement-application-comparison.md)でも、再送時に過去値を適用しない方針を検証した。
応答消失直後の復旧でも自動refreshしないため、初期値が空なら保存済み行がViewへ現れない場合がある。
これは未解消のhost取得境界で、3方式の挙動一致を表示上の制約の解消とは扱わない。
