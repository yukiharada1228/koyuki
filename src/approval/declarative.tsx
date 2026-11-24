/** @jsx ha */
import type { ApprovedOrder, SavedOrder, State, Stage } from './domain.js';
export type EffectNode = { kind: 'effect'; operation: 'notify' | 'ship'; input: SavedOrder };
export type Plan = EffectNode
  | { kind: 'advance' }
  | { kind: 'wait'; stage: Stage; requestId: string }
  | { kind: 'commit'; input: ApprovedOrder }
  | { kind: 'parallel'; children: readonly EffectNode[] }
  | { kind: 'done' };
export function ha<P>(component: (props: P) => Plan, props: P, ...children: Plan[]): Plan {
  return component({ ...props, ...(children.length ? { children } : {}) });
}
export namespace ha {
  export namespace JSX {
    export type Element = Plan;
    export interface ElementChildrenAttribute { children: unknown }
  }
}
const Advance = (): Plan => ({ kind: 'advance' });
export const Commit = ({ input }: { input: ApprovedOrder }): Plan => ({ kind: 'commit', input: structuredClone(input) });
export const Notify = ({ input }: { input: SavedOrder }): EffectNode => ({ kind: 'effect', operation: 'notify', input: structuredClone(input) });
export const Ship = ({ input }: { input: SavedOrder }): EffectNode => ({ kind: 'effect', operation: 'ship', input: structuredClone(input) });
const WaitForApproval = (props: { stage: Stage; requestId: string }): Plan => ({ kind: 'wait', ...props });
const Done = (): Plan => ({ kind: 'done' });
// JSX siblings cannot preserve EffectNode types, so enforce this invariant at the boundary.
export function Parallel({ children }: { children: readonly Plan[] }): Plan {
  if (!children.every((node): node is EffectNode => node.kind === 'effect')) throw new Error('ParallelRequiresEffects');
  const names = children.map(node => node.operation);
  if (new Set(names).size !== names.length) throw new Error('DuplicateChildIdentity');
  return { kind: 'parallel', children };
}
export function FulfillOrder({ order }: { order: SavedOrder }): Plan {
  return <Parallel>
    <Notify input={order} />
    <Ship input={order} />
  </Parallel>;
}
export function OrderProcess({ state }: { state: State }): Plan {
  switch (state.kind) {
    case 'draft': return <Advance />;
    case 'waiting': return <WaitForApproval stage={state.stage} requestId={state.requestId} />;
    case 'ready': return <Commit input={state.order} />;
    case 'committed': return <FulfillOrder order={state.order} />;
    case 'complete': case 'rejected': return <Done />;
  }
}
