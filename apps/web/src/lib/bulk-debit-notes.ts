/** Stop on the first uncertain write. Never replay a possibly accepted entry. */
export async function runDebitNoteBatch<T>(rows:readonly T[], handlers:{canContinue:()=>boolean;create:(row:T)=>Promise<void>;confirmed:(row:T)=>void;uncertain:(row:T,error:unknown)=>void}) {
  let confirmed=0;
  for(const row of rows){
    if(!handlers.canContinue())return {confirmed,stopped:true,scopeChanged:true};
    try {await handlers.create(row);}
    catch(error){handlers.uncertain(row,error);return {confirmed,stopped:true,scopeChanged:false};}
    confirmed++;handlers.confirmed(row);
  }
  return {confirmed,stopped:false,scopeChanged:false};
}
