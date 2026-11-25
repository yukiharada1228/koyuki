// Isolated, fully emitted host + actual packed framework. Never publish or edit the caller's tree.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error ?? Error(result.stderr + result.stdout);
  return result.stdout;
}
const hash = value => createHash('sha256').update(value).digest('hex');
async function main() {
  const args = process.argv.slice(2), forwarded = []; let revision = 'HEAD', patch;
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index + 1]) throw Error('Every option needs a value');
    if (args[index] === '--revision') revision = args[index + 1];
    else if (args[index] === '--patch') patch = resolve(args[index + 1]);
    else if (['--backend', '--rounds', '--iterations', '--warmup'].includes(args[index])) forwarded.push(args[index], args[index + 1]);
    else throw Error('Unknown built benchmark option');
  }
  const commit = run('git', ['rev-parse', '--verify', `${revision}^{commit}`], root).trim();
  const directory = mkdtempSync(join(tmpdir(), 'koyuki-built-benchmark-')), checkout = join(directory, 'source');
  let attached = false;
  try {
    run('git', ['worktree', 'add', '--quiet', '--detach', checkout, commit], root); attached = true;
    if (patch) run('git', ['apply', patch], checkout);
    const modules = join(checkout, 'node_modules'); symlinkSync(join(root, 'node_modules'), modules, 'dir');
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], checkout);
    const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], checkout))[0];
    const tarball = readFileSync(join(directory, packed.filename));
    // Replace only our temporary symlink. Do not install into the caller's node_modules.
    unlinkSync(modules); mkdirSync(modules);
    for (const name of ['tsx', 'esbuild', 'typescript', '@types']) symlinkSync(join(root, 'node_modules', name), join(modules, name), 'dir');
    const installed = join(modules, 'koyuki'); mkdirSync(installed);
    run('tar', ['-xzf', join(directory, packed.filename), '--strip-components=1', '-C', installed], checkout);
    const manifest = JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8'));
    manifest.name = 'koyuki-benchmark-host'; // Avoid Node's package self-reference.
    writeFileSync(join(checkout, 'package.json'), JSON.stringify(manifest));
    const sources = join(checkout, 'src/experiments/procurement');
    for (const name of readdirSync(sources).filter(name => name.endsWith('.ts'))) {
      const path = join(sources, name);
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll("'../../framework/index.js'", "'koyuki'").replaceAll("'../../framework/result.js'", "'koyuki'"));
    }
    run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--ignoreConfig', '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--strict', '--skipLibCheck', '--types', 'node', '--rootDir', 'src', '--outDir', 'built', 'src/experiments/procurement/benchmark.ts'], checkout);
    const result = JSON.parse(run(process.execPath, [join(checkout, 'built/experiments/procurement/benchmark.js'), ...forwarded], checkout));
    const modulesHash = Object.fromEntries(readdirSync(join(installed, 'dist')).filter(name => name.endsWith('.js')).sort().map(name => [name, hash(readFileSync(join(installed, 'dist', name)))]));
    result.runtime = { host: 'TypeScript-emitted-ES2022-NodeNext', framework: 'installed-development-tarball', baseCommit: commit,
      patchSha256: patch ? hash(readFileSync(patch)) : null, tarballSha256: hash(tarball), emittedFrameworkModules: modulesHash,
      collectorSha256: hash(readFileSync(fileURLToPath(import.meta.url))) };
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (attached) run('git', ['worktree', 'remove', '--force', checkout], root);
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
