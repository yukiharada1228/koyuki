# 同じ生成契約をタグのメモリ・SQLiteへ適用する

[タグの生成検査](../src/tag-model-sequences.test.ts)は、独立した参照仕様から操作列を作り、
同じ列と期待値をRepositoryとSqliteTagRepositoryへ適用する。
期待値の計算にdomain validator・constructor・transition・repositoryの戻り値を使わない。
実際の実行はtagModelのTargetとcreateTagEvent/updateTagEventを通す。

```sh
npx tsx --test src/tag-model-sequences.test.ts
npm run test:business:package
```

## 参照仕様と実装を分ける

モデルはgグループ、上限3、作成と名前変更を対象とし、各タグのlabelとversionを保持する。
操作はcreateまたはrenameで、renameは論理slotとcurrent/stale versionを選ぶ。
ラベル候補には空白、30/31文字、trimとNFCで同じになる値も含める。

| 条件 | 指定した期待仕様 |
| --- | --- |
| 不正なラベル | ValidationError |
| 他タグと重複する正規化ラベル | DuplicateLabel |
| 件数3で別名を作成 | TagLimitReached |
| 存在しないslotの変更 | NotFound |
| 古いversionを指定した変更 | SaveConflict |
| 作成成功 | version 1、末尾sortOrder、件数増加 |
| 変更成功 | IDとsortOrderを維持し、versionを1増加 |

重複は作成上限より先に判定する。変更では対象の存在とversionを入力検証より先に確認する。
失敗時の参照状態は変えない。これらの優先順位も、実装出力から推測せずモデルへ明記する。

sampleModelはここでは参照列の生成に使い、checkが辺を記録する。
**この段階のsampledだけでadapterとの一致を判定しない。**
その後、テスト側が同じ列をasync/awaitで順に実行し、全結果と全保存状態を比較してから成功する。
sampleModel自体へ非同期checkを追加したものではない。

## IDと保存状態

メモリ版の連番とSQLite版のUUIDを同じ文字列と仮定しない。
作成成功時に論理slotと実IDを対応付け、新しいIDが空や重複ではないことを確認する。
変更時はそのIDを使い、毎操作の前後でID・group・label・icon・version・sortOrderを検査する。
モデルからID生成器の内部状態を省く代わりに、新規性と安定した同一性を明示的に確認する。

seedは0、1、42、99、2^32-1。各64操作、adapterごとに320操作を検査した。
同じseedの生成結果が一致することと、5種類の想定内失敗が実際に含まれることもassertする。
SQLiteは実際のDatabaseSyncを:memory:で使う。ファイル永続化・復旧・別接続競合の証明ではない。
各seedで新しいfixtureを作り、実装間で保存データや期待値を流用しない。
実tarballの独立consumerにも同じテストとhost側adapterを含める。

## 残る範囲

Issue #8のタグ・共通adapter契約の具体例。全グループ、icon、archive/restore、並行競合、
失敗注入、実運用の全状態を同じ生成器で検証したものではない。
[非同期反例縮小](async-model-sequences.md)も追加した。各比較でfixtureとbefore状態を再構築し、
古いversionを無視する故意のwrapperを両adapterで検出してcreate→stale renameへ縮める。
sampler自体がDBを自動でrollbackするものではなく、隔離と後片付けはhostの比較関数が行う。
[payload候補の縮小](event-payload-shrinking.md)も追加し、故意のwrapperに対してlabelをBから空文字へ簡略化しても不一致を保てることを確認した。全候補での最短列やテスト雛形の出力は残る。
講演の全内容を完全実現したという根拠や、生成検査だけでの普遍的な正しさの証明にはしない。
