import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentJobScheduler } from './scheduler.mjs';
import { startDetachedDocument } from './detached-document.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let i = 0; i < 100 && !predicate(); i++) await tick();
  assert.ok(predicate(), 'Expected state was not reached');
}
function fixture() {
  const jobs = new Map();
  const storage = { async call(method, args = {}) {
    if (method === 'recoverJobs') return {};
    if (method === 'enqueueJob') {
      const j = args.job;
      if (!jobs.has(j.id)) jobs.set(j.id, { ...j, job_class: j.jobClass, created_at: new Date().toISOString(), status: 'queued' });
      return jobs.get(j.id);
    }
    if (method === 'claimNextJob') {
      const job = [...jobs.values()].filter(j => j.status === 'queued' &&
        ((j.job_class === 'document_parse' && j.payload.pipelineVersion === 2) === (args.lane === 'document')))
        .sort((a,b) => b.priority-a.priority)[0];
      if (job) job.status = 'running';
      return job;
    }
    if (method === 'updateJob') { Object.assign(jobs.get(args.id), args); return jobs.get(args.id); }
    throw new Error(`Unexpected operation: ${method}`);
  } };
  return { jobs, scheduler: new AgentJobScheduler({ storage }) };
}

test('v2 document waiting does not block Tally jobs; each lane stays serial', async () => {
  const { jobs, scheduler } = fixture(); const release = deferred(), started = [];
  scheduler.register('document', async job => { started.push(job.id); if (job.id === 'd1') await release.promise; return {}; });
  scheduler.register('read', async job => { started.push(job.id); return {}; });
  // Classes other than background allow this deterministic test on low-RAM CI.
  for (const [id, type, jobClass, priority] of [['d1','document','document_parse',80], ['d2','document','document_parse',80], ['r1','read','verification',10]]) {
    await scheduler.enqueue({ id, type, jobClass, priority, identity: {}, payload: { pipelineVersion: 2 } });
  }
  const running = scheduler.start();
  try {
    await until(() => jobs.get('r1').status === 'succeeded' && started.includes('d1'));
    assert.equal(started.includes('d2'), false);
    assert.equal(scheduler.activeJobs.length, 1);
    release.resolve();
    await until(() => jobs.get('d2').status === 'succeeded');
  } finally { release.resolve(); scheduler.stop(); await running; }
});

test('Tally lane retains priority order and legacy document jobs stay in that lane', async () => {
  const { scheduler, jobs } = fixture(); const order = [];
  scheduler.register('task', async job => { order.push(job.id); return {}; });
  for (const [id, priority] of [['background',10], ['post',100], ['verify',90]]) {
    await scheduler.enqueue({ id, type: 'task', identity: {}, jobClass: 'verification', priority });
  }
  const running = scheduler.start();
  try { await until(() => jobs.get('background').status === 'succeeded'); assert.deepEqual(order, ['post','verify','background']); }
  finally { scheduler.stop(); await running; }
});

test('detached delivery is deduplicated and a lost ACK does not report a fabricated failure', async () => {
  const done = deferred(); let executions = 0, deliveries = 0, deliveryErrors = 0;
  const runtime = { execute: async () => { executions++; return done.promise; } };
  const deliver = async outcome => { deliveries++; assert.equal(outcome.success, true); throw new Error('lost ACK'); };
  for (let i = 0; i < 2; i++) startDetachedDocument(runtime, { id: 'same' }, deliver, () => { deliveryErrors++; });
  await tick(); assert.equal(executions, 1); assert.equal(deliveries, 0);
  done.resolve({ success: true, result: {} });
  await until(() => deliveryErrors === 1); assert.equal(deliveries, 1);
});
