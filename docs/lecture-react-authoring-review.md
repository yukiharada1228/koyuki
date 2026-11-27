# React風の組み立て試作と講演の対応を再点検する

基準実装は3cab583d63e699d6ba132d36fe84962d0e59a62f。ここからJSX経由のlive観測の接続を追加する。原資料の発話を再確認した記録ではなく、対応する実装・検査の追加である。3講演84話題のstatus、原音と全フレームの確認フラグは変更しない。

## 実装と検査

| 講演の論点 | 現在の具体的な経路 | 検証と残件 |
| --- | --- | --- |
| iz-22：イベントの接続と実行を任せ、業務の状態遷移に集中する | 部品・Context・カスタムHookでload/合成Workflow/saveを登録し、dispatchで既存Commandを実行 | 経費・休暇の両方で同じランタイムを使用。組み立て時のI/Oゼロ、失敗停止、必須入力の型保持。開発版experimentalサブパスの実tarballを別プロジェクトで試用。APIの確定と一般的な使いやすさの実証は別の残件 |
| iz-24・qbf-19：Resultの接続と型記述の負担 | 業務関数は既存workflow/thenで合成し、HookにはWorkflow自体を渡す。再送は同じ業務関数へ境界を追加 | 接続callback不要だが、業務関数の通常の型は必要。操作ハンドルの型はカスタムHookから推論する。一般の多相変換・外側generic actorの特殊化の制限は別に残る |
| w0o-13：途中状態と処理の観測 | 従来の完了後レポートに加え、JSX createApplicationから既存executionSession/instrumentationへ接続 | I/O待機中のspan-started、検証・遷移の個別span、結果・例外の終端通知を検査。選択captureから必要な状態の変化も取得する。永続履歴と分散相関は別の残件 |

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

## 操作ハンドルの重複型指定を減らす

後続でoperationKey(name, useCustomHook)の推論を追加し、経費・再送経費・休暇の3例を移行した。以前必要だったハンドルの型引数合計10個が0個になった。安定した識別子はHookとハンドルで共有する。ハンドル作成時にはHookを実行しない。

[推論検査](../src/authoring-inferred-key.test.tsx)は通常と再送の異なる詳細形式、厳密な成功・エラー型、矛盾した詳細実行の拒否を対象にする。既存の配布物検査では移行後の実ソースを使い、生成した宣言だけを読むconsumerも同じ型を確認する。新しい実行機構・Result・Hooksの実行規則を追加したものではない。

iz-22/24・qbf-19の記述負担への具体的な改善として扱い、原音確認・一般の多相変換・API安定化・人間の学習負担の残件と区別する。これだけで講演全体の完成としない。

## 途中I/Oを含む組み立て

[詳細形式のProcessの接続](authoring-process.md)を追加し、権限検証後のポリシー照会と純粋な上限判定・状態生成をHooksから接続した。iz-17/20/21とw0o-14の計算とI/Oの分離を新しい組み立て入口でも扱う具体例である。Processの公開型を追加し、利用者が合成したProcessをexportする際の宣言生成も修正する。同期Ruleへ非同期処理を混ぜず、既存のProcess・Action・Commandを利用する。原音確認・一般の推論・API安定化等の残件と各statusは維持する。

## 選択した途中状態をHooksの入口でも取得する

[選択capture](authoring-capture.md)をinspectへ接続した。明示した内部段階へ既存の観測能力を引き継ぎ、必要な入力・結果だけを一度の実行から取得する。未選択項目を観測用に複製せず、capture失敗は業務Resultと分離する。live spanとの併用、途中I/O、再送時の業務段階の省略、並行captureを検査し、実tarballのTypeScript 6/7でも元の結果型・再送attempt・選択値の型を保持する。w0o-13の観測論点への追加実装であり、永続履歴・運用・原音等の残件とstatusは維持する。
