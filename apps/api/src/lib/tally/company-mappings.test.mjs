import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const code=ts.transpileModule(await readFile(new URL('./company-mappings.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
class AccessError extends Error {constructor(message,status=403){super(message);this.status=status;}}
const scope={organizationId:'org',companyId:'kalika26'};
const mapping=(values={})=>({owner_user_id:'aditya',connection_id:'nilesh-pc',company_name:'Kalika (26-27)',mapping_type:'item_hsn',source_key:'7204',target_master_type:'stock_item',target_master_key:'stock-guid',target_master_name:'M S Scrap & Sponge Iron',status:'active',updated_at:'2026-10-17T10:00:00Z',...values});
function fixture(overrides={},team=true){
 const tables={access_companies:[{id:'kalika26',organization_id:'org',name:'Kalika (26-27)'},{id:'kalika25',organization_id:'org',name:'Kalika (25-26)'}],
 access_company_links:[{organization_id:'org',company_id:'kalika26',connection_id:'nilesh-pc',installation_id:'pc'},{organization_id:'org',company_id:'kalika26',connection_id:'owner-pc',installation_id:'old-pc'}],
 tally_connections:[{id:'nilesh-pc',organization_id:'org',owner_user_id:'nilesh',installation_id:'pc',revoked_at:null},{id:'owner-pc',organization_id:'org',owner_user_id:'owner',installation_id:'old-pc',revoked_at:'old'}],
 access_members:[{organization_id:'org',user_id:'aditya'},{organization_id:'org',user_id:'nilesh'},{organization_id:'org',user_id:'owner'}],tally_mapping_settings:[mapping()],...overrides};
 const calls=[];
 const db={from(table){let rows=[...(tables[table]||[])];let single=false;const query={select(){return query;},eq(key,value){calls.push([table,'eq',key,value]);rows=rows.filter(r=>r[key]===value);return query;},in(key,values){calls.push([table,'in',key,values]);rows=rows.filter(r=>values.includes(r[key]));return query;},ilike(key,value){rows=rows.filter(r=>r[key]?.toLowerCase()===value.toLowerCase());return query;},limit(n){rows=rows.slice(0,n);return query;},maybeSingle(){single=true;return query;},then(resolve,reject){return Promise.resolve({data:single?rows[0]||null:rows,error:null}).then(resolve,reject);}};return query;}};
 const exports={};vm.runInNewContext(code,{exports,process:{env:{TEAM_ACCESS_ENFORCEMENT:team?'true':'false'}},require:name=>{if(name==='@/lib/access/server')return {AccessError};throw Error(name);}});
 return {read:params=>exports.readCompanyMappings(db,{connectionId:'nilesh-pc',companyName:'Kalika (26-27)',scope,...params}),calls};
}
test('Aditya’s purchase defaults are visible through Nilesh’s authorized connector',async()=>{
 const f=fixture();const rows=await f.read();assert.equal(rows[0].target_master_name,'M S Scrap & Sponge Iron');
 assert(!f.calls.some(([table,,key])=>table==='tally_mapping_settings'&&key==='owner_user_id'));
});
test('shared defaults use the newest company choice across PCs',async()=>{
 const f=fixture({tally_mapping_settings:[mapping({updated_at:'2026-10-15'}),mapping({connection_id:'owner-pc',owner_user_id:'owner',target_master_name:'New confirmed stock',updated_at:'2026-10-17'})]});
 assert.equal((await f.read())[0].target_master_name,'New confirmed stock');
});
test('another FY, organization, or non-member cannot contribute defaults',async()=>{
 const f=fixture({tally_mapping_settings:[mapping(),mapping({company_name:'Kalika (25-26)',updated_at:'2026-10-20'}),mapping({connection_id:'foreign-pc',updated_at:'2026-10-21'}),mapping({owner_user_id:'outsider',updated_at:'2026-10-22'})]});
 const rows=await f.read();assert.equal(rows.length,1);assert.equal(rows[0].owner_user_id,'aditya');
});
test('company name, missing scope and current installation mismatches fail closed',async()=>{
 await assert.rejects(fixture().read({scope:undefined}),e=>e.status===403);
 await assert.rejects(fixture().read({companyName:'Kalika (25-26)'}),e=>e.status===403);
 await assert.rejects(fixture({tally_connections:[{id:'nilesh-pc',organization_id:'org',installation_id:'replaced',revoked_at:null}]}).read(),e=>e.status===409);
 await assert.rejects(fixture().read({connectionId:'unknown'}),e=>e.status===403);
});
test('an inactive newest choice does not resurrect an older active mapping',async()=>{
 const f=fixture({tally_mapping_settings:[mapping(),mapping({connection_id:'owner-pc',owner_user_id:'owner',status:'inactive',updated_at:'2026-10-20'})]});assert.equal((await f.read()).length,0);
});
test('truncated snapshots fail closed',async()=>{
 const f=fixture({tally_mapping_settings:Array.from({length:5001},()=>mapping())});await assert.rejects(f.read(),e=>e.status===503);
});
test('legacy owner isolation remains when team enforcement is disabled',async()=>{
 const f=fixture({tally_mapping_settings:[mapping(),mapping({owner_user_id:'nilesh',target_master_name:'Nilesh legacy'})]},false);
 assert.equal((await f.read())[0].target_master_name,'Nilesh legacy');
});
