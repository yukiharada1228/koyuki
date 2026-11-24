import { viewStore } from './store.js';
import type { TagMessage, TagPresentation, TagScreen } from '../tags/program.js';
import type { ProgramSnapshot } from '../framework/program.js';
export type TagSnapshot = ProgramSnapshot<TagScreen, TagPresentation>;
export type UserMessage = Extract<TagMessage, { type: 'create' | 'update' | 'dismiss' }>;
export async function connectTags() {
  const response = await fetch('/api/program', { method: 'POST' });
  if (!response.ok) throw new Error('初期データを読み込めませんでした。画面を再読み込みしてください。');
  const { id, snapshot } = await response.json() as { id: string; snapshot: TagSnapshot };
  const store = viewStore(snapshot);
  let pending = false;
  return {
    store,
    async dispatch(message: UserMessage) {
      if (pending) return;
      pending = true;
      try {
        const response = await fetch('/api/program/' + encodeURIComponent(id), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, revision: store.getSnapshot().revision }) });
        if (!response.ok || !response.body) throw new Error('接続が切れました。画面を再読み込みしてください。');
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '', completed = false;
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          buffer += part.value;
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line) continue;
            const frame = JSON.parse(line) as { snapshot?: TagSnapshot; error?: string; result?: { ok: boolean } };
            if (frame.snapshot) store.publish(frame.snapshot);
            if (frame.result?.ok) completed = true;
            if (frame.error || frame.result?.ok === false) throw new Error('操作を完了できませんでした。画面を再読み込みしてください。');
          }
        }
        if (!completed) throw new Error('通信が中断されました。画面を再読み込みしてください。');
      } finally { pending = false; }
    },
  };
}
