import { Repository } from '../tags/repository.js';
import { tagProgram } from '../tags/program.js';
// A terminal presentation adapter. The same subscription can feed an HTTP/SSE or DOM adapter.
const repository = new Repository();
const session = await tagProgram(repository).start();
const unsubscribe = session.subscribe(({ revision, view }) => console.log(JSON.stringify({ revision, ...view })));
await session.dispatch({ type: 'create', input: { groupId: 'g', label: 'VIP', icon: null } });
const row = session.snapshot().view.rows[0];
if (!row) throw new Error('ExpectedCreatedTag');
await session.dispatch({ type: 'update', input: { id: row.id, groupId: 'g', label: 'Regular', icon: null, expectedVersion: row.version } });
await session.dispatch({ type: 'create', input: { groupId: 'g', label: '', icon: null } });
await session.dispatch({ type: 'dismiss' });
unsubscribe();
console.log(JSON.stringify({ trace: session.trace(), io: repository.calls }, null, 2));
