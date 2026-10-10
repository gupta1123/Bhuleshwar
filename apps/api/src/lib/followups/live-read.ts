import {randomUUID} from 'node:crypto';

/** Server receives evidence directly from the authenticated connector gateway. */
export function readReminderBills(request:Request, scope:{connectionId:string;companyName:string;financialYear:string;organizationId:string}, ledger:string|string[], verificationInvoice?:{invoice:string;invoiceDate:string}) {
  const configured=process.env.CASH_DISCOUNT_GATEWAY_URL || (process.env.NODE_ENV!=='production'?'ws://127.0.0.1:3002/':'');
  if (!configured) throw new Error('The follow-up Tally gateway is not configured.');
  const token=request.headers.get('authorization')?.replace(/^Bearer\s+/i,'');
  if (!token) throw new Error('Sign in again before checking outstanding.');
  return new Promise<Record<string,unknown>>((resolve,reject)=>{
    const socket=new WebSocket(configured);
    const id=randomUUID();let done=false;let requested=false;
    const finish=(error?:Error,data?:Record<string,unknown>)=>{if(done)return;done=true;clearTimeout(timer);socket.close();if(error)reject(error);else resolve(data!);};
    const timer=setTimeout(()=>finish(new Error('Tally verification timed out. Try again when the connector is ready.')),60_000);
    socket.addEventListener('open',()=>socket.send(JSON.stringify({type:'authenticate',role:'browser',token,...scope})));
    socket.addEventListener('message',event=>{
      try {
        if(typeof event.data!=='string'||event.data.length>30*1024*1024)throw new Error('Tally response exceeded the verification limit.');
        const message=JSON.parse(event.data);
        if(!requested&&(message.type==='authenticated'||(message.type==='hello'&&message.authenticated===true))) {requested=true;socket.send(JSON.stringify({type:'request',requestId:id,...scope,operation:'fetch_customer_open_bills',payload:{companyName:scope.companyName,financialYear:scope.financialYear,ledgerNames:[...new Set(Array.isArray(ledger)?ledger:[ledger])],queryPurpose:'payment_followup',verificationInvoice}}));}
        else if(message.type==='error') finish(new Error(message.error||'Tally verification failed.'));
        else if(message.type==='result'&&message.requestId===id) {if(message.success)finish(undefined,message.data);else finish(new Error(message.error||'Tally verification failed.'));}
      } catch(error){finish(error instanceof Error?error:new Error('Invalid Tally response.'));}
    });
    socket.addEventListener('error',()=>finish(new Error('The Tally live gateway is unavailable.')));
    socket.addEventListener('close',()=>{if(!done)finish(new Error('Tally disconnected during verification.'));});
  });
}
