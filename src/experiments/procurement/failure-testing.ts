// Fixed test expectations, independent of the implementation declarations.
export const operations = [
  'requests.create', 'requests.edit', 'requests.submit', 'requests.withdraw', 'requests.approve', 'requests.reject', 'requests.return', 'requests.reassign',
  'orders.place', 'orders.amend', 'orders.cancel', 'orders.complete', 'receipts.receive', 'receipts.return', 'receipts.correct',
  'invoices.register', 'invoices.match', 'invoices.approve', 'invoices.void', 'payments.record', 'payments.cancel',
  'inventory.reserve', 'inventory.release', 'inventory.move', 'inventory.adjust',
].sort();
export const split = new Set(['requests.create', 'inventory.reserve', 'inventory.release', 'inventory.move', 'inventory.adjust', 'requests.submit', 'requests.approve', 'orders.place', 'requests.edit', 'requests.withdraw', 'requests.reject', 'requests.return', 'requests.reassign',
  'orders.amend', 'orders.cancel', 'orders.complete', 'invoices.approve', 'invoices.void', 'receipts.receive', 'receipts.return', 'receipts.correct']);
// Independent expected topology of these host loaders, counting read (not related).
export const readCounts: Record<string, number> = Object.fromEntries(operations.map(name => [name, 1]));
readCounts['requests.create'] = 0;
for (const name of ['receipts.receive', 'invoices.match', 'invoices.approve', 'invoices.void']) readCounts[name] = 2;
for (const name of ['receipts.return', 'receipts.correct']) readCounts[name] = 3;

export const relatedCounts: Record<string, number> = Object.fromEntries(operations.map(name => [name, 0]));
for (const name of ['orders.place', 'receipts.receive', 'invoices.register', 'invoices.match', 'payments.record']) relatedCounts[name] = 1;
for (const name of ['orders.amend', 'orders.cancel', 'orders.complete', 'receipts.return', 'receipts.correct']) relatedCounts[name] = 2;

export const threeStage = new Set(['requests.create', 'receipts.return']);

// Fixed trace names, not reflected from the runtime declaration under test.
export const ruleSteps = (operation: string): string[] => operation === 'requests.create'
  ? ['authorize-creation', 'parse-lines', 'create-request-plan']
  : operation === 'requests.edit' ? ['run:1', 'require-draft', 'parse-lines', 'edit-request-plan']
  : operation === 'receipts.correct'
  ? ['run:1', 'revalidate-correction', 'correct-receipt-plan', 'run:3']
  : threeStage.has(operation) ? ['run:1', 'run:2', 'run:3'] : split.has(operation) ? ['run:1', 'run:2'] : ['run:1'];
