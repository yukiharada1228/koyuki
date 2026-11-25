export type BaselineStage = Readonly<{ stage: 'load' | 'rule' | 'save'; status: 'ok' | 'error' }>;
export type StageSink = (event: BaselineStage) => void;
