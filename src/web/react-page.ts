import { page } from './ui.js';
const style = page.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
export const reactPage = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tag Studio — React view</title><style>${style}</style></head><body><div id="root"><main>読み込んでいます…</main></div><script type="module" src="/assets/tag-view.js"></script></body></html>`;
