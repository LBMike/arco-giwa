import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PROFILE, StocksError, type Operator } from '../stocks/contracts.js';
import type { StocksRuntimeSnapshot } from './contracts.js';
import { runtimeStatusEnvelope } from './snapshot.js';
export type StocksRuntimeStatusPluginOptions = {
  getSnapshot: () => StocksRuntimeSnapshot;
  resolveOperator?: (request: FastifyRequest) => Promise<Operator | null>;
};
export async function stocksRuntimeStatusPlugin(app: FastifyInstance, options: StocksRuntimeStatusPluginOptions): Promise<void> {
  app.addHook('onRequest',async request=>{
    let authorized=false;
    try {
      const operator=await options.resolveOperator?.(request);
      authorized=!!operator&&typeof operator.operatorId==='string'&&operator.operatorId.trim().length>0&&operator.operatorId.length<=128&&Array.isArray(operator.permissions)&&operator.permissions.includes('stocks:read');
    }catch{/* No resolver details or credentials escape. */}
    if(!authorized)throw new StocksError('OPERATOR_FORBIDDEN',403);
    if(request.raw.url?.includes('?')||Object.keys(request.query as object).length>0||request.headers['transfer-encoding']!==undefined||(request.headers['content-length']!==undefined&&request.headers['content-length']!=='0'))throw new StocksError('INVALID_RUNTIME_STATUS_INPUT',400);
  });
  app.addHook('onSend',async(_request,reply)=>{reply.header('cache-control','no-store');});
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof StocksError&&['OPERATOR_FORBIDDEN','INVALID_RUNTIME_STATUS_INPUT'].includes(error.code))return reply.code(error.code==='OPERATOR_FORBIDDEN'?403:400).send({error:error.code,...PROFILE});
    const input=(error as {statusCode?:number}).statusCode;
    if(!(error instanceof StocksError)&&input&&input>=400&&input<500)return reply.code(400).send({error:'INVALID_RUNTIME_STATUS_INPUT',...PROFILE});
    return reply.code(503).send({error:'RUNTIME_STATUS_UNAVAILABLE',...PROFILE});
  });
  app.get('/api/v1/admin/stocks/runtime',{exposeHeadRoute:false},async request=>{
    if(request.body!==undefined)throw new StocksError('INVALID_RUNTIME_STATUS_INPUT',400);
    // The source is synchronous and read-only. It is called exactly once after authorization.
    try{return runtimeStatusEnvelope(options.getSnapshot());}catch{throw new StocksError('RUNTIME_STATUS_UNAVAILABLE',503);}
  });
}
