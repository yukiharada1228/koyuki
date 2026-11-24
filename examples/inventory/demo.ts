import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inventoryCommands } from './application.js';
import { SqliteInventory } from './repository.js';

const dir = mkdtempSync(join(tmpdir(), 'koyuki-demo-'));
const repository = new SqliteInventory(join(dir, 'inventory.sqlite'));
try {
  const seeded = repository.seed('tea', 10); assert(seeded.ok);
  const commands = inventoryCommands(repository);
  const request = { requestId: 'reserve-1', orderId: 'order-1', sku: 'tea', quantity: 6 };
  const held = await commands.reserve.run(request); assert(held.ok);
  console.log('引当:', JSON.stringify(held));
  const replay = await commands.reserve.run(request); assert(replay.ok && replay.value.kind === 'replayed'); assert.deepEqual(replay.value.value, held.value.value);
  console.log('同じ要求の再送（追加引当なし）:', JSON.stringify(replay));
  const shortage = await commands.reserve.run({ ...request, requestId: 'reserve-2', orderId: 'order-2', quantity: 5 });
  assert(!shortage.ok && shortage.error.kind === 'InsufficientStock');
  console.log('在庫不足:', JSON.stringify(shortage));
  const confirmed = await commands.confirm.run({ ...request, requestId: 'confirm-1' }); assert(confirmed.ok);
  console.log('確定:', JSON.stringify(confirmed));
  const second = { requestId: 'reserve-3', orderId: 'order-3', sku: 'tea', quantity: 2 };
  assert((await commands.reserve.run(second)).ok);
  const cancelled = await commands.cancel.run({ ...second, requestId: 'cancel-3' }); assert(cancelled.ok);
  console.log('キャンセル（引当を戻す）:', JSON.stringify(cancelled));
  const oldReplay = await commands.reserve.run(request); assert(oldReplay.ok && oldReplay.value.kind === 'replayed'); assert.deepEqual(oldReplay.value.value, held.value.value);
  console.log('確定後の古い要求の再送（DBは巻き戻さない）:', JSON.stringify(oldReplay));
  const stock = repository.stock('tea'); assert(stock.ok);
  assert.equal(stock.value.onHand, 4); assert.equal(stock.value.reserved, 0);
  console.log('最終在庫:', JSON.stringify(stock.value));
} finally { repository.close(); rmSync(dir, { recursive: true, force: true }); }
