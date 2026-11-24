/** @jsx h2 */
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { validate, confirm, type Raw, type Checked, type Candidate, type Saved, type Validated, Mailer } from './reservation.js';

export type State = Raw | Validated | Checked | Candidate | Saved
  | { kind: 'rejected'; id: string; reason: 'InvalidPartySize' | 'Full' }
  | { kind: 'conflict'; id: string }
  | { kind: 'notified'; id: string; receipt: string };
export type Event =
  | { type: 'advance' }
  | { type: 'availability'; version: number; remaining: number }
  | { type: 'saved'; value: Saved }
  | { type: 'conflict' }
  | { type: 'notified' };
// All domain judgments are deterministic; an invalid event is an execution defect.
export function decide(state: State, event: Event): State {
  if (state.kind === 'raw' && event.type === 'advance') {
    const r = validate(state);
    return r.ok ? r.value : { kind: 'rejected', id: state.id, reason: r.error };
  }
  if (state.kind === 'validated' && event.type === 'availability')
    return { ...state, kind: 'checked', version: event.version, remaining: event.remaining };
  if (state.kind === 'checked' && event.type === 'advance') {
    const r = confirm(state);
    return r.ok ? r.value : { kind: 'rejected', id: state.id, reason: r.error };
  }
  if (state.kind === 'candidate' && event.type === 'saved') return event.value;
  if (state.kind === 'candidate' && event.type === 'conflict') return { kind: 'conflict', id: state.id };
  if (state.kind === 'saved' && event.type === 'notified') return { kind: 'notified', id: state.id, receipt: state.receipt };
  throw new Error(`InvalidEvent:${state.kind}:${event.type}`);
}
export type Node =
  | { kind: 'advance' }
  | { kind: 'availability'; input: Validated }
  | { kind: 'save'; input: Candidate }
  | { kind: 'notify'; input: Saved }
  | { kind: 'done' };
export const Advance = (): Node => ({ kind: 'advance' });
export const Availability = ({ input }: { input: Validated }): Node => ({ kind: 'availability', input });
export const Save = ({ input }: { input: Candidate }): Node => ({ kind: 'save', input });
export const Notify = ({ input }: { input: Saved }): Node => ({ kind: 'notify', input });
export const Done = (): Node => ({ kind: 'done' });
export function h2<P>(component: (props: P) => Node, props: P): Node { return component(props); }
export namespace h2 { export namespace JSX { export type Element = Node; } }
// No closures, adapters, arbitrary keys or external IO in the declarative tree.
export function ReservationProcess({ state }: { state: State }): Node {
  switch (state.kind) {
    case 'raw': case 'checked': return <Advance />;
    case 'validated': return <Availability input={state} />;
    case 'candidate': return <Save input={state} />;
    case 'saved': return <Notify input={state} />;
    case 'rejected': case 'conflict': case 'notified': return <Done />;
  }
}
interface RecordState { revision: number; initial: Raw; state: State }
interface Snapshot {
  version: number; remaining: number;
  records: Record<string, RecordState>;
  reservations: Record<string, Saved>;
  outbox: Record<string, { sent: boolean }>;
  journal: Record<string, { fingerprint: string; event: Event }>;
}
export class FileStore {
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
    mkdirSync(dirname(this.path), { recursive: true });
    try { readFileSync(this.path); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.write({ version: 0, remaining: 1, records: {}, reservations: {}, outbox: {}, journal: {} });
    }
  }
  read(): Snapshot { return JSON.parse(readFileSync(this.path, 'utf8')) as Snapshot; }
  write(snapshot: Snapshot): void {
    // Whole snapshot gives atomic visibility for this single-process experiment.
    // No fsync/power-loss guarantee and no multi-process transaction support.
    writeFileSync(this.path + '.tmp', JSON.stringify(snapshot));
    renameSync(this.path + '.tmp', this.path);
  }
}
// Process-wide, store-scoped serialization. Deliberately NOT a distributed lock.
const tails = new Map<string, Promise<void>>();
async function exclusive<A>(path: string, fn: () => Promise<A>): Promise<A> {
  const previous = tails.get(path) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(r => { release = r; });
  tails.set(path, current);
  await previous;
  try { return await fn(); } finally { release(); if (tails.get(path) === current) tails.delete(path); }
}
export class RuntimeV2 {
  afterExternal?: (kind: string) => void;
  beforeCommit?: (kind: string) => void;
  constructor(readonly store: FileStore, readonly mailer: Mailer) {}
  async start(initial: Raw): Promise<void> {
    await exclusive(this.store.path, async () => {
      const snapshot = this.store.read(), existing = snapshot.records[initial.id];
      if (existing) {
        if (JSON.stringify(existing.initial) !== JSON.stringify(initial)) throw new Error('IdempotencyPayloadMismatch');
        return;
      }
      snapshot.records[initial.id] = { revision: 0, initial, state: initial };
      this.store.write(snapshot);
    });
  }
  async tick(id: string, expectedRevision?: number, supplied?: Node): Promise<State> {
    return exclusive(this.store.path, async () => {
      const snapshot = this.store.read(), record = snapshot.records[id];
      if (!record) throw new Error('NotFound');
      if (expectedRevision !== undefined && expectedRevision !== record.revision) throw new Error('StaleRevision');
      const declared = ReservationProcess({ state: record.state }), node = supplied ?? declared;
      if (JSON.stringify(node) !== JSON.stringify(declared)) throw new Error('DeclarationMismatch');
      if (node.kind === 'done') return record.state;
      const key = `${id}:${record.revision}:${node.kind}`, fingerprint = JSON.stringify(node);
      const prior = snapshot.journal[key];
      if (prior) throw new Error('InvariantViolation:journal-without-state-advance');
      let event: Event;
      switch (node.kind) {
        case 'advance': event = { type: 'advance' }; break;
        case 'availability': event = { type: 'availability', version: snapshot.version, remaining: snapshot.remaining }; break;
        case 'save': {
          const candidate = node.input, existing = snapshot.reservations[id];
          if (existing) event = { type: 'saved', value: existing };
          else if (candidate.version !== snapshot.version || candidate.seats > snapshot.remaining) event = { type: 'conflict' };
          else {
            const saved: Saved = { kind: 'saved', id, seats: candidate.seats, receipt: `receipt:${id}` };
            snapshot.version++; snapshot.remaining -= candidate.seats;
            snapshot.reservations[id] = saved;
            snapshot.outbox[id] = { sent: false };
            event = { type: 'saved', value: saved };
          }
          break;
        }
        case 'notify': {
          // Stable across retry; provider must implement idempotency for this key.
          await this.mailer.send(`confirmation:${id}`);
          this.afterExternal?.(node.kind);
          snapshot.outbox[id] = { sent: true };
          event = { type: 'notified' }; break;
        }
      }
      const next = decide(record.state, event);
      snapshot.journal[key] = { fingerprint, event };
      snapshot.records[id] = { ...record, revision: record.revision + 1, state: next };
      this.beforeCommit?.(node.kind);
      // Saved reservation, event, state, execution record and outbox share this commit.
      this.store.write(snapshot);
      return next;
    });
  }
  async run(id: string): Promise<State> {
    for (let i = 0; i < 16; i++) {
      const state = await this.tick(id);
      if (['notified', 'rejected', 'conflict'].includes(state.kind)) return state;
    }
    throw new Error('TransitionLimit');
  }
}
