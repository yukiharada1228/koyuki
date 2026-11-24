import { readFileSync } from 'node:fs';
function block(file, startText, endText) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const first = lines.findIndex(line => line.startsWith(startText));
  if (first < 0) throw new Error(`Missing start: ${startText}`);
  const last = lines.findIndex((line, i) => i >= first && (endText === null ? i === first : line === endText));
  if (last < first) throw new Error(`Missing end: ${endText}`);
  return { file, start: first + 1, end: last + 1, physicalLines: last - first + 1 };
}
console.log(JSON.stringify({
  note: 'Fixture physical line counts; not a readability or performance score. Domain and repository are shared. Framework support code is additional.',
  create: {
    plain: block('src/tags/plain.ts', 'export function createPlain', '}'),
    framework: block('src/tags/feature.tsx', 'export const createWorkflow', "  .then('create-tag', createTag);"),
    composedTS: block('src/tags/plain.ts', 'export const createComposed', null),
  },
  update: {
    plain: block('src/tags/plain.ts', 'export function updatePlain', '}'),
    framework: block('src/tags/feature.tsx', 'export const updateWorkflow', "  .then('update-tag', updateTag);"),
    composedTS: block('src/tags/plain.ts', 'export const updateComposed', null),
  },
  supportFilePhysicalLines: readFileSync('src/framework/workflow.ts', 'utf8').trimEnd().split('\n').length,
}, null, 2));
