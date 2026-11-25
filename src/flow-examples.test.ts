import test from 'node:test';
import assert from 'node:assert/strict';
import { describeFlow, flowMermaid, ok } from './framework/index.js';
import { tagModel } from './tags/model.js';
import { createTagEvent } from './tags/events.js';
import { Repository } from './tags/repository.js';
import { createShippingAction, type ShippingPorts } from './shipping/feature.js';

test('real tag creation diagram includes the declared roles and IO without touching the repository', async () => {
  const repository = new Repository(), command = tagModel(repository).creation.on(createTagEvent);
  const graph = describeFlow(command);
  assert.deepEqual(graph.nodes.map(node => node.name), ['load-create', 'validate-create', 'check-unique-label', 'check-quota', 'create-tag', 'tag.create.v1']);
  assert.deepEqual(graph.nodes.map(node => node.role), ['effect', 'validate', 'require', 'require', 'evolve', 'save']);
  assert.equal(repository.calls.length, 0); assert.equal(repository.records.size, 0);
  assert(flowMermaid(command).includes('flowchart TD'));
  const report = await command.runDetailed({ groupId: 'g', label: 'VIP', icon: null }); assert(report.result.ok);
  assert(describeFlow(command, report.trace).nodes.every(node => node.match === 'ok'));
  assert.equal(repository.records.size, 1); assert.equal(repository.calls.length, 2);
});
test('real shipping diagram includes quote IO and save but keeps the function-internal service choice opaque', async () => {
  const calls: string[] = [];
  const ports: ShippingPorts = {
    async loadOrder(request) { calls.push('load'); return ok({ request, order: { id: request.orderId, version: 1, status: 'open', totalYen: 10000 } }); },
    async quote(command) { calls.push('quote'); return ok({ command, feeYen: 500 }); },
    async save(decision) { calls.push('save'); return ok({ orderId: decision.orderId, version: decision.expectedVersion + 1 }); },
  };
  const action = createShippingAction(ports), graph = describeFlow(action);
  assert.deepEqual(graph.nodes.map(node => node.name), ['validate-shipping', 'load-order', 'select-shipping-service', 'fetch-shipping-quote', 'accept-shipping-quote', 'shipping.save.v1']);
  assert.deepEqual(graph.nodes.map(node => node.role), ['rule', 'effect', 'rule', 'effect', 'rule', 'save']);
  assert.equal(graph.nodes.find(node => node.name === 'select-shipping-service')?.implementation, 'opaque');
  assert(!graph.nodes.some(node => node.kind === 'branch')); assert.deepEqual(calls, []);
  const report = await action.runDetailed({ orderId: 'o1', country: 'US', weightGrams: 1000 }); assert(report.result.ok);
  assert.deepEqual(calls, ['load', 'quote', 'save']);
  assert(describeFlow(action, report.trace).nodes.every(node => node.match === 'ok'));
  assert(flowMermaid(action, report.trace).includes('class n0 matched'));
});
