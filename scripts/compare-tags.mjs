import { readFileSync, readdirSync } from 'node:fs';
function block(file, startText, endText) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const first = lines.findIndex(line => line.startsWith(startText));
  if (first < 0) throw new Error(`Missing start: ${startText}`);
  const last = lines.findIndex((line, i) => i >= first && (endText === null ? i === first : line === endText));
  if (last < first) throw new Error(`Missing end: ${endText}`);
  return { file, start: first + 1, end: last + 1, physicalLines: last - first + 1 };
}
console.log(JSON.stringify({
  scope: 'Current tag pure-decision declarations only. Excludes application lifecycle, replay, tracing and adapter registration; not a feature-complete application or large-team evaluation.',
  note: 'Fixture physical line counts; not a readability, bug-rate or performance score. Domain and repository are shared. Framework support code is additional. The reusable compose baseline must be considered alongside manual Result wiring.',
  create: {
    plain: block('src/tags/plain.ts', 'export function createPlain', '}'),
    framework: block('src/tags/events.ts', 'export const createTagEvent', '};'),
    composedTS: block('src/tags/plain.ts', 'export const createComposed', null),
  },
  update: {
    plain: block('src/tags/plain.ts', 'export function updatePlain', '}'),
    framework: block('src/tags/events.ts', 'export const updateTagEvent', '};'),
    composedTS: block('src/tags/plain.ts', 'export const updateComposed', null),
  },
  supportFiles: [...readdirSync('src/framework').filter(file => file.endsWith('.ts')).map(file => `src/framework/${file}`), 'src/tags/model.ts', 'src/core.ts'].map(file => ({ file, physicalLines: readFileSync(file, 'utf8').trimEnd().split('\n').length })),
  supportNote: 'Source inventory, including optional/experimental modules and baseline core. Not all modules are required by either fixture. No combined cost or winner is inferred.',
}, null, 2));
