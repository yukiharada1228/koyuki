import type { Trace } from './workflow.js';
type Role = 'rule' | 'validate' | 'require' | 'evolve' | 'effect' | 'save' | 'unknown';
export type Structure =
  | { readonly kind: 'empty' }
  | { readonly kind: 'step'; readonly name: string; readonly role: Role }
  | { readonly kind: 'sequence'; readonly children: readonly Structure[] }
  | { readonly kind: 'branch'; readonly name: string; readonly yes: Structure; readonly no: Structure };
const structures = new WeakMap<object, Structure>();
export const structureStep = (name: string, role: Role = 'rule'): Structure => Object.freeze({ kind: 'step', name, role });
export const structureSequence = (...children: Structure[]): Structure => Object.freeze({ kind: 'sequence', children: Object.freeze(children) });
export const structureBranch = (name: string, yes: Structure, no: Structure): Structure => Object.freeze({ kind: 'branch', name, yes, no });
export const loadStructure = (load: object, name: string): Structure => structureSequence(...(typeof load === 'function' ? [] : [structureOf(load)]), structureStep(name, 'effect'));
export const emptyStructure: Structure = Object.freeze({ kind: 'empty' });
export const structureOf = (target: object): Structure => structures.get(target) ?? structureStep('unknown', 'unknown');
/** Internal metadata registration: never inspects functions or calls host methods. */
export function registerStructure<T extends object>(target: T, structure: Structure): T {
  structures.set(target, structure);
  for (const key of ['run', 'runDetailed']) {
    const field = Object.getOwnPropertyDescriptor(target, key);
    if (field && 'value' in field && typeof field.value === 'function') structures.set(field.value, structure);
  }
  return target;
}
export interface FlowNode {
  readonly id: string;
  readonly kind: 'step' | 'branch' | 'join';
  readonly name: string;
  readonly role: Role | 'branch' | 'join';
  readonly implementation: 'opaque' | 'synthetic';
  /** Names are matched, not a proof of execution identity. */
  readonly match?: 'none' | 'ok' | 'error' | 'ambiguous';
}
export interface FlowEdge { readonly from: string; readonly to: string; readonly choice?: 'yes' | 'no' }
export interface FlowGraph {
  readonly schema: 'koyuki.flow.v1';
  readonly semantics: 'declared-composition';
  readonly nodes: readonly FlowNode[];
  readonly edges: readonly FlowEdge[];
  readonly unmatchedTrace: readonly Trace[];
}
/** Static composition, not a domain state machine. Opaque implementations stay unknown. */
export function describeFlow(target: object, trace?: readonly Trace[]): FlowGraph {
  if (trace !== undefined && !Array.isArray(trace)) throw new TypeError('Invalid flow trace');
  const selected = trace?.map(row => {
    if (!row || typeof row !== 'object') throw new TypeError('Invalid flow trace');
    const step = Object.getOwnPropertyDescriptor(row, 'step'), status = Object.getOwnPropertyDescriptor(row, 'status');
    if (!step || !('value' in step) || typeof step.value !== 'string' || !status || !('value' in status) || (status.value !== 'ok' && status.value !== 'error')) throw new TypeError('Invalid flow trace');
    return { step: step.value as string, status: status.value as Trace['status'] };
  });
  const nodes: FlowNode[] = [], edges: FlowEdge[] = [];
  type End = { id: string; choice?: 'yes' | 'no' };
  const add = (kind: FlowNode['kind'], name: string, role: FlowNode['role']) => {
    const id = `n${nodes.length}`; nodes.push({ id, kind, name, role, implementation: kind === 'join' ? 'synthetic' : 'opaque' }); return id;
  };
  const connect = (ends: readonly End[], to: string) => { for (const end of ends) edges.push({ from: end.id, to, ...(end.choice ? { choice: end.choice } : {}) }); };
  type Task = { kind: 'visit'; structure: Structure }
    | { kind: 'after-yes'; id: string; name: string; no: Structure }
    | { kind: 'after-no'; name: string; yes: readonly End[] };
  const tasks: Task[] = [{ kind: 'visit', structure: structureOf(target) }];
  let ends: readonly End[] = [];
  while (tasks.length) {
    const task = tasks.pop()!;
    if (task.kind === 'after-yes') {
      tasks.push({ kind: 'after-no', name: task.name, yes: ends }, { kind: 'visit', structure: task.no });
      ends = [{ id: task.id, choice: 'no' }]; continue;
    }
    if (task.kind === 'after-no') {
      const join = add('join', `${task.name}:join`, 'join'); connect([...task.yes, ...ends], join); ends = [{ id: join }]; continue;
    }
    const structure = task.structure;
    if (structure.kind === 'empty') continue;
    if (structure.kind === 'sequence') {
      for (let index = structure.children.length - 1; index >= 0; index--) tasks.push({ kind: 'visit', structure: structure.children[index]! });
    } else if (structure.kind === 'step') {
      const id = add('step', structure.name, structure.role); connect(ends, id); ends = [{ id }];
    } else {
      const id = add('branch', structure.name, 'branch'); connect(ends, id);
      tasks.push({ kind: 'after-yes', id, name: structure.name, no: structure.no }, { kind: 'visit', structure: structure.yes });
      ends = [{ id, choice: 'yes' }];
    }
  }
  const occurrences = new Map<string, string[]>();
  const labels = (node: FlowNode) => node.kind === 'join' ? [] : node.kind === 'branch' ? [`${node.name}:yes`, `${node.name}:no`] : [node.name];
  for (const node of nodes) for (const label of labels(node)) occurrences.set(label, [...occurrences.get(label) ?? [], node.id]);
  const marks = new Map<string, FlowNode['match']>(), unmatchedTrace: Trace[] = [];
  if (selected) for (const row of selected) {
    const ids = occurrences.get(row.step);
    if (!ids?.length) { unmatchedTrace.push(Object.freeze({ step: row.step, status: row.status })); continue; }
    for (const id of ids) marks.set(id, ids.length > 1 || marks.get(id) === 'ambiguous' ? 'ambiguous' : marks.get(id) === 'error' || row.status === 'error' ? 'error' : 'ok');
  }
  return Object.freeze({ schema: 'koyuki.flow.v1', semantics: 'declared-composition', nodes: Object.freeze(nodes.map(node => Object.freeze({ ...node, ...(trace ? { match: marks.get(node.id) ?? 'none' } : {}) }))), edges: Object.freeze(edges.map(edge => Object.freeze(edge))), unmatchedTrace: Object.freeze(unmatchedTrace) });
}
/** Emit syntax only; no browser/HTML rendering or host callbacks. IDs are framework-generated. */
export function flowMermaid(target: object, trace?: readonly Trace[]): string {
  const graph = describeFlow(target, trace);
  const label = (text: string) => [...text].map(char => /[\p{L}\p{N} _.\-]/u.test(char) ? char : `#${char.codePointAt(0)};`).join('');
  const lines = ['flowchart TD'];
  for (const node of graph.nodes) {
    const text = label(`${node.role}: ${node.name}`);
    lines.push(node.kind === 'branch' ? `  ${node.id}{"${text}"}` : `  ${node.id}["${text}"]`);
  }
  for (const edge of graph.edges) lines.push(`  ${edge.from} -->${edge.choice ? `|${edge.choice}|` : ''} ${edge.to}`);
  if (trace) {
    lines.push('  classDef matched fill:#dcfce7,stroke:#15803d', '  classDef failed fill:#fee2e2,stroke:#b91c1c', '  classDef ambiguous fill:#fef3c7,stroke:#a16207');
    for (const node of graph.nodes) if (node.match && node.match !== 'none') lines.push(`  class ${node.id} ${node.match === 'ok' ? 'matched' : node.match === 'error' ? 'failed' : 'ambiguous'}`);
  }
  return lines.join('\n');
}
