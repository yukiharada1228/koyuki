import { decide, parseRequest, type Action, type Request, type DomainError } from './domain.js';
import type { Actor, ExpenseState } from '../../expenses/domain.js';
import { ok, type Result, type Execution } from '../../framework/index.js';
import type { EventEnvelope } from '../../framework/authoring.js';
import type { Repository, StorageError } from './repository.js';
/** Same domain and storage contract; explicit orchestration without the Koyuki authoring runtime. */
export async function executePlain<A extends Action>(repository: Repository, actor: Actor, action: A, raw: Request<A>, notify: (event: EventEnvelope) => Promise<unknown>): Promise<Result<Execution<ExpenseState>, DomainError | StorageError>> {
  const parsed = parseRequest(action, raw);
  if (!parsed.ok) return parsed;
  const request = parsed.value, identity = { action, actor };
  const cached = await repository.receipt(request, identity);
  if (!cached.ok) return cached;
  if (cached.value.kind === 'found') return ok({ kind: 'replayed', value: cached.value.value });
  let event: EventEnvelope | undefined;
  const attempt = async (): Promise<Result<Execution<ExpenseState>, DomainError | StorageError>> => {
    const loaded = await repository.load(request, actor);
    if (!loaded.ok) return loaded;
    const calculated = decide(action, loaded.value);
    if (!calculated.ok) return calculated;
    event = { id: crypto.randomUUID(), type: 'expense-budget.changed.v1', payload: structuredClone(calculated.value.expense.next) };
    return repository.save(calculated.value, request, identity, [event]);
  };
  const saved = await attempt();
  if (!saved.ok && (saved.error.kind === 'Conflict' || saved.error.kind === 'StorageFailed')) {
    const resolved = await repository.receipt(request, identity);
    if (!resolved.ok) return resolved;
    if (resolved.value.kind === 'found') return ok({ kind: 'replayed', value: resolved.value.value });
  }
  if (saved.ok && saved.value.kind === 'committed') {
    try { if (event) await notify(event); } catch { /* committed business success survives delivery failure */ }
  }
  return saved;
}
