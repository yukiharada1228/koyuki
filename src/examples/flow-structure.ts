import { describeFlow, flowMermaid, workflow, ok } from '../framework/index.js';
import { tagModel } from '../tags/model.js';
import { createTagEvent } from '../tags/events.js';
import { Repository } from '../tags/repository.js';
import { createShippingAction, type ShippingPorts } from '../shipping/feature.js';
// Only declarations are needed. Any attempt to run an external port fails this demo.
const unavailable = async (): Promise<never> => { throw new Error('DiagramMustNotExecuteIO'); };
const ports: ShippingPorts = { loadOrder: unavailable, quote: unavailable, save: unavailable };
const repository = new Repository();
const tag = tagModel(repository).creation.on(createTagEvent);
const shipping = createShippingAction(ports);
const branch = workflow('input', (n: number) => ok(n)).branch('positive?', n => n > 0, {
  yes: workflow('positive', (n: number) => ok(n)), no: workflow('non-positive', (n: number) => ok(n)),
});
const output = Object.fromEntries(Object.entries({ tag, shipping, branch }).map(([name, command]) => [name, {
  graph: describeFlow(command), mermaid: flowMermaid(command),
}]));
if (repository.calls.length !== 0) throw new Error('DiagramMustNotExecuteRepository');
console.log(JSON.stringify({ schema: 'koyuki.flow-examples.v1', ...output }, null, 2));
