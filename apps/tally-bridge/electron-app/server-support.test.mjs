import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import {readFile} from 'node:fs/promises';

const src=await readFile(new URL('./main.mjs',import.meta.url),'utf8');
const code=src.slice(src.indexOf('function verifyStagedInstaller('),src.indexOf('async function startRunner()'));
function fixture(signatureOK=true) {
 const events=[];
 const ctx={app:{isPackaged:true,getVersion:()=>'1.2.52'},process:{env:{},execPath:'current.exe'},path,
  autoUpdater:{downloadedUpdateHelper:{file:'new.exe'}},fs:{existsSync:p=>p==='new.exe'},errPath:'errors',
  isNewerVersion:v=>v==='1.2.53',updateState:{state:'ready',availableVersion:'1.2.53'},
  runner:{getAgentStatus:async()=>({datasets:[{company_guid:'other',financial_year:'27',last_sync_at:'private'},
    {company_guid:'g',financial_year:'27',last_sync_at:'visible'}]})},lastStatus:{state:'running'},
  downloadedRelease:{},verifyRelease:(file)=>{events.push('signature');assert.equal(file,'new.exe');if(!signatureOK)throw Error('Signature invalid');},
  installDownloadedUpdateWhenSafe:()=>events.push('install')};
 vm.runInNewContext(code,ctx);
 return {ctx,events};
}
test('unsigned or mismatched releases cannot schedule an installation',async()=>{
 const f=fixture(false);await assert.rejects(f.ctx.serverSupport('install_update','1.2.53'),/Signature/);
 await assert.rejects(f.ctx.serverSupport('install_update','1.2.99'),/not staged/);
 assert.deepEqual(f.events,['signature']);
});
test('installing is deferred until after command acknowledgement',async()=>{
 const f=fixture();const r=await f.ctx.serverSupport('install_update','1.2.53');assert.deepEqual(f.events,['signature']);
 r.install();assert.deepEqual(f.events,['signature','install']);
 const bridge=await readFile(new URL('../src/bridge.mjs',import.meta.url),'utf8');
 assert.match(bridge,/await sendCommandResult\(config,command,outcome\);\s*if \(outcome.success && install\) install\(\)/);
});
test('diagnostics return only the selected dataset and categorized errors',async()=>{
 const {ctx}=fixture();const r=await ctx.serverSupport('diagnose','',{companyGuid:'g',financialYear:'27'});
 assert.equal(r.result.lastLedgerSync,'visible');assert.ok(!JSON.stringify(r.result).includes('private'));
 await assert.rejects(ctx.serverSupport('shell','anything'),/Unknown support action/);
});
