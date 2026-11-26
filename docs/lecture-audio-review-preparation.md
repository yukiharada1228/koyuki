# 未確定10区間の原音確認資料

原音確認の残件を、実際に聞いて判断できる形に準備した。
これは直接音声を確認した記録ではない。全10件の確認票はpendingであり、
既存のaudioDirectlyReviewed/allFramesReviewedと講演のstatusは変更しない。

## 手元の確認資料

保存先は`/Users/yukiharada/Downloads/functional-business-talks/direct-audio-review-1b5a65f`。
README.mdに10個のWAVへのリンク、元時刻、未確定の理由がある。
各区間の前後8秒も含め、合計220.3秒。音声認識やノイズ処理はせず、
保存済みMP4の最初の音声トラックをPCMへデコードした。
元動画・確認記録・クリップのhashと切出し時刻をmanifest.jsonへ記録した。
音声ファイルはローカルのみで、リポジトリへ転載・外部サービスへアップロードしていない。

聞き取った方はreview-template.jsonへ、確認者・確認日時、聞き取った文言、
解釈、実装への影響を記録する。不明な項目はpending/unclearのまま残す。
文脈が足りなければ元動画へ戻る。再生できたことだけで文言を確定しない。
確認票は下書きであり、既存の根拠へ自動反映する仕組みは設けていない。
発話が確定した場合も、字幕との違い・解釈・実装への影響を個別に再評価する必要がある。

## 再現と検査

```sh
node scripts/prepare-lecture-audio-review.mjs \
  /path/to/functional-business-talks \
  /path/to/new-review-directory
```

ffmpeg/ffprobeを使うローカル開発ツールであり、frameworkの実行時依存ではない。
既存の3つのASR比較記録のneedsDirectAudioを読み、固定の10件を別に手入力しない。
出力先は新しいディレクトリに限り、前の資料や記入済み確認票を上書きしない。
途中失敗時はmanifestのpreparingと実際のファイルを点検し、同じ場所へ自動再試行しない。

[準備の来歴と検査結果](lecture-audio-review-preparation.json)には、元記録と一致する10区間、
クリップのhash、期待長から0.15秒以内の長さ、確認票の未記入状態、manifestとのhash連携を記録した。
同じ出力先への再実行が失敗し、manifestを変更しないことも確認した。
これは確認者が実際に聞いたことや文言の正しさを検証する検査ではない。

原資料の全編音声・全画面の確認、独立利用者による試用、講演全体の完全実現は未完了のままである。
