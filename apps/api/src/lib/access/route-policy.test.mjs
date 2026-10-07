import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {userRoutePolicy} from './route-policy.ts';
const policy=(url,method='GET',action,type)=>userRoutePolicy(url,method,action,type);
test('purchase approval, posting and permanent deletion have separate permissions',()=>{
 assert.deepEqual(policy('/api/cases/c1/tally-posting','POST','approve_and_queue').permissions,['purchases.post']);
 assert.deepEqual(policy('/api/cases/c1/tally-posting','PATCH').permissions,['purchases.prepare']);
 assert.deepEqual(policy('/api/cases/c1/approval','POST','submit').permissions,['purchases.submit']);
 assert.deepEqual(policy('/api/cases/c1/approval','POST','approve').permissions,['purchases.approve']);
 assert.deepEqual(policy('/api/cases/c1','DELETE','permanent').permissions,['purchases.delete']);
 assert.deepEqual(policy('/api/cases/c1','DELETE').permissions,['purchases.recycle']);
});
test('resource checks use the path parent, not a caller-supplied company',()=>{
 assert.deepEqual(policy('/api/cases/c1/mismatches/m1','PATCH').resource,{type:'case',id:'c1'});
 assert.deepEqual(policy('/api/bank-statements/imports/i1/confirm','POST').resource,{type:'bank_import',id:'i1'});
 assert.deepEqual(policy('/api/collections/debit-note-proposals/p1/native-pdf').resource,{type:'proposal',id:'p1'});
});
test('unknown commands and paths fail closed; posting cannot use a read permission',()=>{
 assert.deepEqual(policy('/api/collections/debit-note-proposals','POST').permissions,['discounts.prepare']);
 assert.deepEqual(policy('/api/collections/live/session','POST').permissions,['@connection-status']);
 assert.equal(policy('/api/new-unreviewed-route'),null);
 assert.deepEqual(policy('/api/tally/agent/jobs','POST',undefined,'anything').permissions,[]);
 assert.deepEqual(policy('/api/tally/agent/jobs','POST',undefined,'create_purchase_voucher').permissions,[]);
 assert.deepEqual(policy('/api/tally/connections/c1/commands','POST',undefined,'create_purchase_voucher').permissions,[]);
 assert.deepEqual(policy('/api/bank-statements/tally/queue','POST').permissions,['bank.post']);
});
test('every user-authenticated route has an outer boundary and a policy',async()=>{
 const root=fileURLToPath(new URL('../../app/api/',import.meta.url));
 async function walk(dir){const files=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())files.push(...await walk(p));else if(e.name==='route.ts')files.push(p);}return files;}
 let checked=0;
 for(const file of await walk(root)){
  const source=await readFile(file,'utf8');const route='/api/'+path.relative(root,file).replaceAll('\\','/').replace(/\/route.ts$/,'').replace(/\[[^\]]+\]/g,'fixture-id');
  if(!source.includes('requireRequestUser')||route.startsWith('/api/access/'))continue;
  const exports=[...source.matchAll(/export const (GET|POST|PATCH|DELETE|PUT) = withTeamAccess\(/g)].map(m=>m[1]);
  assert.ok(exports.length,`Missing boundary: ${route}`);
  for(const method of exports)assert.ok(policy(route,method),`Missing policy: ${method} ${route}`);
  checked++;
 }
 assert.ok(checked>=50);
});
