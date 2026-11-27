import type { StageObserver, StageStatus } from './workflow.js';
import type { Result } from './result.js';
export interface OperationReport<O, E> {
  readonly result: Result<O, E>;
  readonly trace: readonly unknown[];
  readonly attempt?: { readonly trace: readonly unknown[] | null } | null;
}
type ValidDetails<C> = C extends { run(input: infer I): Promise<Result<infer O, infer E>> }
  ? C extends { runDetailed?: infer D } ? [Exclude<D, undefined>] extends [(input: I) => Promise<OperationReport<O, E>>] ? true : false : true
  : false;
export type CheckedDetails<T> = { readonly [K in keyof T]: [ValidDetails<T[K]>] extends [true] ? unknown : never };
/** Carry the detail/run compatibility check through generic command-table wrappers. */
export type OperationCommands<T> = T & NoInfer<CheckedDetails<T>>;
interface ExecutionMetadata {
  readonly executionId: string;
  readonly operation: string;
  /** Since the dispatch was queued, including queue time; not individual step duration. */
  readonly elapsedMs: number;
}
type ExecutionDetail = (
  | { readonly kind: 'queued' | 'started' }
  | { readonly kind: 'step'; readonly step: string; readonly status: 'ok' | 'error' | 'skipped'; readonly scope: 'operation' | 'replay'; readonly timing: 'reported-after-run' }
  | { readonly kind: 'span-started'; readonly spanId: string; readonly parentSpanId: string | null; readonly step: string }
  | { readonly kind: 'span-completed'; readonly spanId: string; readonly parentSpanId: string | null; readonly step: string; readonly status: StageStatus; readonly durationMs: number }
  | { readonly kind: 'completed'; readonly status: 'ok' | 'error' | 'defect' | 'rejected' | 'denied'; readonly revision?: number }
);
export type ExecutionEvent = ExecutionMetadata & ExecutionDetail;
export type ExecutionObserver = (event: ExecutionEvent) => void;
export interface ExecutionOptions {
  /** Host prefix when correlating across module copies, workers or restarts. */
  readonly sessionId?: string;
  readonly observeExecution?: ExecutionObserver;
  readonly clock?: () => number;
}
let sessions = 0;
export function executionSession(options: ExecutionOptions = {}) {
  const sessionId = options.sessionId ?? `application-${++sessions}`;
  const clock = options.clock ?? (() => globalThis.performance?.now() ?? Date.now());
  const listeners = new Set<ExecutionObserver>();
  const initialObserver = options.observeExecution;
  if (initialObserver) listeners.add(initialObserver);
  let sequence = 0;
  const subscribe = (listener: ExecutionObserver) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
  const create = (operation: string) => {
    if (listeners.size === 0) return undefined;
    const executionId = `${sessionId}/${++sequence}`;
    let last = 0;
    const read = () => { try { const value = clock(); if (Number.isFinite(value)) last = Math.max(last, value); } catch { /* diagnostics only */ } return last; };
    const origin = read();
    const emit = (detail: ExecutionDetail) => {
      const event = Object.freeze({ ...detail, executionId, operation, elapsedMs: Math.max(0, read() - origin) }) as ExecutionEvent;
      for (const listener of [...listeners]) {
        if (!listeners.has(listener)) continue;
        try { void Promise.resolve(listener(event)).catch(() => {}); } catch { /* diagnostics only */ }
      }
    };
    let spanSequence = 0;
    const active: string[] = [];
    const begin = (step: string) => {
      const spanId = `${executionId}/span-${++spanSequence}`, parentSpanId = active.at(-1) ?? null, started = read();
      let closed = false;
      active.push(spanId);
      emit({ kind: 'span-started', spanId, parentSpanId, step });
      return (status: StageStatus) => {
        if (closed) return;
        closed = true;
        const index = active.indexOf(spanId); if (index >= 0) active.splice(index, 1);
        emit({ kind: 'span-completed', spanId, parentSpanId, step, status, durationMs: Math.max(0, read() - started) });
      };
    };
    const observe: StageObserver = Object.assign((step: string, _input: unknown) => {
      const finish = begin(step);
      return Object.assign((result: Result<unknown, unknown>) => finish(result.ok ? 'ok' : 'error'), { defect: () => finish('defect') });
    }, { live: true as const, scope: begin });
    const steps = (report: OperationReport<unknown, unknown>) => {
      // Detail reports are optional host capabilities. A broken diagnostic must
      // not replace a result, and only stage names/statuses leave this boundary.
      try {
        const rows = (trace: readonly unknown[] | null | undefined, scope: 'operation' | 'replay') => {
          if (!Array.isArray(trace)) return;
          for (const item of trace) {
            if (!item || typeof item !== 'object') continue;
            if ('step' in item && typeof item.step === 'string' && 'status' in item && (item.status === 'ok' || item.status === 'error')) {
              emit({ kind: 'step', step: item.step, status: item.status, scope, timing: 'reported-after-run' });
            } else if (scope === 'replay' && 'kind' in item && typeof item.kind === 'string') {
              if (!['snapshot', 'lookup', 'command', 'resolution'].includes(item.kind)) continue;
              if (item.kind === 'command') rows(report.attempt?.trace, 'operation');
              const status = 'status' in item && item.status === 'error' ? 'error' : 'status' in item && item.status === 'skip' ? 'skipped' : 'ok';
              emit({ kind: 'step', step: `replay.${item.kind}`, status, scope: 'replay', timing: 'reported-after-run' });
            }
          }
        };
        rows(report.trace, 'attempt' in report ? 'replay' : 'operation');
      } catch { /* malformed metadata cannot change business success */ }
    };
    return { emit, steps, observe };
  };
  return { subscribe, create };
}
export type ExecutionContext = NonNullable<ReturnType<ReturnType<typeof executionSession>['create']>>;
