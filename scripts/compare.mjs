import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
// Fixture-specific ranges, not a general TypeScript parser. Fail if boundaries drift.
function measure(file, names) {
  const lines = readFileSync(file, 'utf8').split('\n');
  return names.map(name => {
    const pattern = new RegExp(`^([ \\t]*)(?:export )?(?:(?:async )?function ${name}\\b|const ${name}\\b)`);
    const matches = lines.flatMap((line, i) => pattern.test(line) ? [i] : []);
    if (matches.length !== 1) throw new Error(`Expected one declaration: ${file}:${name}`);
    const first = matches[0], indent = pattern.exec(lines[first])[1];
    const arrow = lines[first].includes(`const ${name}`);
    const last = arrow
      ? lines.findIndex((line, i) => i >= first && line.trimEnd().endsWith(';'))
      : lines.findIndex((line, i) => i > first && line === `${indent}}`);
    if (last < first) throw new Error(`Missing fixture boundary: ${file}:${name}`);
    return { name, file, start: first + 1, end: last + 1, physicalLines: last - first + 1 };
  });
}
const components = 'src/comparison/components.tsx', plain = 'src/comparison/plain.ts';
const files = [components, plain, 'src/comparison/kernel.ts', 'src/comparison/domain.ts', 'src/core.ts'];
console.log(JSON.stringify({
  scope: 'Historical JSX experiment: two operations sharing the same adapters, journal and failure semantics. Not the current recommended Koyuki API.',
  limitations: [
    'Not a large-application, onboarding, bug-rate, usability or performance study.',
    'Plain TypeScript with a reusable helper is a first-class baseline; inline duplication alone is insufficient.',
    'Declaration line ranges exclude imports and assembly. Full file sizes and shared infrastructure are listed separately.',
    'Do not sum overlapping declaration ranges or present these sizes as a feature-equivalent total cost.',
  ],
  modes: {
    inlineTS: { operations: measure(plain, ['reservationInline', 'orderInline']), support: [] },
    sharedTS: { operations: measure(plain, ['reservationShared', 'orderShared']), support: measure(plain, ['commitAndNotify']) },
    jsx: { operations: measure(components, ['ReservationProcess', 'OrderProcess']), support: measure(components, ['defineCommitAndNotify']) },
  },
  files: files.map(file => {
    const source = readFileSync(file, 'utf8').trimEnd();
    return { file, physicalLines: source.split('\n').length, sha256: createHash('sha256').update(readFileSync(file)).digest('hex') };
  }),
}, null, 2));
