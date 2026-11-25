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
test('shipping declares both service paths without IO and overlays only the executed service', async () => {
  const calls: string[] = [];
  const ports: ShippingPorts = {
    async loadOrder(request) { calls.push('load'); return ok({ request, order: { id: request.orderId, version: 1, status: 'open', totalYen: 10000 } }); },
    async quote(command) { calls.push('quote'); return ok({ command, feeYen: 500 }); },
    async save(decision) { calls.push('save'); return ok({ orderId: decision.orderId, version: decision.expectedVersion + 1 }); },
  };
  const action = createShippingAction(ports), graph = describeFlow(action);
  assert.deepEqual(graph.nodes.map(node => node.name), ['validate-shipping', 'load-order', 'ensure-shipping-order', 'shipping-service',
    'select-domestic-service', 'select-international-service', 'shipping-service:join', 'fetch-shipping-quote', 'accept-shipping-quote', 'shipping.save.v1']);
  assert.deepEqual(graph.edges.filter(edge => edge.choice).map(edge => edge.choice), ['yes', 'no']);
  assert.deepEqual(calls, []);
  const report = await action.runDetailed({ orderId: 'o1', country: 'US', weightGrams: 1000 }); assert(report.result.ok);
  assert.deepEqual(calls, ['load', 'quote', 'save']);
  const traced = describeFlow(action, report.trace);
  assert.equal(traced.nodes.find(node => node.name === 'select-international-service')?.match, 'ok');
  assert.equal(traced.nodes.find(node => node.name === 'select-domestic-service')?.match, 'none');
  assert.equal(traced.nodes.find(node => node.name === 'shipping-service')?.match, 'ok');
  assert.deepEqual(traced.unmatchedTrace, []);
  calls.length = 0;
  const domestic = await action.runDetailed({ orderId: 'o1', country: 'JP', weightGrams: 1000 }); assert(domestic.result.ok);
  const domesticGraph = describeFlow(action, domestic.trace);
  assert.equal(domesticGraph.nodes.find(node => node.name === 'select-domestic-service')?.match, 'ok');
  assert.equal(domesticGraph.nodes.find(node => node.name === 'select-international-service')?.match, 'none');
  assert.deepEqual(calls, ['load', 'quote', 'save']);
  assert(flowMermaid(action, report.trace).includes('class n0 matched'));
});
