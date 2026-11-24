import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('public', { recursive: true });
const result = await build({ entryPoints: ['browser.ts'], outfile: 'public/browser.js', bundle: true, platform: 'browser', format: 'esm', metafile: true });
for (const output of Object.values(result.metafile.outputs)) if (output.imports.length) throw new Error('External browser import');
writeFileSync('public/index.html', `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Koyuki runtime check</title><style>body{font:16px system-ui;max-width:920px;margin:40px auto;padding:0 20px}button{font:inherit;padding:12px}pre{white-space:pre-wrap;background:#f3f5f8;padding:20px}</style><h1>Koyuki browser / Workers check</h1><p>同じ業務定義で通常実行・再送・詳細記録を検証します。状態は各検証内のみで保持します。</p><button id="run">検証する</button><pre id="result" data-status="idle">Ready</pre><script type="module" src="/browser.js"></script></html>`);
