import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import vm from 'node:vm';import ts from 'typescript';
import {canAccess,DEFAULT_ROLES} from '../../../../../packages/shared/src/lib/access.ts';
import * as policies from './route-policy.ts';
const source=await readFile(new URL('./route-boundary.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
class AccessError extends Error{constructor(message,status=403){super(message);this.status=status;}}
function setup(snapshot,options){
 let calls=0,queries=0;
 const exports={};const env={TEAM_ACCESS_ENFORCEMENT:'true'};
 const imports={
  '@autodealer/shared/lib/access':{canAccess},
  '@/lib/api/cors':{jsonWithCors:(_request,data,init)=>Response.json(data,init)},
  './server':{AccessError,requireAccessContext:async()=>{queries++;if(!snapshot)throw new AccessError('Please sign in.',401);return snapshot;}},
  './resources':{requireResourceAccess:async(_req,_type,id,permission)=>{if(id==='outside'||!canAccess(snapshot,permission,'company-a'))throw new AccessError('Outside scope',404);}},
  './route-policy':policies,
 };
 vm.runInNewContext(compiled,{exports,require:name=>{if(!imports[name])throw Error(`Unexpected dependency ${name}`);return imports[name];},process:{env},URL,Buffer});
 const handle=exports.withTeamAccess(async()=>{calls++;return Response.json({ok:true});},options);
 return {handle,env,get calls(){return calls;},get queries(){return queries;}};
}
function snapshot(role){return {organizationId:'org-a',sharingEnabled:true,member:{user_id:'user',status:'active',must_change_password:false,is_owner:false,modules:['purchases','bank','discounts','followups'],all_companies:false,company_ids:['company-a']},role:{...role,archived:false}};}
test('default role API matrix denies before handlers execute',async()=>{
 const operations=[['/api/cases','GET','purchases.view'],['/api/cases/c1/analysis','POST','purchases.prepare'],['/api/cases/c1/tally-posting','POST','purchases.post',{action:'approve_and_queue'}],['/api/settings/init','GET','settings.manage'],['/api/bank-statements/tally/queue','POST','bank.post']];
 for(const role of DEFAULT_ROLES)for(const [path,method,key,body]of operations){const context=snapshot(role),r=setup(context);const response=await r.handle(new Request(`http://localhost${path}`,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})}));const allowed=canAccess(context,key);assert.equal(response.status,allowed?200:403,`${role.key}: ${key}`);assert.equal(r.calls,allowed?1:0);}
});
test('revocation, password changes and missing setup fail closed',async()=>{
 for(const change of [{member:{status:'suspended'}},{member:{must_change_password:true}},{sharingEnabled:false}]){
  const s=snapshot(DEFAULT_ROLES[2]);Object.assign(s,{...change,member:{...s.member,...change.member}});const r=setup(s);const response=await r.handle(new Request('http://localhost/api/cases'));assert.ok([403,503].includes(response.status));assert.equal(r.calls,0);
 }
 const r=setup(null);assert.equal((await r.handle(new Request('http://localhost/api/cases'))).status,401);
});
test('resource IDs and hard-delete permissions cannot be replaced by body scope',async()=>{
 const r=setup(snapshot(DEFAULT_ROLES[2]));const response=await r.handle(new Request('http://localhost/api/cases/outside/analysis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({companyId:'company-a'})}));assert.equal(response.status,404);assert.equal(r.calls,0);
 const s=snapshot({...DEFAULT_ROLES[2],permissions:['purchases.view','purchases.recycle']});const h=setup(s);assert.equal((await h.handle(new Request('http://localhost/api/cases/c1?mode=hard',{method:'DELETE'}))).status,403);
});
test('legacy mode is unchanged and unknown team endpoints are denied',async()=>{const r=setup(null);r.env.TEAM_ACCESS_ENFORCEMENT='false';assert.equal((await r.handle(new Request('http://localhost/api/cases'))).status,200);assert.equal(r.queries,0);const h=setup(snapshot(DEFAULT_ROLES[2]));assert.equal((await h.handle(new Request('http://localhost/api/unknown'))).status,403);});

test('only explicit connector-session branch reaches bridge-token authentication',async()=>{
 const make=role=>new Request('http://localhost/api/collections/live/session',{method:'POST',headers:{'Content-Type':'application/json','X-Bridge-Token':'synthetic'},body:JSON.stringify({role})});
 const bridge=setup(null,{bridgeSession:true});assert.equal((await bridge.handle(make('connector'))).status,200);assert.equal(bridge.queries,0);
 assert.equal((await bridge.handle(make('browser'))).status,401);
 const ordinary=setup(null);assert.equal((await ordinary.handle(make('connector'))).status,401);
});
