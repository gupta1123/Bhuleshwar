import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFile} from 'node:fs/promises';import ts from 'typescript';
import {canAccess} from '../../../../../packages/shared/src/lib/access.ts';
const source=await readFile(new URL('./dataset.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
class AccessError extends Error{constructor(message,status){super(message);this.status=status;}}
function fixture(){
 const access={organizationId:'org-a',member:{status:'active',is_owner:false,must_change_password:false,all_companies:false,company_ids:['a'],modules:['discounts']},role:{archived:false,permissions:['discounts.view','discounts.prepare']}};
 const links=[2025,2026].map(year=>({connection_id:'connection',installation_id:'install',company_id:'a',company_guid:'guid',company_name:'Same name',financial_year:`${year}`}));
 links.push({...links[0],company_id:'b',company_guid:'other'});
 const exports={},imports={'@autodealer/shared/lib/access':{canAccess},'./server':{AccessError},'./connection-scope':{permittedConnections:async()=>({access,links,rows:[{id:'connection',installation_id:'install',owner_user_id:'paired'}]})}};
 vm.runInNewContext(code,{exports,require:key=>imports[key]});
 return {run:selection=>exports.requireDataset({},'connection',selection,'discounts.prepare'),access};
}
test('same company name across years requires an explicit dataset selection',async()=>{
 const f=fixture();await assert.rejects(f.run({companyName:'Same name'}),error=>error.status===409);
 const selected=await f.run({companyName:'Same name',financialYear:'2026'});
 assert.equal(selected.link.company_guid,'guid');assert.equal(selected.connection.owner_user_id,'paired');assert.equal(selected.columns.access_company_id,'a');
});
test('supplied company IDs, GUIDs and disabled modules cannot expand access',async()=>{
 const f=fixture();for(const selection of [{companyId:'b'},{companyGuid:'other'},{financialYear:'2027'}])await assert.rejects(f.run(selection),AccessError);
 f.access.member.modules=[];await assert.rejects(f.run({financialYear:'2026'}),AccessError);
});
