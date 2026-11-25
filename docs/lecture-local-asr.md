# 保存動画の音声を別経路で認識する

保存済みのYouTube自動字幕だけへの依存を減らすため、ローカル動画の音声を
whisper.cppで認識する検証を開始した。字幕や初期promptは認識処理へ渡さない。
音声は外部サービスへuploadせず、元音声と認識本文はローカルにだけ保存する。

モデルは[whisper.cppのモデル表](https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md)にある
large-v3-turbo-q5_0。配布元のSHA-1と一致することを確認し、実ファイルのSHA-256も記録した。
whisper.cpp 1.9.5、ffmpeg 9.0.2を使用する。
コアの依存へ追加したものではなく、既存のローカルCLIを使う資料確認ツールである。

## 2分間の試行

[試行の来歴](lecture-local-asr-pilot.json)を保存した。
w0oLNoGsGLcの21:55–23:55から16kHz・monoのPCM音声を取り出し、日本語として認識した。
14区間の認識本文を保存済み字幕と読み比べた。
前後状態を引数と戻り値に表すこと、途中状態を調べられること、履歴を取りたい場合のdumpという
中心的な説明は、この別経路のテキストにも現れていた。

一方、両方の認識に用語の誤りが残る。別モデルのテキストが一致しても、
発話の正確性や話者の意図の正しさを自動的に証明しない。
認識結果を読み比べたのであり、この試行を直接の音声視聴として数えない。
モデルの学習データとの重なりも不明で、統計的に独立した根拠とは呼ばない。

## 全3本の処理

```sh
node scripts/transcribe-lecture-audio.mjs /path/to/saved-videos /path/to/ggml-large-v3-turbo-q5_0.bin /path/to/new-output-directory
```

入力は保存済みの3つのMP4。既存の出力先は上書きせず拒否するため、
再起動時は元のprocessとmanifestを確認し、処理中のjobを重ねて開始しない。
tool自体はモデルや動画のdownloadを行わない。
音声decode→日本語ASRを1本ずつ実行し、進行状況をローカルmanifestへ記録する。
元動画・PCM音声・モデル・認識JSON・collectorのhashとCLI versionを残す。
失敗時はmanifestをfailedにし、完了済みの動画とlogを保持する。

本記録を追加した時点では、全3本の処理は実行中であり、完了・全テキスト確認とは扱わない。
終了後も、処理した音声秒数は「正しく理解した発話」の割合ではない。
無音・脱落・誤認識・幻覚的な補完は別途点検し、保存済み字幕と異なる箇所を再確認する。

連続した全編音声映像の直接確認・全フレーム・全参照資料・全実装の等価性は未確認のまま。
[講演への判定](lecture-acceptance.md)は部分充足を維持する。
