import { ok, err, type Result } from 'koyuki';
import type { Actor, Expense, Loaded, Ports, StoreError, VersionInput } from './contracts.js';
/** Supplied evaluation adapter; one record and an in-process CAS, not production storage. */
export function createHost(initial: Expense) {
  let row = structuredClone(initial), loads = 0, saves = 0, writes = 0, unavailable = false;
  return {
    ports(identity: Actor): Ports {
      const actor = Object.freeze({ ...identity });
      return {
        load: async <I extends VersionInput>(input: I): Promise<Result<Loaded<I>, StoreError>> => {
          loads++; return input.id === row.id ? ok({ input, actor, current: structuredClone(row) }) : err({ kind: 'NotFound' });
        },
        save: async <T extends Expense>(next: T): Promise<Result<T, StoreError>> => {
          saves++; if (unavailable) return err({ kind: 'SaveUnavailable' });
          if (next.id !== row.id || next.version !== row.version + 1) return err({ kind: 'Conflict' });
          row = structuredClone(next); writes++; return ok(structuredClone(next));
        },
      };
    },
    row: () => structuredClone(row),
    counts: () => ({ loads, saves, writes }),
    unavailable(value: boolean) { unavailable = value; },
  };
}
