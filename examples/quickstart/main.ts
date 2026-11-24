import assert from 'node:assert/strict';
import { ok, err, step, defineTarget, defineApplication, operation, type Result } from 'koyuki';

// State: raw user input becomes a validated tag before storage.
export interface CreateTag { readonly id: string; readonly name: string }
declare const validName: unique symbol;
export type TagName = string & { readonly [validName]: true };
export interface Tag { readonly id: string; readonly name: TagName }
export type ValidInput = Readonly<{ id: string; name: TagName }>;
export function validate(input: CreateTag): Result<ValidInput, { kind: 'InvalidTag' }> {
  const name = input.name.trim();
  if (!input.id.trim() || !name || name.length > 30) return err({ kind: 'InvalidTag' });
  return ok({ id: input.id, name: name as TagName });
}
export const created = {
  validate: step('validate-tag', validate),
  require: [] as const,
  evolve: step('create-tag', (input: ValidInput): Result<Tag, never> => ok({ ...input })),
};

// Single-process adapter; uniqueness must be enforced atomically in a real DB too.
export function tagExample() {
  const records = new Map<string, Tag>();
  let writes = 0;
  const create = defineTarget({
    operation: 'tag.create.v1',
    load: async (input: CreateTag) => ok(input),
    save: async (tag: Tag): Promise<Result<Tag, { kind: 'DuplicateTag' }>> => {
      if (records.has(tag.id) || [...records.values()].some(current => current.name === tag.name)) return err({ kind: 'DuplicateTag' });
      records.set(tag.id, tag); writes++; return ok(tag);
    },
  }).on(created);
  const application = defineApplication({
    initial: (): readonly Tag[] => [],
    operations: { create: operation(create, (tags: readonly Tag[], tag) => [...tags, tag]) },
    view: state => ({ tags: state.data, busy: state.kind === 'running', error: state.kind === 'failed' ? state.error.kind : null }),
  });
  return { create, application, writes: () => writes };
}

const example = tagExample();
const session = await example.application.start();
await session.dispatch({ type: 'create', input: { id: 'tag-1', name: '  Koyuki  ' } });
assert.deepEqual(session.snapshot().view.tags, [{ id: 'tag-1', name: 'Koyuki' }]);
await session.dispatch({ type: 'create', input: { id: 'tag-2', name: ' ' } });
assert.equal(session.snapshot().view.error, 'InvalidTag');
assert.equal(example.writes(), 1); // Invalid input never reaches save.
await session.dispatch({ type: 'dismiss' });
await session.dispatch({ type: 'create', input: { id: 'tag-3', name: 'Koyuki' } });
assert.equal(session.snapshot().view.error, 'DuplicateTag');
assert.equal(example.writes(), 1);
assert.equal(session.snapshot().view.tags.length, 1); // Failure preserves prior data.
console.log(JSON.stringify(session.snapshot().view));
