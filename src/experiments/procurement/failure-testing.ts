// Fixed test expectations, independent of the implementation declarations.
export const operations = [
  'requests.create', 'requests.edit', 'requests.submit', 'requests.withdraw', 'requests.approve', 'requests.reject', 'requests.return', 'requests.reassign',
  'orders.place', 'orders.amend', 'orders.cancel', 'orders.complete', 'receipts.receive', 'receipts.return', 'receipts.correct',
  'invoices.register', 'invoices.match', 'invoices.approve', 'invoices.void', 'payments.record', 'payments.cancel',
  'inventory.reserve', 'inventory.release', 'inventory.move', 'inventory.adjust',
].sort();
export const split = new Set(['inventory.reserve', 'inventory.release', 'inventory.move', 'inventory.adjust', 'requests.submit', 'requests.approve', 'orders.place', 'requests.edit', 'requests.withdraw', 'requests.reject', 'requests.return', 'requests.reassign',
  'orders.amend', 'orders.cancel', 'orders.complete', 'invoices.approve', 'invoices.void', 'receipts.receive', 'receipts.return', 'receipts.correct']);
// Independent expected topology of these host loaders, counting read (not related).
export const readCounts: Record<string, number> = Object.fromEntries(operations.map(name => [name, 1]));
readCounts['requests.create'] = 0;
for (const name of ['receipts.receive', 'invoices.match', 'invoices.approve', 'invoices.void']) readCounts[name] = 2;
for (const name of ['receipts.return', 'receipts.correct']) readCounts[name] = 3;

export const relatedCounts: Record<string, number> = Object.fromEntries(operations.map(name => [name, 0]));
for (const name of ['orders.place', 'receipts.receive', 'invoices.register', 'invoices.match', 'payments.record']) relatedCounts[name] = 1;
for (const name of ['orders.amend', 'orders.cancel', 'orders.complete', 'receipts.return', 'receipts.correct']) relatedCounts[name] = 2;
