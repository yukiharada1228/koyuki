export type Result<A, E> = { ok: true; value: A } | { ok: false; error: E };
export const ok = <A>(value: A): Result<A, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
export type Step<I, O, E> = (input: I) => Result<O, E>;
export function compose<I, M, O, E1, E2>(a: Step<I, M, E1>, b: Step<M, O, E2>): Step<I, O, E1 | E2> {
  return input => { const result = a(input); return result.ok ? b(result.value) : result; };
}

// Deliberately small interpreter: no durable execution, distributed locks or compensation.
export type Plan =
  | { kind: 'operation'; id: string; payload: unknown; run: () => Promise<void> }
  | { kind: 'sequence'; children: readonly Plan[] }
  | { kind: 'parallel'; children: readonly Plan[] };
export const Operation = (props: Omit<Extract<Plan, { kind: 'operation' }>, 'kind'>): Plan => ({ kind: 'operation', ...props });
export const Sequence = (props: { children: Plan[] }): Plan => ({ kind: 'sequence', children: props.children });
export const Parallel = (props: { children: Plan[] }): Plan => ({ kind: 'parallel', children: props.children });
export function h<P>(component: (props: P) => Plan, props: P, ...children: Plan[]): Plan {
  return component({ ...props, ...(children.length ? { children } : {}) });
}
declare global {
  namespace JSX {
    type Element = Plan;
    interface ElementChildrenAttribute { children: unknown }
  }
}
export class Runtime {
  readonly completed = new Set<string>();
  readonly trace: string[] = [];
  afterEffect?: (id: string) => void;
  async execute(plan: Plan): Promise<void> {
    if (plan.kind === 'sequence') {
      for (const child of plan.children) await this.execute(child);
    } else if (plan.kind === 'parallel') {
      await Promise.all(plan.children.map(child => this.execute(child)));
    } else {
      if (this.completed.has(plan.id)) { this.trace.push(`skip:${plan.id}`); return; }
      this.trace.push(`start:${plan.id}`);
      await plan.run();
      this.afterEffect?.(plan.id); // Reproduces crash after remote success, before journal write.
      this.completed.add(plan.id);
      this.trace.push(`done:${plan.id}`);
    }
  }
}
