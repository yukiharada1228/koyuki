import type { Result } from '../../framework/index.js';
/** Baseline-owned labels; no reflection of Koyuki declarations or execution. */
export function baselineStepName(operation: string, stage: BaselineStage['stage']): string {
  if (stage === 'load') return `${operation}:load`;
  if (stage === 'save') return operation;
  const labels = operation === 'procurement.request.v1.create' ? ['authorize-creation', 'parse-lines', 'create-request-plan']
    : operation === 'procurement.receipt.v1.correct' ? ['run:1', 'revalidate-correction', 'correct-receipt-plan', 'run:3']
    : ['run:1', 'run:2', 'run:3', 'run:4'];
  const index = stage === 'rule' ? 0 : Number(stage.slice(5)) - 1;
  return labels[index] ?? `run:${index + 1}`;
}
export type BaselineStage = Readonly<{ stage: 'load' | 'rule' | 'rule:2' | 'rule:3' | 'rule:4' | 'save'; status: 'ok' | 'error' }>;
export type StageSink = (event: BaselineStage) => void;
export type StageCapture = (stage: BaselineStage['stage'], input: unknown) => (result: Result<unknown, unknown>) => void;
