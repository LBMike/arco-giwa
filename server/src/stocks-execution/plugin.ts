import type {FastifyInstance,FastifyRequest} from 'fastify';
import {ensure,immutable,PROFILE,StocksError,validateActor,type Actor} from '../stocks/contracts.js';
import type {StocksExecutionService} from './service.js';
export type StocksExecutionPluginOptions={service:StocksExecutionService;resolveActor?:(request:FastifyRequest)=>Promise<Actor|null>};
export async function stocksExecutionPlugin(app:FastifyInstance,options:StocksExecutionPluginOptions):Promise<void>{
 const actors=new WeakMap<FastifyRequest,Actor>();
 app.addHook('onRequest',async request=>{let actor:Actor|null=null;try{actor=await options.resolveActor?.(request)??null;}catch{/* private auth failures */}ensure(actor,'UNAUTHORIZED',401);validateActor(actor);actors.set(request,immutable(actor));});
 app.addHook('onSend',async(_request,reply)=>{reply.header('cache-control','no-store');});
 app.setErrorHandler((error,_request,reply)=>{
  if(error instanceof StocksError)return reply.code(error.status).send({error:error.code,...PROFILE});
  const status=(error as {statusCode?:number}).statusCode;
  return reply.code(status&&status>=400&&status<500?400:503).send({error:status&&status>=400&&status<500?'INVALID_EXECUTION_INPUT':'EXECUTION_UNAVAILABLE',...PROFILE});
 });
 const actor=(request:FastifyRequest)=>{const value=actors.get(request);ensure(value,'UNAUTHORIZED',401);ensure(Object.keys(request.query as object).length===0&&request.body===undefined&&request.headers['transfer-encoding']===undefined&&(request.headers['content-length']===undefined||request.headers['content-length']==='0'),'INVALID_EXECUTION_INPUT');return value;};
 const envelope=(data:unknown)=>({...PROFILE,observedAt:new Date().toISOString(),data});
 app.get('/api/v1/stocks/execution/deployment',async request=>envelope(await options.service.deployment(actor(request))));
 app.get<{Params:{side:string;orderId:string}}>('/api/v1/stocks/execution/:side/:orderId',async request=>envelope(await options.service.policy(actor(request),request.params.side,request.params.orderId)));
}
