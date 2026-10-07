import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFile} from 'node:fs/promises';import ts from 'typescript';
const source=await readFile(new URL('./protected-preview.ts',import.meta.url),'utf8');
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const expected='/api/cases/case/files?fileId=file&content=1';
function fixture(){
 let epoch=0,clear,resolve;const calls=[],revoked=[],exports={};
 const body=new Promise(r=>{resolve=r;});
 const imports={'./api-client':{apiFetch:async path=>{calls.push(path);return {ok:true,blob:()=>body};}},
 './access-cache':{accessCacheEpoch:()=>epoch,registerAccessCache:(_name,fn)=>{clear=fn;}}};
 vm.runInNewContext(code,{exports,require:name=>imports[name],URLSearchParams,DOMException,
  URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL:url=>revoked.push(url)},window:{addEventListener(){}}});
 return {api:exports,calls,revoked,resolve,change(){epoch++;clear();}};
}
test('protected preview accepts only the exact authenticated case file path',async()=>{
 const f=fixture();await assert.rejects(f.api.loadProtectedCasePreview('case','file','https://other.test/'),/Invalid/);
 assert.equal(f.calls.length,0);
});
test('access change during body transfer discards document bytes',async()=>{
 const f=fixture();const pending=f.api.loadProtectedCasePreview('case','file',expected);
 f.change();f.resolve({size:4});await assert.rejects(pending,error=>error.name==='AbortError');
});
test('protected object URLs are revoked on release and access invalidation',async()=>{
 const f=fixture();f.resolve({size:4});const url=await f.api.loadProtectedCasePreview('case','file',expected);
 f.api.releaseProtectedPreview(url);f.api.releaseProtectedPreview(url);assert.equal(f.revoked.length,1);
 await f.api.loadProtectedCasePreview('case','file',expected);f.change();assert.equal(f.revoked.length,2);
});
