// Development benchmark. No host utilities or dependencies enter the portable package.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { procurement } from './application.js';
import { plainProcurement } from './plain.js';
import { helperProcurement } from './helper.js';
import { MemoryProcurement } from './repository.js';
import { SqliteProcurement } from './sqlite.js';
import { story } from './comparison-scenario.js';
import type { StudyFactory } from './comparison-contract.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const factories = { plain: plainProcurement, helper: helperProcurement, koyuki: procurement } satisfies Record<string, StudyFactory>;
type Style = keyof typeof factories;
type Backend = 'memory' | 'sqlite';
const styles = Object.keys(factories) as Style[];
function options(args: string[]) {
  const result = { rounds: 15, iterations: 10, warmup: 3, backend: 'memory' };
  const supplied = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!, value = args[i + 1];
    if (value === undefined || supplied.has(flag)) throw new Error('Each option needs one value and must appear once');
    supplied.add(flag);
    if (flag === '--backend' && ['memory', 'sqlite', 'both'].includes(value)) result.backend = value;
    else if (flag === '--rounds' || flag === '--iterations' || flag === '--warmup') {
      const number = Number(value);
      if (!Number.isSafeInteger(number) || number < (flag === '--warmup' ? 0 : 1)) throw new Error('Invalid benchmark count');
      result[flag.slice(2) as 'rounds' | 'iterations' | 'warmup'] = number;
    } else throw new Error('Usage: --backend memory|sqlite|both --rounds N --iterations N --warmup N');
  }
  return result;
}
function distribution(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (p: number) => { const index = (sorted.length - 1) * p, lower = Math.floor(index); return sorted[lower]! + (sorted[Math.ceil(index)]! - sorted[lower]!) * (index - lower); };
  return { median: quantile(0.5), q1: quantile(0.25), q3: quantile(0.75), p90: quantile(0.9), min: sorted[0]!, max: sorted.at(-1)! };
}
function provenance() {
  const paths = ['package.json', 'package-lock.json', ...['src/framework', 'src/experiments/procurement'].flatMap(directory => readdirSync(join(root, directory)).filter(name => name.endsWith('.ts')).map(name => `${directory}/${name}`))].sort();
  const hashes = Object.fromEntries(paths.map(path => [path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex')]));
  const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain', '--', ...paths], { cwd: root, encoding: 'utf8' });
  if (git.status !== 0 || status.status !== 0) throw new Error('Cannot record benchmark source identity');
  const version = (name: string) => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version as string;
  return { gitCommit: git.stdout.trim(), sourceDirty: status.stdout.trim().length > 0, hashes, tools: { tsx: version('tsx'), esbuild: version('esbuild'), typescript: version('typescript') } };
}
async function main() {
  const configuration = options(process.argv.slice(2));
  const source = provenance();
  const expected = await story(plainProcurement, new MemoryProcurement());
  const results = [];
  const backends: Backend[] = configuration.backend === 'both' ? ['memory', 'sqlite'] : [configuration.backend as Backend];
  for (const backend of backends) {
    const samples: Record<Style, { constructionMs: number[]; executionMs: number[] }> = {
      plain: { constructionMs: [], executionMs: [] }, helper: { constructionMs: [], executionMs: [] }, koyuki: { constructionMs: [], executionMs: [] },
    };
    async function once(style: Style) {
      // Fresh storage is deliberately outside both timed intervals. IDs and
      // versions then describe the identical scenario in every invocation.
      const repository = backend === 'sqlite' ? new SqliteProcurement(':memory:', 'g1') : new MemoryProcurement();
      try {
        const start = performance.now(); let constructed = start, finished = start;
        const actual = await story(factories[style], repository, {
          constructed: () => { constructed = performance.now(); },
          executed: () => { finished = performance.now(); },
        });
        // story's invariant assertions and this full parity assertion run after
        // executed(), so broken output cannot earn a successful timing result.
        assert.deepEqual(actual, expected);
        return { constructionMs: constructed - start, executionMs: finished - constructed };
      } finally { if (repository instanceof SqliteProcurement) repository.close(); }
    }
    for (let round = -configuration.warmup; round < configuration.rounds; round++) {
      const offset = ((round % styles.length) + styles.length) % styles.length;
      for (let position = 0; position < styles.length; position++) {
        const style = styles[(position + offset) % styles.length]!;
        let constructionMs = 0, executionMs = 0;
        for (let iteration = 0; iteration < configuration.iterations; iteration++) {
          const value = await once(style); constructionMs += value.constructionMs; executionMs += value.executionMs;
        }
        if (round >= 0) { samples[style].constructionMs.push(constructionMs / configuration.iterations); samples[style].executionMs.push(executionMs / configuration.iterations); }
      }
    }
    results.push({ backend, scenarioOperations: 32, distinctOperations: 25, identitiesConstructed: 5,
      perStyle: Object.fromEntries(styles.map(style => [style, {
        measuredScenarios: configuration.rounds * configuration.iterations,
        warmupScenarios: configuration.warmup * configuration.iterations,
        constructionRoundMeanMs: distribution(samples[style].constructionMs), executionRoundMeanMs: distribution(samples[style].executionMs), rawRoundMeans: samples[style],
      }])) });
  }
  // Detect source edits during a run rather than silently stamping stale hashes.
  assert.deepEqual(provenance(), source, 'Benchmark source or tools changed during execution');
  console.log(JSON.stringify({ schema: 'koyuki.procurement-runtime.v1', measuredAt: new Date().toISOString(), configuration,
    scope: 'construction-of-five-identity-bound-apps-and-32-successful-operations-plus-final-snapshot',
    exclusions: ['repository-construction', 'schema-creation', 'assertions', 'transport', 'network', 'file-durability', 'replay', 'application-session', 'capture', 'live-observation', 'cold-imports', 'type-checking'],
    environment: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length }, source, results }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
