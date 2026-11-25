import { cp, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const original = await readFile(join(root, 'src/framework/business.ts'), 'utf8');
const start = original.indexOf('export function business<L extends Load, O, S, SE, RE,');
const closing = '}): Commands<L, T, S, SE, RE, D>;';
const end = original.indexOf(closing, start) + closing.length;
if (start < 0 || end < closing.length) throw Error('Review changed business declarations');
const noLookupInference = source => source
  .replaceAll('Receipt<ReplayValue<S>>', 'Receipt<ReplayValue<NoInfer<S>>>')
  .replaceAll('Receipt<ReplayValue<Value<SaveResult<A>>>>', 'Receipt<ReplayValue<NoInfer<Value<SaveResult<A>>>>>');
function mandatoryReplay(noInferLookup = false) {
  let signature = original.slice(start, end)
    .replace('O, S, SE, RE,', 'O, S extends Execution<unknown>, SE, RE,')
    .replace('  replay?: {', '  replay: {')
    .replace('  } & ReplaySaveCheck<NoInfer<S>>;', '  };')
    .replace('Commands<L, T, S, SE, RE, D>', 'Commands<L, T, S, SE, RE, D & { replay: object }>');
  if (noInferLookup) signature = noLookupInference(signature);
  return original.slice(0, start) + signature + '\n' + original.slice(start);
}
const candidates = [
  ['current', original],
  ['lookup-no-infer', noLookupInference(original)],
  ['outer-check-no-infer', original.replaceAll('ReplaySaveCheck<NoInfer<S>>', 'NoInfer<ReplaySaveCheck<S>>').replaceAll('ReplaySaveCheck<Value<SaveResult<A>>>', 'NoInfer<ReplaySaveCheck<Value<SaveResult<A>>>>')],
  ['mandatory-replay-overload', mandatoryReplay()],
  ['mandatory-replay-lookup-no-infer', mandatoryReplay(true)],
];
function probe(key) {
  const literal = JSON.stringify(key), name = JSON.stringify(String(key));
  return `import { business, ok, type Result, type Execution, type ReplayInputError } from './framework/index.js';
type Input = { id: string; value: number };
type Equal<A,B> = (<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
const commands = business({ name:'context', load:async (input:Input)=>ok(input.value), operations:{[${literal}]:[(n:number)=>ok(n+1)]},
  save:async (value:number, execution)=>{
    const name: Equal<typeof execution.name,${name}>=true;
    const request: Equal<typeof execution.request,Input>=true; void name; void request;
    return ok({kind:'committed' as const,value});
  },
  replay:{lookup: execution=>{
    const name: Equal<typeof execution.name,${name}>=true;
    const request: Equal<typeof execution.request,Input>=true; void name; void request;
    return ok({kind:'missing' as const});
  },resolveAfter:[]},
});
const exact: Equal<Awaited<ReturnType<typeof commands[${literal}]>>,Result<Execution<number>,ReplayInputError>>=true;
void exact;
`;
}
const temporary = await mkdtemp(join(tmpdir(), 'koyuki-replay-context-'));
try {
  await cp(join(root, 'src'), join(temporary, 'src'), { recursive: true });
  await cp(join(root, 'tsconfig.json'), join(temporary, 'tsconfig.json'));
  await writeFile(join(temporary, 'package.json'), '{"type":"module"}');
  await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'), 'dir');
  const normalize = text => text.replaceAll(relative(root, temporary), '<temporary>').replaceAll(temporary, '<temporary>');
  const compile = () => {
    const result = spawnSync(join(root, 'node_modules/.bin/tsc'), ['-p', join(temporary, 'tsconfig.json'), '--pretty', 'false'], { cwd: root, encoding: 'utf8' });
    if (result.error || result.signal || ![0, 1, 2].includes(result.status)) throw result.error ?? Error(result.stderr || 'Compiler terminated');
    return { status: result.status, output: normalize(result.stdout + result.stderr) };
  };
  const baseline = compile(); if (baseline.status !== 0) throw Error(baseline.output);
  await writeFile(join(temporary, 'src/replay-context-string.ts'), probe('go'));
  await writeFile(join(temporary, 'src/replay-context-number.ts'), probe(0));
  await writeFile(join(temporary, 'src/replay-context-safety.ts'), `import { business, ok } from './framework/index.js';
const identity = async <T>(value:T) => ok(value);
// A generic identity save returns the numeric decision, not an Execution envelope.
// @ts-expect-error replay must reject this save even when a constrained overload can specialize T
business({name:'unsafe',load:async(input:number)=>ok(input),operations:{go:[(n:number)=>ok(n)]},save:identity,replay:{lookup:()=>ok({kind:'missing' as const}),resolveAfter:[]}});
`);
  const results = [];
  for (const [name, source] of candidates) {
    if (name !== 'current' && source === original) throw Error(`Patch did not apply: ${name}`);
    await writeFile(join(temporary, 'src/framework/business.ts'), source);
    const result = compile();
    const diagnostics = result.output.split('\n').filter(line => /error TS\d+:/.test(line));
    if (result.status !== 0 && diagnostics.length === 0) throw Error(result.output);
    const probeDiagnostics = diagnostics.filter(line => /replay-context-(string|number)\.ts\(/.test(line));
    const contractDiagnostics = diagnostics.filter(line => !/replay-context-(string|number)\.ts\(/.test(line));
    results.push({ name, accepted: result.status === 0, probeDiagnostics, contractDiagnostics });
  }
  const compiler = spawnSync(join(root, 'node_modules/.bin/tsc'), ['--version'], { encoding: 'utf8' });
  if (compiler.status !== 0) throw Error('Compiler version unavailable');
  console.log(JSON.stringify({ compiler: compiler.stdout.trim(), businessSourceSha256: createHash('sha256').update(original).digest('hex'), results }, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
