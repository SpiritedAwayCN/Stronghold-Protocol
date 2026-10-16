import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBattleRunner } from '../../public/js/battle/runner.js';
import { createSimWorker } from '../../public/js/battle/simWorkerRuntime.js';
import { createStore, initialState } from '../../public/js/store.js';
import { fixtureSpec } from '../helpers/simHostFixture.js';
import * as spec from '../../server/sim/spec.js';
import { DataSource } from '../../server/sim/simdata.js';
import { DATA } from './harness.js';

const cs = 'ab'.repeat(32), vanilla = 'ee'.repeat(32);
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve)); };

test('prewarming shares pending loads, reuses the Worker and transfers its failure handler', async t => {
  const workers = [], handlers = new Map();
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  const content = { cs, data: DATA };
  const ds = new DataSource(DATA, null);
  class Worker {
    constructor() {
      workers.push(this);
      this.commands = [];
      this.dispatch = createSimWorker({ loadSim: async () => ({ spec, ds, cs }) });
    }
    postMessage(message) {
      this.commands.push(message.method);
      Promise.resolve().then(() => this.dispatch(message.method, message.args)).then(value => {
        this.onmessage?.({ data: { id: message.id, value } });
      }, error => this.onmessage?.({ data: { id: message.id, error: { message: error.message } } }));
    }
    terminate() { this.terminated = true; }
  }
  const previousWorker = globalThis.Worker;
  globalThis.Worker = Worker;
  t.after(() => { if (previousWorker === undefined) delete globalThis.Worker; else globalThis.Worker = previousWorker; });
  const net = {
    on(type, fn) { handlers.set(type, fn); return () => handlers.delete(type); },
    send() {}, request() { return Promise.resolve({}); },
  };
  const store = createStore({ ...initialState, content: { vanilla } });
  const runner = createBattleRunner({
    net, store, doc: { hidden: false, addEventListener() {} },
    raf: () => 1, caf() {}, setInterval: () => 1, clearInterval() {},
    simContent: () => content, contentFor: async () => content,
    loadSim: async () => { await ready; return { remote: true, cs, content }; },
    logger: { error() {}, warn() {} },
  });
  t.after(() => runner.clear());
  const first = runner.prewarm(cs), second = runner.prewarm(cs);
  assert.equal(second, first, 'same-content callers share the pending load');
  release();
  const host = await first;
  assert.ok(host);
  assert.equal(workers.length, 1);
  const battleSpec = fixtureSpec(); battleSpec.cs = cs;
  handlers.get('b.start')({ battleId: 'warm-test', fieldId: 'warm-field', own: true, authoritative: true, spec: battleSpec });
  await flush();
  const entry = runner._entries.get('warm-test');
  assert.equal(entry?.host, host);
  assert.equal(workers[0].commands.filter(method => method === 'load').length, 1);
  assert.equal(workers[0].commands.filter(method => method === 'start').length, 1);
  const originalWarn = console.warn;
  t.mock.method(console, 'warn', () => {});
  workers[0].onerror();
  assert.equal(entry.failed, true, 'a reused Worker failure reaches its active battle');
  assert.equal(workers[0].terminated, true);
  console.warn = originalWarn;
});
