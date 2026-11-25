import test from 'node:test';
import assert from 'node:assert/strict';
import { withReplay, business, ok, err, type Execution, type Result, type Receipt } from './framework/index.js';
const invalid = err({ kind: 'ReplayInputNotCloneable' });
function unsupported() {
  class Domain { #value = 2; value() { return this.#value; } }
  class DomainArray extends Array<number> {}
  class DomainMap extends Map<string, number> {}
  const hidden = Object.defineProperty({ amount: 2 }, 'proof', { value: true });
  const regexp = /amount/g; regexp.lastIndex = 1;
  const map = Object.assign(new Map(), { purpose: 'must-not-disappear' });
  const date = Object.assign(new Date(0), { purpose: 'must-not-disappear' });
  const bytes = Object.assign(new Uint8Array([1]), { purpose: 'must-not-disappear' });
  return [
    { [Symbol('proof')]: true, amount: 2 }, { nested: { [Symbol('proof')]: true } },
    Object.assign([1], { [Symbol('proof')]: true }), hidden, new Domain(), new DomainArray(1, 2), new DomainMap(),
    new Map([['value', new Domain()]]), new Set([new Domain()]),
    regexp, map, date, bytes, { callback: () => {} }, Symbol('value'),
  ];
}
for (const detailed of [false, true]) test(`lossy request copies stop before lookup and execution / detailed=${detailed}`, async () => {
  let lookups = 0, runs = 0;
  const command = withReplay({ run: async (_input: unknown): Promise<Result<Execution<number>, never>> => { runs++; return ok({ kind: 'committed', value: 2 }); } }, {
    lookup: async (): Promise<Result<Receipt<number>, never>> => { lookups++; return ok({ kind: 'missing' }); }, resolveAfter: () => false,
  });
  for (const input of unsupported()) {
    if (detailed) {
      const report = await command.runDetailed(input);
      assert.deepEqual(report.result, invalid); assert.deepEqual(report.trace, [{ kind: 'snapshot', status: 'error' }]); assert.equal(report.attempt, null);
    } else assert.deepEqual(await command.run(input), invalid);
  }
  assert.equal(lookups, 0); assert.equal(runs, 0);
});

test('request snapshots do not evaluate root, nested or collection accessors', async () => {
  let gets = 0, lookups = 0;
  const accessor = () => ({ get amount() { gets++; throw new Error('private-getter-message'); } });
  const command = withReplay({ run: async (_input: unknown) => ok({ kind: 'committed' as const, value: 1 }) }, {
    lookup: () => { lookups++; return ok({ kind: 'missing' as const }); }, resolveAfter: () => false,
  });
  for (const input of [accessor(), { nested: accessor() }, new Map([['value', accessor()]]), new Set([accessor()])]) {
    assert.deepEqual(await command.run(input), invalid);
  }
  assert.equal(gets, 0); assert.equal(lookups, 0);
});

test('shared memory and views cannot bypass request ownership', async () => {
  if (typeof SharedArrayBuffer === 'undefined') return;
  let runs = 0, lookups = 0;
  const shared = new SharedArrayBuffer(4);
  const hiddenShared = new SharedArrayBuffer(4); Object.setPrototypeOf(hiddenShared, Object.prototype);
  const hiddenMap = new Map([['shared', hiddenShared]]); Object.setPrototypeOf(hiddenMap, Object.prototype);
  const command = withReplay({ run: async (_input: unknown) => { runs++; return ok({ kind: 'committed' as const, value: 1 }); } }, {
    lookup: () => { lookups++; return ok({ kind: 'missing' as const }); }, resolveAfter: () => false,
  });
  for (const input of [shared, new Uint8Array(shared), new DataView(shared), { nested: shared }, hiddenShared, { nested: hiddenShared }, hiddenMap]) assert.deepEqual(await command.run(input), invalid);
  assert.equal(runs, 0); assert.equal(lookups, 0);
});

test('data graphs retain aliases, cycles, collection values and independent binary storage', async () => {
  type Row = { amount: number };
  type Request = { left: Row; right: Row; date: Date; map: Map<string, Row>; set: Set<Row>; regexp: RegExp;
    buffer: ArrayBuffer; bytes: Uint8Array; view: DataView; rows: (Row | undefined)[] & { purpose: string };
    optional: undefined; big: bigint; nan: number; self?: Request };
  const row = { amount: 2 }, buffer = new ArrayBuffer(4), bytes = new Uint8Array(buffer); bytes[0] = 3;
  const rows = Object.assign([row, , row], { purpose: 'kept' });
  const input: Request = { left: row, right: row, date: new Date(0), map: new Map([['row', row]]), set: new Set([row]), regexp: /amount/g,
    buffer, bytes, view: new DataView(buffer), rows, optional: undefined, big: 2n, nan: NaN };
  input.self = input;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let owned: Request | undefined, runs = 0;
  const command = withReplay({ run: async (request: Request) => {
    runs++; assert.strictEqual(request, owned); return ok({ kind: 'committed' as const, value: request.left.amount });
  } }, { lookup: async (request: Request) => { owned = request; await gate; return ok({ kind: 'missing' as const }); }, resolveAfter: () => false });
  const pending = command.run(input);
  row.amount = 99; input.date.setTime(99); input.map.clear(); input.set.clear(); bytes[0] = 99; input.regexp.lastIndex = 3;
  release(); assert.deepEqual(await pending, ok({ kind: 'committed', value: 2 })); assert.equal(runs, 1); assert(owned);
  assert.notStrictEqual(owned, input); assert.strictEqual(owned.self, owned); assert.strictEqual(owned.left, owned.right);
  assert.strictEqual(owned.map.get('row'), owned.left); assert(owned.set.has(owned.left)); assert.equal(owned.date.getTime(), 0);
  assert.equal(owned.regexp.source, 'amount'); assert.equal(owned.regexp.flags, 'g'); assert.equal(owned.regexp.lastIndex, 0);
  assert.notStrictEqual(owned.buffer, buffer); assert.strictEqual(owned.bytes.buffer, owned.buffer); assert.strictEqual(owned.view.buffer, owned.buffer);
  assert.equal(owned.bytes[0], 3); assert.equal(owned.rows.purpose, 'kept'); assert(!(1 in owned.rows)); assert.strictEqual(owned.rows[0], owned.left);
  assert(Object.hasOwn(owned, 'optional')); assert.equal(owned.optional, undefined); assert.equal(owned.big, 2n); assert(Number.isNaN(owned.nan));
});

test('frozen enumerable request data remains supported', async () => {
  const input = Object.freeze({ rows: Object.freeze([Object.freeze({ amount: 2 })]) });
  const command = withReplay({ run: async (request: typeof input) => ok({ kind: 'committed' as const, value: request.rows[0]!.amount }) }, {
    lookup: () => ok({ kind: 'missing' as const }), resolveAfter: () => false,
  });
  assert.deepEqual(await command.run(input), ok({ kind: 'committed', value: 2 }));
});

test('business replay rejects lost proof before loading or saving', async () => {
  const proof = Symbol('proof'); let loads = 0, saves = 0, lookups = 0;
  type Request = { amount: number; [proof]: true };
  const app = business({ name: 'proof-request', load: async (input: Request) => { loads++; assert(input[proof]); return ok(input.amount); },
    save: async (value: number): Promise<Result<Execution<number>, never>> => { saves++; return ok({ kind: 'committed', value }); },
    operations: { change: [(value: number) => ok(value)] },
    replay: { lookup: () => { lookups++; return ok({ kind: 'missing' as const }); }, resolveAfter: [] },
  });
  assert.deepEqual(await app.change({ amount: 2, [proof]: true }), invalid);
  assert.equal(loads, 0); assert.equal(saves, 0); assert.equal(lookups, 0);
});


test('null-prototype records retain their prototype through aliases and collection entries', async () => {
  const record: { amount: number; self?: unknown } = Object.assign(Object.create(null), { amount: 2 }); record.self = record;
  const input = { record, alias: record, map: new Map([[record, record]]), set: new Set([record]) };
  const command = withReplay({ run: async (request: typeof input) => {
    assert.notStrictEqual(request.record, record); assert.equal(Object.getPrototypeOf(request.record), null);
    assert.strictEqual(request.record.self, request.record); assert.strictEqual(request.alias, request.record);
    assert.strictEqual(request.map.get(request.record), request.record); assert(request.set.has(request.record));
    return ok({ kind: 'committed' as const, value: request.record.amount });
  } }, { lookup: () => ok({ kind: 'missing' as const }), resolveAfter: () => false });
  assert.deepEqual(await command.run(input), ok({ kind: 'committed', value: 2 }));
  assert.equal(Object.getPrototypeOf(record), null); assert.equal(record.amount, 2);
});
