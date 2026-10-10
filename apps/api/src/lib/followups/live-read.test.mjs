import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {readReminderBills} from './live-read.ts';
test('authenticated scoped gateway read returns connector evidence',async()=>{
 const server=new WebSocketServer({port:0});await new Promise(r=>server.on('listening',r));
 const previous=process.env.CASH_DISCOUNT_GATEWAY_URL;
 process.env.CASH_DISCOUNT_GATEWAY_URL=`ws://127.0.0.1:${server.address().port}`;
 const seen=[];
 server.on('connection',socket=>socket.on('message',raw=>{
  const m=JSON.parse(String(raw));seen.push(m);
  if(m.type==='authenticate')socket.send(JSON.stringify({type:'hello',authenticated:true}));
  else socket.send(JSON.stringify({type:'result',requestId:m.requestId,success:true,data:{byLedger:{Customer:{openBills:[]}}}}));
 }));
 try{
  const result=await readReminderBills(new Request('http://localhost',{headers:{authorization:'Bearer fixture'}}),{connectionId:'connection',companyName:'Company',financialYear:'2026-27',organizationId:'organization'},['Customer','Second customer','Customer']);
  assert.equal(seen[0].token,'fixture');assert.equal(seen[0].organizationId,'organization');
  assert.deepEqual(seen[1].payload.ledgerNames,['Customer','Second customer']);assert.equal(seen[1].financialYear,'2026-27');assert.deepEqual(result.byLedger.Customer.openBills,[]);
 }finally{if(previous===undefined)delete process.env.CASH_DISCOUNT_GATEWAY_URL;else process.env.CASH_DISCOUNT_GATEWAY_URL=previous;for(const client of server.clients)client.terminate();await new Promise(r=>server.close(r));}
});
