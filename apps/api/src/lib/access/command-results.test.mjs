import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFile} from 'node:fs/promises';import ts from 'typescript';
import {canAccess} from '../../../../../packages/shared/src/lib/access.ts';
const source=await readFile(new URL('./command-results.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const conn='ffffffff-ffff-ffff-ffff-ffffffffffff',company='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
class AccessError extends Error{constructor(message,status){super(message);this.status=status;}}
function fixture(permissions=['bank.view']) {
 const calls=[],access={organizationId:'org-a',companies:[{id:company},{id:'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'}],member:{status:'active',is_owner:false,must_change_password:false,all_companies:false,company_ids:[company],modules:['bank']},role:{archived:false,permissions}};
 const query={then(resolve){resolve({data:[{id:'result'}]});}};
 for(const name of ['select','eq','or','order','limit','in'])query[name]=(...args)=>{calls.push([name,...args]);return query;};
 const exports={},imports={'@autodealer/shared/lib/access':{canAccess},'@/lib/supabase/admin':{createSupabaseAdminClient:()=>({from:name=>{calls.push(['from',name]);return query;}})},'./server':{AccessError,requireAccessContext:async()=>access}};
 vm.runInNewContext(code,{exports,require:key=>imports[key]});
 return {calls,access,run:(ids=[],limit=20)=>exports.readTeamCommands({},conn,ids,limit)};
}
test('financial scope is applied before pagination without ownership filtering',async()=>{
 const f=fixture();await f.run();const clause=f.calls.find(c=>c[0]==='or')[1];
 assert.match(clause,/bank.view/);assert.ok(!clause.includes('bbbbbbbb'));assert.ok(!clause.includes('connections.manage'));
 assert.ok(f.calls.findIndex(c=>c[0]==='or')<f.calls.findIndex(c=>c[0]==='limit'));
 assert.ok(f.calls.some(c=>c[0]==='eq'&&c[1]==='organization_id'&&c[2]==='org-a'));
 assert.ok(!f.calls.some(c=>c.includes('owner_user_id')));
});
test('connection administration does not grant financial result or export access',async()=>{
 const f=fixture(['connections.manage']);await f.run();const clause=f.calls.find(c=>c[0]==='or')[1];
 assert.match(clause,/connections.manage/);assert.ok(!clause.includes('bank.view'));assert.ok(!clause.includes('bank.export'));
});
test('suspended users return no rows; guessed/oversized selections are rejected',async()=>{
 const f=fixture();f.access.member.status='suspended';assert.equal((await f.run()).length,0);assert.equal(f.calls.length,0);
 await assert.rejects(f.run(['not-a-uuid']),e=>e.status===400);
 await assert.rejects(f.run(Array(101).fill(conn)),e=>e.status===400);
});
