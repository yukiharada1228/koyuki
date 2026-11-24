// Public entry: consumers need no experiment-specific modules or constructors.
export { ok, err } from './result.js';
export type { Result } from './result.js';
export { workflow, bindMutation, describeView } from './workflow.js';
export type { Rule, Trace, Workflow } from './workflow.js';
export { defineAction } from './action.js';
export type { ActionReport } from './action.js';
export { collect } from './validation.js';
export { process } from './process.js';
export { defineCommand } from './command.js';
export { defineTarget, transition, step } from './model.js';
export { defineProgram, effect, next } from './program.js';
export type { Command, Update, ProgramSnapshot, ProgramTrace } from './program.js';
export { defineApplication, operation } from './application.js';
export type { ApplicationState, ApplicationEvent } from './application.js';
