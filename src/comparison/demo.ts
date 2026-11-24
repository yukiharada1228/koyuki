import { Backend } from './domain.js';
import { Execution } from './kernel.js';
import { createProcesses } from './components.js';
import { reservationInline, reservationShared } from './plain.js';
const input = { kind: 'reservation-candidate' as const, id: 'demo', seats: 2 };
for (const mode of ['jsx', 'inline', 'shared-ts'] as const) {
  const backend = new Backend(), execution = new Execution();
  const result = mode === 'jsx'
    ? await createProcesses(backend).ReservationProcess({ input }).run({ execution, scope: 'reservation:demo' })
    : mode === 'inline'
      ? await reservationInline(execution, 'reservation:demo', backend, input)
      : await reservationShared(execution, 'reservation:demo', backend, input);
  console.log(JSON.stringify({ mode, result, effects: backend.events, trace: execution.trace }, null, 2));
}
