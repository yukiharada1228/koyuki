import { createHash } from 'node:crypto';
import type { Result } from '../core.js';

/** Trusted local adapters. A name is a versioned semantic identity, not a display label. */
export interface Operation<I, O, E> {
  readonly name: string;
  readonly run: (input: I, context: { idempotencyKey: string }) => Promise<Result<O, E>>;
}
export const operation = <I, O, E>(definition: Operation<I, O, E>): Operation<I, O, E> => definition;
// Reject values for which JSON would silently lose identity information.
export function fingerprint(input: unknown): string {
  const seen = new Set<object>();
  function normalize(value: unknown): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value !== 'object' || value === null) throw new Error('NonSerializableInput');
    if (seen.has(value)) throw new Error('CyclicInput');
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map(normalize);
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
        throw new Error('NonPlainInput');
      if (Object.getOwnPropertySymbols(value).length) throw new Error('SymbolInput');
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize((value as Record<string, unknown>)[key])]));
    } finally { seen.delete(value); }
  }
  return createHash('sha256').update(JSON.stringify(normalize(input))).digest('hex');
}
const copy = <T>(value: T): T => structuredClone(value);
interface Completed { readonly signature: string; readonly value: unknown }
interface Pending { readonly signature: string; readonly promise: Promise<unknown> }
export class Journal {
  readonly completed = new Map<string, Completed>();
  // Coordination is shared by runtime instances using this journal; single process only.
  readonly pending = new Map<string, Pending>();
}
export class Execution {
  readonly trace: string[] = [];
  afterExternal?: (name: string) => void;
  constructor(readonly journal = new Journal()) {}
  async call<I, O, E>(scope: string, slot: string, op: Operation<I, O, E>, input: I): Promise<Result<O, E>> {
    // Clone now: subsequent caller mutation cannot change the executed payload.
    const captured = copy(input);
    const key = JSON.stringify([scope, slot]);
    const signature = `${op.name}:${fingerprint(captured)}`;
    const existing = this.journal.completed.get(key);
    if (existing) {
      if (existing.signature !== signature) throw new Error('OperationIdentityMismatch');
      this.trace.push(`replay:${op.name}`);
      // The cast is confined to the journal boundary; signature includes operation and input.
      return copy(existing.value as Result<O, E>);
    }
    const pending = this.journal.pending.get(key);
    if (pending) {
      if (pending.signature !== signature) throw new Error('OperationIdentityMismatch');
      return copy(await pending.promise as Result<O, E>);
    }
    // Defer execution until the claim is installed, including synchronously reentrant adapters.
    const promise = Promise.resolve().then(async () => {
      this.trace.push(`start:${op.name}`);
      const result = await op.run(captured, { idempotencyKey: key });
      this.afterExternal?.(op.name);
      // Business errors are terminal for this invocation. Infrastructure exceptions aren't cached.
      this.journal.completed.set(key, { signature, value: copy(result) });
      this.trace.push(`complete:${op.name}:${result.ok ? 'ok' : 'error'}`);
      return result;
    });
    this.journal.pending.set(key, { signature, promise });
    try { return copy(await promise); } finally { this.journal.pending.delete(key); }
  }
}
export interface Context { execution: Execution; scope: string }
// Typed composition stays here; JSX does not connect arbitrary sibling output/input types.
export class Program<A, E> {
  constructor(readonly label: string, private readonly evaluate: (context: Context) => Promise<Result<A, E>>) {}
  run(context: Context): Promise<Result<A, E>> { return this.evaluate(context); }
  flatMap<B, F>(next: (value: A) => Program<B, F>): Program<B, E | F> {
    return new Program<B, E | F>(`${this.label}→bind`, async context => {
      const result = await this.run(context);
      return result.ok ? next(result.value).run(context) : result;
    });
  }
}
export function call<I, O, E>(slot: string, op: Operation<I, O, E>, input: I): Program<O, E> {
  // Capture at declaration time, not only at execution time.
  const captured = copy(input);
  return new Program(op.name, context => context.execution.call(context.scope, slot, op, captured));
}
export function h3<P>(component: (props: P) => Program<unknown, unknown>, props: P): Program<unknown, unknown> {
  return component(props);
}
export namespace h3 { export namespace JSX { export type Element = Program<unknown, unknown>; } }
