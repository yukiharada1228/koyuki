# React風の組み立て試作と講演の対応を再点検する

基準実装は3cab583d63e699d6ba132d36fe84962d0e59a62f。ここからJSX経由のlive観測の接続を追加する。原資料の発話を再確認した記録ではなく、対応する実装・検査の追加である。3講演84話題のstatus、原音と全フレームの確認フラグは変更しない。

## 実装と検査

| 講演の論点 | 現在の具体的な経路 | 検証と残件 |
| --- | --- | --- |
| iz-22：イベントの接続と実行を任せ、業務の状態遷移に集中する | 部品・Context・カスタムHookでload/合成Workflow/saveを登録し、dispatchで既存Commandを実行 | 経費・休暇の両方で同じランタイムを使用。組み立て時のI/Oゼロ、失敗停止、必須入力の型保持。開発版experimentalサブパスの実tarballを別プロジェクトで試用。APIの確定と一般的な使いやすさの実証は別の残件 |
| iz-24・qbf-19：Resultの接続と型記述の負担 | 業務関数は既存workflow/thenで合成し、HookにはWorkflow自体を渡す。再送は同じ業務関数へ境界を追加 | 接続callback不要だが、業務関数の通常の型と操作ハンドルの型宣言は必要。一般の多相変換・外側generic actorの特殊化の制限は別に残る |
| w0o-13：途中状態と処理の観測 | 従来の完了後レポートに加え、JSX createApplicationから既存executionSession/instrumentationへ接続 | I/O待機中のspan-started、検証・遷移の個別span、結果・例外の終端通知を検査。値の選択capture、永続履歴、分散相関の新しい保証は加えていない |

JSX/Hooks/Providerは、ユーザーが明示したKoyukiの体験設計である。講演がこれらのAPIを指定した、またはReactの内部実装の再現を求めたとは解釈しない。

## 再送と観測の接続で埋めた不足

3cab583では、Hookが要求ごとのCommandを包むときに詳細実行のlive能力が引き継がれず、完了したtraceを取得できても実行中の通知は届かなかった。

commandForのrunDetailedへ既存のregisterDetailedを接続し、要求ごとのCommandをinvokeDetailed経由で呼ぶ。Operation登録時もbindDetailedFunctionで能力とreceiverを保持する。アプリ側は既存のexecutionSessionを使い、dispatch・inspectの同じ実行にID・span・終端通知を付ける。新たな実行エンジンや独自の例外変換は導入しない。

[専用検査](../src/react-business-execution.test.tsx)は、loadを待機させたままイベントを読み、完了後にまとめて出した通知ではないことを確認する。同じアプリの並行実行では別々のexecutionIdが付き、各spanが一度だけ閉じる。loadの例外は元の例外としてrejectし、spanと実行をdefectで閉じる。観測者のthrow/rejectが保存結果を変えないことも検査する。

[再送検査](../src/react-business-replay.test.tsx)では、最初の実行で内部検証のlive spanが届き、receiptから再送結果を返す場合には業務spanが発生しないことを確認する。再送側のlookup等のspanは引き続き記録する。

このアプリはサーバーの独立した操作実行の入口であり、既存defineApplicationのprojection状態機械と同一のAPIではない。ここでの観測追加だけでReact/Elmの開発体験全体や講演全体の完成とは判断しない。

## 完成判定へ残す項目

- 原音10区間・連続画面などの未確認範囲を、実装テストで確認済みに置き換えない。
- 型推論の制限は具体的な正例・反例で改善する。検証条件を弱めて正例だけ通す方法を採らない。
- ユーザー指定のAI評価を継続する。初見の人間の学習負担と同等の実証と呼ばず、人間の協力者を開発継続の必須条件にもしない。
- APIの安定化、配布物としての導入、実運用に属する残件は、該当する根拠を得るまで未完了として保持する。

## 開発版の配布物へ接続する

後続でランタイムをsrc/framework/authoring.tsへ移し、koyuki/experimentalとして開発版tarballからimportできるようにした。従来の試作用runtime.tsは互換再exportだけを残す。npm registryの公開版は変更していない。

[配布物検査](../scripts/test-authoring-package.mjs)は、実際の経費・休暇の例と業務型を別ディレクトリへコピーし、frameworkへの相対importを含めずに実tarballへ依存する。TypeScript 6/7のNode型なしの検査、宣言生成、その宣言だけを使う別consumerを検査する。成功値の型比較を壊す対照は型検査で失敗し、保存回数の期待値を壊す対照は実行で失敗する。

準備モードはtarballのhash・基準commit・framework等の未commit変更の有無をDEVELOPMENT.jsonに残す。基準commitだけで作業中のtarball内容を同定したことにはしない。既存ディレクトリは上書きしない。

公開物に含めた新しいmoduleも、実行時依存ゼロのpackage検査とNode globalなしのVM実行の対象に加えた。これは開発版の導入経路の成立であり、独立した人間の評価・API安定化・講演全体の完成ではない。
