/** @jsxRuntime automatic */
import type { Icon } from '../tags/domain.js';
import { useState, type FormEvent } from 'react';
import { useProgramView } from './use-program.js';
import type { connectTags } from './remote.js';
type Connection = Awaited<ReturnType<typeof connectTags>>;
const errors: Record<string, string> = { DuplicateLabel: '同じ名前のタグがあります。', ValidationError: 'タグ名や入力内容を確認してください。', TagLimitReached: '利用中のタグは3件までです。', SaveConflict: '別の更新がありました。画面を再読み込みしてください。' };
export function TagScreenView({ connection }: { connection: Connection }) {
  const { view } = useProgramView(connection.store);
  const [label, setLabel] = useState('');
  const [editing, setEditing] = useState<{ id: string; version: number; icon: Icon } | null>(null);
  const [networkError, setNetworkError] = useState('');
  const editable = view.actions.includes('create');
  async function submit(event: FormEvent) {
    event.preventDefault(); setNetworkError('');
    try {
      await connection.dispatch(editing
        ? { type: 'update', input: { ...editing, expectedVersion: editing.version, groupId: 'g', label, icon: editing.icon } }
        : { type: 'create', input: { groupId: 'g', label, icon: null } });
      if (!connection.store.getSnapshot().view.error) { setLabel(''); setEditing(null); }
    } catch (error) { setNetworkError(error instanceof Error ? error.message : '通信できませんでした。'); }
  }
  return <main>
    <header><div><div className="eyebrow">TAG STUDIO</div><h1>タグ管理</h1><p>タグを整理して、お客様とのつながりを分かりやすく。</p></div><a href="/">アーカイブ・グループ管理</a></header>
    <div className="grid"><section className="card"><h2>{editing ? 'タグを編集' : 'タグを作成'}</h2>
      <form onSubmit={submit}><label htmlFor="label">タグ名</label><input id="label" value={label} onChange={e => setLabel(e.target.value)} required maxLength={30} disabled={!editable || !!networkError} placeholder="例：常連のお客様" />
        <button type="submit" disabled={!editable || !!networkError}>{view.busy ? '保存しています…' : editing ? '変更を保存' : 'タグを作成'}</button>
        {editing && <button type="button" className="secondary" disabled={!editable} onClick={() => { setEditing(null); setLabel(''); }}>編集をやめる</button>}
      </form><p className="hint">メイングループの利用中タグを管理できます。上限は3件です。</p>
      <div role="status" aria-live="polite" className="message" data-state={view.error || networkError ? 'error' : ''}>{networkError || (view.error ? errors[view.error] ?? '処理できませんでした。' : view.busy ? '保存しています…' : '')}</div>
      {view.actions.includes('dismiss') && <button className="secondary" onClick={() => { void connection.dispatch({ type: 'dismiss' }).catch(error => setNetworkError(String(error))); }}>入力に戻る</button>}
      {networkError && <button className="secondary" onClick={() => location.reload()}>画面を再読み込み</button>}
    </section>
    <section className="card"><div className="list-head"><h2>登録したタグ</h2><span className="count">{view.rows.length} / 3 件</span></div>
      <TagList rows={view.rows} disabled={!editable || !!networkError} onEdit={row => { setEditing({ id: row.id, version: row.version, icon: connection.store.getSnapshot().state.data.find(tag => tag.data.id === row.id)?.data.icon ?? null }); setLabel(row.label); }} />
    </section></div>
  </main>;
}

type TagRow = { id: string; label: string; version: number };
export function TagList({ rows, disabled, onEdit }: { rows: readonly TagRow[]; disabled: boolean; onEdit: (row: TagRow) => void }) {
  return <div aria-live="polite">{rows.length ? rows.map(row => <div className="tag-row" key={row.id}><span className="tag-name">{row.label}</span><button className="edit" disabled={disabled} aria-label={row.label + 'を編集'} onClick={() => onEdit(row)}>編集</button></div>) : <p className="empty">まだタグがありません。</p>}</div>;
}
