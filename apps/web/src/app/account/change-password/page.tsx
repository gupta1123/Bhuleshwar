'use client';
import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {useAccess} from '@/components/access/AccessProvider';
import {apiFetch} from '@/lib/api-client';
export default function ChangePasswordPage(){
 const access=useAccess();const router=useRouter();const [current,setCurrent]=useState('');const [password,setPassword]=useState('');const [confirm,setConfirm]=useState('');const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 return <main className="mx-auto flex min-h-screen max-w-md items-center p-6"><form className="w-full space-y-5 rounded-2xl border bg-white p-6" onSubmit={async e=>{e.preventDefault();setError('');if(password!==confirm){setError('The new passwords do not match.');return;}setBusy(true);try{const r=await apiFetch('/api/access/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:current,newPassword:password})});const d=await r.json();if(!r.ok)throw Error(d.error);setCurrent('');setPassword('');setConfirm('');await access.refresh();router.replace('/');}catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>
 <h1 className="text-xl font-bold">Make this account yours</h1><p className="text-sm text-stone-500">Replace the temporary password from the Kalika team before continuing.</p>{error&&<p role="alert" className="text-sm text-red-700">{error}</p>}
 {[['Current password',current,setCurrent,'current-password'],['New password',password,setPassword,'new-password'],['Confirm new password',confirm,setConfirm,'new-password']].map(([label,value,setter,autocomplete])=><label key={label as string} className="block text-sm">{label as string}<input className="mt-2 w-full rounded-lg border p-3" type="password" autoComplete={autocomplete as string} required minLength={label==='Current password'?1:12} maxLength={256} value={value as string} onChange={e=>(setter as (v:string)=>void)(e.target.value)}/></label>)}
 <button className="w-full rounded-lg bg-stone-900 p-3 text-white" disabled={busy}>{busy?'Saving…':'Save new password'}</button></form></main>;
}
