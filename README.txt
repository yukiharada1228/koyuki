Business React Lab

業務の状態・検証・遷移を宣言し、Resultの合成と取得・保存・実行管理を任せる
TypeScriptフレームワークの試作です。安定版APIではありません。

入口
src/framework/index.ts
src/tags/events.ts — 業務イベントの宣言
src/tags/model.ts — 取得・保存の登録
src/tags/program.ts — 操作と業務状態への反映
src/expenses/application.ts — 経費申請への適用

起動と検証（Node 26.12.0で確認）
npm ci
npm run check
npm test
npm run demo:expenses:sqlite
npm run dev

http://127.0.0.1:4317       タグ管理
http://127.0.0.1:4317/react React表示の利用例

業務の核はReactに依存しません。Reactは表示アダプターの一例です。
ローカルDBは.data/に生成されます。リポジトリには含めていません。

PUBLIC-API.txtと各RESULTS.txtに設計判断・検証結果・制約を記載しています。
planning/feature-issues.jsonはGitHub Issueの起票原稿です。

この試作は伊藤直也氏の以下の発表に着想を得ています。
https://www.youtube.com/watch?v=izV1h6o3hgQ
https://www.youtube.com/watch?v=qBf910_YiqA
https://www.youtube.com/watch?v=w0oLNoGsGLc
発表者による実装・監修・推奨を意味しません。

実認証、汎用の永続実行、自動再送等は未実装です。
ライセンス条件はまだ設定していません。
