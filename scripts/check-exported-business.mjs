// Verify user-authored exported applications against the actual installed SDK.
import { readFileSync, writeFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
export function verifyExportedBusiness(consumer, root, run) {
  const source = join(consumer, 'verified-exports.ts');
  const emitted = join(consumer, 'verified-declarations');
  const client = join(consumer, 'verified-exports-consumer.ts');
  const sourceConfig = join(consumer, 'verified-source.json');
  const emitConfig = join(consumer, 'verified-emit.json');
  const clientConfig = join(consumer, 'verified-consumer.json');
  const declarations = join(consumer, 'node_modules/koyuki/dist/business.d.ts');
  const original = readFileSync(declarations, 'utf8');
  const created = [source, emitted, client, sourceConfig, emitConfig, clientConfig];
  for (const path of created) assert(!existsSync(path), 'Refusing to overwrite an existing export fixture');
  const options = { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
    noUncheckedIndexedAccess: true, types: [], lib: ['ES2022', 'DOM'] };
  const check = config => run('npm', ['exec', '--', 'tsc', '-p', config, '--pretty', 'false'], consumer);
  try {
    copyFileSync(join(root, 'scripts/fixtures/business-verified-exports.ts'), source);
    writeFileSync(sourceConfig, JSON.stringify({ compilerOptions: { ...options, noEmit: true }, files: ['verified-exports.ts'] }));
    writeFileSync(emitConfig, JSON.stringify({ compilerOptions: { ...options, declaration: true, emitDeclarationOnly: true,
      outDir: 'verified-declarations' }, files: ['verified-exports.ts'] }));
    check(sourceConfig); check(emitConfig);
    const generated = readFileSync(join(emitted, 'verified-exports.d.ts'), 'utf8');
    assert(!generated.includes('preservedContextWitness') && !generated.includes('node_modules'), 'A private SDK reference leaked into emitted declarations');
    writeFileSync(client, `import { plain, replayed, optional, createPlain, createForActor, scoped, createScoped, type ScopedSubmit, type Submit, type LoadFailure } from './verified-declarations/verified-exports.js';
import type { Result, Execution, ReplayInputError } from 'koyuki';
type Equal<A,B>=(<T>()=>T extends A?1:2) extends (<T>()=>T extends B?1:2)?true:false;
type Assert<T extends true>=T;
type Failure=LoadFailure|'Denied'|'Refused'|'SaveFailed';
type Input=Assert<Equal<Parameters<typeof plain.approve>[0],Submit>>;
type Normal=Assert<Equal<Awaited<ReturnType<typeof plain.approve>>,Result<string,Failure>>>;
type Replayed=Assert<Equal<Awaited<ReturnType<typeof replayed.approve>>,Result<Execution<string>,Failure|'LookupFailed'|ReplayInputError>>>;
// Declaration emission repeats structurally equal anonymous inputs across modes.
// Check each union member strictly, rather than comparing the duplicate union itself.
type EachInput<T>=T extends unknown?Equal<T,Submit>:never;
type OptionalInput=Assert<Equal<EachInput<Parameters<typeof optional.approve>[0]>,true>>;
type Error<R>=R extends {ok:false;error:infer E}?E:never;
type OptionalErrors=Assert<Equal<Error<Awaited<ReturnType<typeof optional.approve>>>,Failure|'LookupFailed'|ReplayInputError>>;
const another=createPlain({kind:'OtherLoadFailure'} as const);
type Generic=Assert<Equal<Awaited<ReturnType<typeof another.approve>>,Result<string,Readonly<{kind:'OtherLoadFailure'}>|'Denied'|'Refused'|'SaveFailed'>>>;
type ScopedInput=Assert<Equal<Parameters<typeof scoped.approve>[0],ScopedSubmit>>;
const scopedOther=createScoped({kind:'OtherLoadFailure'} as const);
type ScopedGeneric=Assert<Equal<Awaited<ReturnType<typeof scopedOther.approve>>,Result<string,Readonly<{kind:'OtherLoadFailure'}>|'Denied'|'Refused'|'SaveFailed'>>>;

const actor={id:'boss',active:true,department:'finance'} as const;
const forActor=createForActor(actor);
type ActorInput=Assert<Equal<Parameters<typeof forActor.approve>[0],Submit>>;
type ActorResult=Assert<Equal<Awaited<ReturnType<typeof forActor.approve>>,Result<Readonly<{id:string;actor:typeof actor}>,LoadFailure|'Denied'|'Refused'|'SaveFailed'>>>;
if(false){
 // @ts-expect-error The generated API still requires the operation-specific field.
 void plain.approve({id:'one'});
 void optional.approve({id:'one',approver:'boss'});
 // @ts-expect-error Every optional-mode branch still requires the operation field.
 void optional.approve({id:'one'});
 // @ts-expect-error Actor-generic factories must still require the request-specific field.
 void forActor.approve({id:'one'});
 // @ts-expect-error Emitted declarations retain the loader's required scope.
 void scoped.approve({id:'one',approver:'boss'});
 // @ts-expect-error The emitted loader scope is still literal, not any string.
 void scoped.approve({id:'one',approver:'boss',tenant:'two'});
 void scoped.approve({id:'one',approver:'boss',tenant:'one'});

}
`);
    writeFileSync(clientConfig, JSON.stringify({ compilerOptions: { ...options, noEmit: true }, files: ['verified-exports-consumer.ts'] }));
    const files = run('npm', ['exec', '--', 'tsc', '-p', clientConfig, '--pretty', 'false', '--listFiles'], consumer).replaceAll('\\', '/').split(/\r?\n/);
    assert(files.some(file => file.endsWith('/verified-declarations/verified-exports.d.ts')));
    assert(!files.some(file => file.endsWith('/verified-exports.ts')), 'The second consumer must read emitted declarations, not the original source');
    assert(!files.some(file => file.includes('/@types/node/')), 'The declaration consumer must not load Node types');
    const portable = /R & \{\s*readonly run: R;\s*\} & \{/g;
    assert.equal([...original.matchAll(portable)].length, 1, 'Callable declaration changed; re-evaluate its portability control');
    writeFileSync(declarations, original.replace(portable, "R & Omit<C, 'runDetailed'> & {"));
    // Prove that this mutation preserves ordinary typing but breaks publishing.
    check(sourceConfig);
    const rejected = spawnSync('npm', ['exec', '--', 'tsc', '-p', emitConfig, '--pretty', 'false'], { cwd: consumer, encoding: 'utf8' });
    const output = `${rejected.stdout ?? ''}${rejected.stderr ?? ''}`;
    assert(!rejected.error && rejected.status !== null && rejected.status !== 0);
    assert(output.includes('verified-exports.ts(') && /TS(?:2742|2883|4023|4058):/.test(output) && /PlainCommand|ReplayCommand/.test(output), output);
    console.log('Verified exported constants, generic-error/actor factories and plain/replay/optional APIs: emitted declarations compile in a separate consumer without Node types; the private-Omit representation passes normal checking but fails declaration emission.');
  } finally {
    writeFileSync(declarations, original);
    for (const path of created) rmSync(path, { recursive: true, force: true });
  }
}
