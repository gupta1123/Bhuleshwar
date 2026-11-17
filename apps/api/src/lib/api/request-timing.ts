import { randomUUID } from 'node:crypto';

const traces = new WeakMap<Request,{id:string;start:number;spans:Record<string,number>}>();
export async function timeRequestStep<T>(request:Request,name:string,run:()=>Promise<T>) {
  const start=performance.now();
  try{return await run();}finally{const trace=traces.get(request);if(trace)trace.spans[name]=(trace.spans[name]||0)+performance.now()-start;}
}
export function withRequestTiming<Args extends unknown[]>(handler:(request:Request,...args:Args)=>Promise<Response>) {
  return async(request:Request,...args:Args)=>{
    const supplied=request.headers.get('x-request-id');
    const trace={id:supplied && /^[a-zA-Z0-9-]{8,64}$/.test(supplied)?supplied:randomUUID(),start:performance.now(),spans:{} as Record<string,number>};
    traces.set(request,trace);
    const response=await handler(request,...args);
    trace.spans.total=performance.now()-trace.start;
    response.headers.set('X-Request-Id',trace.id);
    response.headers.set('Server-Timing',Object.entries(trace.spans).map(([key,ms])=>`${key};dur=${ms.toFixed(1)}`).join(', '));
    console.info('[packet-request]',JSON.stringify({requestId:trace.id,path:new URL(request.url).pathname,method:request.method,status:response.status,spans:trace.spans}));
    return response;
  };
}
