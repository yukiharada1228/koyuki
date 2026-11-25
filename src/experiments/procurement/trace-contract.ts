import type { Result } from '../../framework/index.js';
export type BaselineStage = Readonly<{ stage: 'load' | 'rule' | 'rule:2' | 'save'; status: 'ok' | 'error' }>;
export type StageSink = (event: BaselineStage) => void;
export type StageCapture = (stage: BaselineStage['stage'], input: unknown) => (result: Result<unknown, unknown>) => void;
