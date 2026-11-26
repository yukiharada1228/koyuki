# 購買サンプルの保存値と再送の型

共通saveのgenericな戻り型は、adapter自身がその約束を守る場合に成立する。
今回、通常のStock実装クラスを保存すると、メモリ/SQLiteとも成功を返しながら
structuredCloneがprototypeのメソッドを失わせる反例を確認した。
Symbolキーや非列挙の証明も同様である。修正前の追加検査は6件中3件失敗した。

## サンプルadapterの契約

購買のメモリ/SQLite adapterは、保存前にplainなJSONデータだけを受け付ける。
通常のObject/Arrayのprototype、null・文字列・boolean・有限数を許可し、
独自prototype、Symbolキー、非列挙プロパティ、accessor、循環、配列の穴や付加属性、
undefined等をDataCloneErrorで拒否する。検査したaccessorのgetterは呼ばない。
保存値とwritesの検査は更新前に行い、SQLiteの実行receiptも作らない。
これは購買サンプルのDTO方針であり、Koyuki coreの制限ではない。
実体を保持するadapterなら、privateフィールドを持つクラスもcoreから渡せる。
任意のProxyや悪意ある実行環境まで保証する検査ではない。

通常DTOのliteral型とコピー所有権は保持する。DataCloneErrorはadapter契約違反であり、
自動で業務Conflictへ変換しない。

## 今回の値と過去の値を区別する

SQLiteの低水準commitExecutionはRepositoryExecution<T>を返す。
committedなら今回のT、replayedなら履歴から復元した広いCommittedである。
過去のversion:1を今回要求したversion:2として返すcastを除いた。
この低水準APIの利用者はkindで分岐する必要がある。core APIは変えていない。

公開操作では、初回lookup、結果不明後のlookup、競合commitから得た履歴の
モデルkindを検査する。状態はモデル全体の直和であり、今回の操作が予定した
厳密な次状態まで履歴から証明するものではない。

競合で再送になった際、今回の型付き試行を終える内部acknowledgementには
今回のchange.resultを使うが、それを公開したり保存したりはしない。
公開値は実際に取得した過去の結果とwritesである。
今回の計画がsubmittedでも、先に保存されたfirst-reviewを返す例を
plain/helper/Koyukiの3方式で検査した。

## 検証範囲

[追加検査](../src/procurement-storage-values.test.ts)は9件。
型検査、全1,097件、実際の配布物を使うconsumer763件が成功した。
consumer内だけでDTO検査を無効化する対照検査では、黙って情報を失う保存を検出する。
全入力の証明や独立利用者による試用ではない。

業務の接続構造は変更しておらず、成功130境界・代表失敗274境界、
I/O72箇所・178注入、capture入力374/結果196、CLI9宣言・25操作・52ラベルは従来の範囲。
講演の原音未確認箇所、部分充足9件、型推論の残る制約も変更しない。
独立した利用者の試用は未実施であり、保守者側の検査とは区別する。
