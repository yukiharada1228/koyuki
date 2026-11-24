// Intentionally invalid: compiled separately by test:quickstart.
import { ok, step, defineTarget, transition } from 'koyuki';
import { tagExample, created, type CreateTag, type Tag } from '../main.js';
// 1. Request shape: name is required.
tagExample().create.run({ id: 'missing-name' });
// 2. Save input must match the pure decision output.
defineTarget({ operation: 'bad.save', load: async (input: CreateTag) => ok(input),
  save: async (value: number) => ok(value),
}).on(created);
// 3. Adjacent pure steps must agree on their intermediate type.
transition({ validate: step('text', (text: string) => ok(text)), require: [] as const,
  evolve: step('numeric', (number: number) => ok(number)),
});
// 4. Unvalidated strings cannot create a TagName.
const tag: Tag = { id: 'raw', name: 'unvalidated' };
