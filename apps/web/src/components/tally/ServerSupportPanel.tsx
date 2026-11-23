'use client';
import {useEffect,useState} from 'react';
import {apiFetch} from '@/lib/api-client';

type Dataset={id:string;name:string;guid:string;year:string;diagnose:boolean;voucher:boolean};
type Job={id:string;actor:string;action:string;status:string;created:string;installed:boolean;result:unknown;error?:string};
type Snapshot={capable:boolean;datasets:Dataset[];history:Job[];version:string;lastHeartbeat:string;online:boolean;tallyReachable:boolean;updates:boolean};
const labels:Record<string,string>={diagnose:'Diagnose server',voucher:'Find voucher',check_update:'Check for update',install_update:'Install signed update'};
export function ServerSupportPanel({connectionId}:{connectionId:string}) {
 const [data,setData]=useState<Snapshot|null>(null),[selection,select]=useState(''),[value,setValue]=useState(''),[version,setVersion]=useState('');
 const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[revision,refresh]=useState(0);
 const url='/api/tally/connections/'+encodeURIComponent(connectionId)+'/support';
 useEffect(()=>{
   let closed=false,timer:ReturnType<typeof setTimeout>;
   async function read(){
     try{
       const response=await apiFetch(url,{cache:'no-store'});
       if(closed)return;
       if([401,403,404,409].includes(response.status)){setData(null);return;}
       if(!response.ok)throw Error('Support status unavailable.');
       const next=await response.json() as Snapshot;
       if(!closed)setData(next);
     }catch{if(!closed)setMessage('Could not refresh server support status.');}
     finally{if(!closed)timer=setTimeout(read,10000);}
   }
   void read();return ()=>{closed=true;clearTimeout(timer);};
 },[url,revision]);
 if(!data)return null;
 const key=(d:Dataset)=>[d.id,d.guid,d.year].join('/');
 const selected=data.datasets.find(d=>key(d)===selection)??data.datasets[0];
 if(!selected)return null;
 async function submit(action:string,argument=''){
   setBusy(true);setMessage('');
   try{
     const response=await apiFetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
       action,value:argument,companyId:selected.id,guid:selected.guid,year:selected.year})});
     const result=await response.json();
     if(!response.ok)throw Error(result.error||'Request failed');
     setMessage('Request queued. Progress appears in support history.');refresh(x=>x+1);
   }catch(e){setMessage(e instanceof Error?e.message:'Request failed');}finally{setBusy(false);}
 }
 const disabled=busy||!data.online||!data.capable;
 return <details className="rounded-xl border bg-white p-4"><summary className="cursor-pointer font-semibold">Server support</summary>
   <div className="mt-3 space-y-3 text-sm">
    <p>Connector {data.version} ? {data.online?'Online':'Offline'} ? Tally {data.tallyReachable?'reachable':'unreachable'} ? Last heartbeat {data.lastHeartbeat?new Date(data.lastHeartbeat).toLocaleString():'unknown'}</p>
    {!data.capable&&<p>Install the support-enabled connector on the Tally server to run remote requests.</p>}
    <select aria-label="Support company and year" value={key(selected)} onChange={e=>select(e.target.value)}>{data.datasets.map(d=><option key={key(d)} value={key(d)}>{d.name} ? {d.year}</option>)}</select>
    {selected.diagnose&&<p><button disabled={disabled} onClick={()=>void submit('diagnose')}>Diagnose server</button></p>}
    {selected.voucher&&<div><input aria-label="Voucher number" placeholder="Voucher number" maxLength={120} value={value} onChange={e=>setValue(e.target.value)}/> <button disabled={disabled||!value.trim()} onClick={()=>void submit('voucher',value.trim())}>Find voucher</button></div>}
    {data.updates&&<div><button disabled={disabled} onClick={()=>void submit('check_update')}>Check for update</button> ? <input aria-label="Staged version" placeholder="Staged version" value={version} onChange={e=>setVersion(e.target.value)}/> <button disabled={disabled||!/^\d+\.\d+\.\d+$/.test(version)} onClick={()=>void submit('install_update',version)}>Install signed update</button></div>}
    <p role="status">{message}</p>
    {data.history.map(j=><details key={j.id}><summary>{labels[j.action]} ? {j.installed?'Version confirmed':j.action==='install_update'&&j.status==='succeeded'?'Awaiting version heartbeat':j.status} ? {new Date(j.created).toLocaleString()}</summary><p>Requested by {j.actor}</p>{j.error??<pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(j.result,null,2)}</pre>}</details>)}
   </div></details>;
}
