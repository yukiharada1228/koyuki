import { readFileSync } from 'node:fs';
// Measures the named, multiline function declarations in these comparison fixtures.
// Their closing brace has the same indentation as the declaration.
function measure(file, names) {
  const lines = readFileSync(file, 'utf8').split('\n');
  return names.map(name => {
    const pattern = new RegExp(`^([ \\t]*)(?:export )?(?:async )?function ${name}\\b`);
    const start = lines.findIndex(line => pattern.test(line));
    if (start < 0) throw new Error(`Missing function: ${name}`);
    const indent = pattern.exec(lines[start])[1];
    const offset = lines.slice(start + 1).findIndex(line => line === `${indent}}`);
    if (offset < 0) throw new Error(`Missing function end: ${name}`);
    const end = start + 1 + offset;
    return { name, file, start: start + 1, end: end + 1, lines: end - start + 1 };
  });
}
console.log(JSON.stringify({
  note: 'Physical function line counts with audit extension included. Not a usability or performance score. Shared kernel/adapters excluded equally. JSX setup and TS one-line wrappers are outside these function counts; inspect full files for total cost.',
  measurements: [
    ...measure('src/comparison/components.tsx', ['defineCommitAndNotify', 'ReservationProcess', 'OrderProcess']),
    ...measure('src/comparison/plain.ts', ['reservationInline', 'orderInline', 'commitAndNotify']),
  ],
}, null, 2));
