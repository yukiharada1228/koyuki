import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function run(command, args, cwd = root, fail = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  assert(!result.error && result.status !== null && (fail ? result.status !== 0 : result.status === 0), output || String(result.error));
  return output;
}
const temp = mkdtempSync(join(tmpdir(), 'koyuki-booking-composition-'));
try {
  const consumer = join(temp, 'consumer');
  run(process.execPath, ['scripts/authoring-quickstart.mjs', '--prepare', consumer]);
  const comparison = join(consumer, 'comparison'); mkdirSync(comparison);
  for (const name of ['domain.ts', 'definitions.ts', 'component.tsx', 'functions.ts', 'verify.ts']) copyFileSync(join(root, 'examples/booking-composition', name), join(comparison, name));
  const config = JSON.parse(readFileSync(join(consumer, 'tsconfig.json'), 'utf8')); config.include.push('comparison/*.ts', 'comparison/*.tsx'); writeFileSync(join(consumer, 'tsconfig.json'), JSON.stringify(config));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  for (const version of ['7.0.2', '6.0.3']) {
    if (version !== '7.0.2') run('npm', ['install', '--save-dev', `typescript@${version}`, '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
    run('npm', ['run', 'check'], consumer);
    const emit = { ...config, compilerOptions: { ...config.compilerOptions, noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: './declarations' } };
    writeFileSync(join(consumer, 'emit.json'), JSON.stringify(emit));
    run('npm', ['exec', '--', 'tsc', '-p', 'emit.json'], consumer);
    console.log(`TypeScript ${version}: component/service inputs, exact errors and exported declarations passed.`);
  }
  console.log(run('npm', ['exec', '--', 'tsx', 'comparison/verify.ts'], consumer).trim());
  const component = join(comparison, 'component.tsx'), source = readFileSync(component, 'utf8');
  writeFileSync(component, source.replace('definitions(props, actor)', 'definitions({ ...props, cancellationHours: 24 }, actor)'));
  run('npm', ['run', 'check'], consumer);
  assert(run('npm', ['exec', '--', 'tsx', 'comparison/verify.ts'], consumer, true).includes('48hPolicyAndActorSnapshot'));
  writeFileSync(component, source);
  console.log('Type-correct hardcoded-policy mutation was rejected by the 48h business case.');
} finally { rmSync(temp, { recursive: true, force: true }); }
