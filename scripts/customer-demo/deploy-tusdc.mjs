import { createConnection } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createTusdcSigningSession } from './tusdc-signing-session.mjs';

export const TUSDC_DEPLOYMENT_PLAN = 'df3466afe7705a378877336fa931e804ae7f739dce0a75e901fef9fd0e8e88df';
export const TUSDC_DEPLOYMENT_MARKER = 'tusdc-deployment-started.json';
export const TUSDC_DEPLOYMENT_LIMITS = Object.freeze({ maxGas:'5000000', maxPriorityFeePerGas:'1000000',
  maxFeePerGas:'10000000', maxTotalFeeWei:'50000000000000' });
const PRIOR_DIGEST = '4327e1459e77c9a15b4b2b3e6d156a30ddd73b16dd4b45836969c23128390247';
const ADMIN = '0xfdcf58e2954988e5bf0446aaf1284a1069136f29';
const RPC = 'https://sepolia-rpc.giwa.io';
const BASE = '/Users/whdqkf88/Desktop/arco-giwa/GIWA_LOCAL_DEMO_20260924';
const KEYSTORE = '/Users/whdqkf88/Desktop/arco-giwa/packages/contracts/.secrets/giwa-deployer.json';
const WAIT_MS = 2000, MAX_WAIT_MS = 10*60*1000;
const marker = Object.freeze({schemaVersion:1,purpose:'GIWA_TUSDC_DEPLOYMENT_STARTED_025',planDigest:TUSDC_DEPLOYMENT_PLAN,
  priorManifestDigest:PRIOR_DIGEST,priorInitialNonce:'232',firstCreateNonce:'232'});
const fail = code => Error(code);
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const canonical = value => JSON.stringify(order(value));
function order(value) { return Array.isArray(value) ? value.map(order) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b,'en-US')).map(([k,v])=>[k,order(v)])) : value; }
const live = signal => { if(signal?.aborted) throw fail('TUSDC_DEPLOYMENT_STOPPED'); };
const READ_METHODS = new Set(['eth_chainId','eth_getBlockByNumber','eth_getTransactionByHash','eth_getTransactionReceipt',
  'eth_getCode','eth_getStorageAt','eth_getLogs','eth_call','eth_getTransactionCount','eth_getBalance','eth_estimateGas']);
const READ_FAILURES = new Set(['DEPLOYMENT_RPC_UNAVAILABLE','LOCAL_DEPLOYMENT_RPC_UNAVAILABLE']);

/** Retry individual reads only; never replay a signing operation or a broadcast. */
export function retryTusdcDeploymentReads(read,{signal,wait=delay,report=()=>{},minimumIntervalMs=0,now=()=>performance.now()}={}) {
  if(!Number.isSafeInteger(minimumIntervalMs)||minimumIntervalMs<0||minimumIntervalMs>1000)
    throw fail('TUSDC_RPC_READ_INTERVAL_INVALID');
  let nextReadAt=0,queue=Promise.resolve();
  return async(method,params)=>{
    if(!READ_METHODS.has(method) || !Array.isArray(params))throw fail('TUSDC_RPC_READ_REQUIRED');
    const snapshot=structuredClone(params);
    let release;const preceding=queue;queue=new Promise(resolve=>{release=resolve;});
    await preceding;
    try {
    for(let attempt=0;attempt<3;attempt++) {
      live(signal);
      const remaining=nextReadAt-now();
      if(remaining>0)await wait(remaining,undefined,{signal});
      live(signal);nextReadAt=now()+minimumIntervalMs;
      try {const value=await read(method,structuredClone(snapshot));live(signal);return value;}
      catch(error) {
        live(signal);
        if(!READ_FAILURES.has(error?.message) || attempt===2)throw error;
        const delayMs=[2000,5000][attempt];
        report({method,attempt:attempt+1,maxAttempts:3,delayMs});
        await wait(delayMs,undefined,{signal});
      }
    }
    } finally {release();}
  };
}

export function requireTusdcDeploymentInput(plan, approval) {
  const keys=['expectedPlanDigest','genesisHash',...Object.keys(TUSDC_DEPLOYMENT_LIMITS)];
  if(!plan || plan.kind!=='ARCO_GIWA_STOCKS_EXTERNAL_CASH_UNSIGNED_DEPLOYMENT_V1' || plan.planDigest!==TUSDC_DEPLOYMENT_PLAN
    || plan.input?.deployer!==ADMIN || plan.input.operator!==ADMIN || plan.input.startingNonce!=='232'
    || !Array.isArray(plan.steps) || plan.steps.length!==4 || plan.steps.some((s,i)=>s.index!==i || s.transaction.nonce!==`0x${(232+i).toString(16)}`)
    || !approval || Object.keys(approval).sort().join(',')!==keys.sort().join(',')
    || approval.expectedPlanDigest!==TUSDC_DEPLOYMENT_PLAN || !/^0x[0-9a-f]{64}$/.test(approval.genesisHash) || /^0x0{64}$/.test(approval.genesisHash)
    || Object.entries(TUSDC_DEPLOYMENT_LIMITS).some(([k,v])=>approval[k]!==v)) throw fail('TUSDC_DEPLOYMENT_INPUT_NOT_REVIEWED');
}

/** Refuse live old hosts even if an unrelated/older process omitted the shared 4396 lock. */
export async function requirePriorHostsStopped(connect=createConnection) {
  await Promise.all([4394,4493].map(port=>new Promise((accept,reject)=>{
    const socket=connect({host:'127.0.0.1',port});
    let done=false;
    const finish=error=>{if(done)return;done=true;socket.destroy();error?reject(error):accept();};
    socket.once('connect',()=>finish(fail('TUSDC_PRIOR_HOST_STILL_RUNNING')));
    socket.once('error',error=>finish(error?.code==='ECONNREFUSED'?null:fail('TUSDC_PRIOR_HOST_STATE_UNKNOWN')));
    socket.setTimeout(2000,()=>finish(fail('TUSDC_PRIOR_HOST_STATE_UNKNOWN')));
  })));
}

/** Testable sequencing; production ports below retain all real file, DB and chain guards. */
export async function runTusdcDeploymentFlow({plan,approval,ports,signal,now=Date.now,wait=delay,report=()=>{}}) {
  requireTusdcDeploymentInput(plan,approval);live(signal);
  await ports.stopped();
  const started=await ports.marker(), entries=await ports.entries();
  if(started && canonical(started)!==canonical(marker)) throw fail('TUSDC_DEPLOYMENT_MARKER_CONFLICT');
  if(!started) {
    if(entries.length) throw fail('TUSDC_DEPLOYMENT_MARKER_REQUIRED');
    await ports.unused();live(signal);
    await ports.inspect();live(signal); // exact fresh CREATE nonce/cash identity before any DB write
    await ports.pause();live(signal); // audited expected-version operator action, never auto-resumed
    const checked=await ports.predeployment();
    if(!same(checked,{priorInitialNonce:'232',firstCreateNonce:'232'})) throw fail('TUSDC_DEPLOYMENT_PRIOR_NONCE_CHANGED');
    live(signal);await ports.createMarker(marker); // durable v2 restart barrier BEFORE first signing
  }
  await ports.frozen();
  let waitingHash, waitingSince, waitingNotice;
  for(;;) {
    live(signal);await ports.stopped();await ports.frozen();live(signal);
    let state;
    try { state=await ports.inspect(); }
    catch(error) {
      if(!['LOCAL_DEPLOYMENT_ORIGINAL_NOT_INCLUDED','LOCAL_DEPLOYMENT_ORIGINAL_UNRESOLVED','LOCAL_DEPLOYMENT_RPC_UNAVAILABLE','DEPLOYMENT_RPC_UNAVAILABLE'].includes(error?.message)) throw error;
      const pending=await ports.entries();
      if(!pending.length) throw error;
      const original=pending[pending.length-1];
      if(original.planDigest!==TUSDC_DEPLOYMENT_PLAN || original.index!==pending.length-1 || original.index>3)
        throw fail('TUSDC_DEPLOYMENT_JOURNAL_CHANGED');
      if(waitingHash!==original.transactionHash){waitingHash=original.transactionHash;waitingSince=now();waitingNotice=undefined;}
      if(now()-waitingSince>=MAX_WAIT_MS) throw fail('TUSDC_ORIGINAL_INCLUSION_TIMEOUT');
      if(waitingNotice===undefined || now()-waitingNotice>=15000) {
        report({status:'WAITING_FOR_ORIGINAL',index:original.index,originalTransactionHash:original.transactionHash,
          waitedSeconds:Math.floor((now()-waitingSince)/1000)});
        waitingNotice=now();
      }
      await wait(WAIT_MS,undefined,{signal});continue;
    }
    waitingHash=undefined;waitingSince=undefined;waitingNotice=undefined;
    if(state.next===null) {
      ports.closeSigning();
      live(signal);await ports.frozen();
      // Only provisional L2 evidence. Finalized manifest and handoff stay on --finalize.
      const result=await ports.saveIncluded(state);
      report({status:'L2_INCLUDED',transactionHashes:state.entries.map(e=>e.transactionHash)});
      return result;
    }
    if(state.next.index===0) {
      const checked=await ports.predeployment(); // a prior marker with no send still needs nonce 232
      if(!same(checked,{priorInitialNonce:'232',firstCreateNonce:'232'})) throw fail('TUSDC_DEPLOYMENT_PRIOR_NONCE_CHANGED');
    }
    live(signal);report({status:'SIGN_NEXT',index:state.next.index});
    try {
      const original=await ports.send();
      report({status:'SUBMITTED_WAITING_L2',index:original.index,originalTransactionHash:original.transactionHash});
    } catch(error) {
      if(error?.message!=='LOCAL_DEPLOYMENT_BROADCAST_UNCERTAIN_USE_RECOVER') throw error;
      // The executor durably stored the original hash before the uncertain send.
      // Return to inspection. Never clear the intent, sign again, or resend it.
      report({status:'RECOVER_ORIGINAL'});
    }
  }
}

/** Read-only on chain: finality artifacts never come from the faster inclusion path. */
export async function finalizeTusdcDeployment({plan,approval,ports,signal}) {
  requireTusdcDeploymentInput(plan,approval);live(signal);
  await ports.stopped();
  if(canonical(await ports.marker())!==canonical(marker)) throw fail('TUSDC_DEPLOYMENT_MARKER_REQUIRED');
  await ports.frozen();live(signal);
  if((await ports.entries()).length!==4) throw fail('TUSDC_DEPLOYMENT_INCOMPLETE');
  const result=await ports.verifyFinalized();live(signal);
  await ports.saveFinalized(result);
  return result;
}


async function requirePriorJournalFrozen(pool, manifest) {
  const account=(await pool.query(`SELECT "networkInstance","checkpointNumber","checkpointHash",
    "initialNonce"::text AS "initialNonce","nextNonce"::text AS "nextNonce"
    FROM stocks_signer.account_nonce WHERE "chainId"=91342 AND "signerAddress"=$1`,[ADMIN])).rows[0];
  const operations=(await pool.query('SELECT COUNT(*)::text AS count FROM stocks_signer.operation WHERE "chainId"=91342 AND "signerAddress"=$1',[ADMIN])).rows[0];
  if(!account || account.networkInstance!==manifest.networkInstance || account.checkpointNumber!==manifest.checkpointNumber
    || account.checkpointHash!==manifest.checkpointHash || account.initialNonce!=='232' || account.nextNonce!=='232' || operations?.count!=='0')
    throw fail('TUSDC_PRIOR_JOURNAL_CHANGED');
}

async function requireNoPriorExposure(pool, manifest, rpc) {
  const fields=['StocksOrder','StocksSellOrder','StocksHolding','StocksFunding','StocksOutbox','StocksWalletSubmission'];
  // Fixed table names only; the old digest is always a bound value.
  const rows=await pool.query(fields.map((table,i)=>`SELECT COUNT(*)::text AS count,${i} AS slot FROM arco_evm."${table}" WHERE "deploymentDigest"=$1`).join(' UNION ALL '),[PRIOR_DIGEST]);
  if(rows.rows.length!==fields.length || rows.rows.some(row=>row.count!=='0')) throw fail('TUSDC_PRIOR_CUSTOMER_EXPOSURE');
  for(const head of ['finalized','latest']) {
    const block=await rpc('eth_getBlockByNumber',[head,false]);
    if(!block || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(block.number) || !/^0x[0-9a-f]{64}$/.test(block.hash)) throw fail('TUSDC_PRIOR_CHAIN_EXPOSURE');
    for(const [to,data] of [[manifest.stockToken,'0x18160ddd'],[manifest.cashToken,`0x70a08231${manifest.fundingVault.slice(2).padStart(64,'0')}`]]) {
      if(await rpc('eth_call',[{to,data},block.number])!=='0x'+'0'.repeat(64)) throw fail('TUSDC_PRIOR_CHAIN_EXPOSURE');
    }
    const again=await rpc('eth_getBlockByNumber',[block.number,false]);
    if(again?.hash!==block.hash || again?.number!==block.number) throw fail('TUSDC_PRIOR_CHAIN_EXPOSURE');
  }
}

async function main() {
  // No valid test invokes this branch: credentials and all signing remain in the user's own TTY.
  if(process.argv.length!==3 || !['--deploy','--finalize'].includes(process.argv[2]) || process.argv[2]==='--deploy' && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw fail('TUSDC_USER_TTY_REQUIRED');
  if(['DEPLOYER_PRIVATE_KEY','GIWA_KEYSTORE_PASSWORD','STOCKS_SIGNER_PRIVATE_KEY','STOCKS_SIGNER_KEYSTORE_PASSWORD'].some(k=>process.env[k]!==undefined))
    throw fail('TUSDC_SECRET_ENV_FORBIDDEN');
  const mode=process.argv[2];
  const abort=new AbortController();let cancelPrompt,release,storage,prior,product,lock,signingSession;
  const stop=()=>{abort.abort();cancelPrompt?.();};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  try {
    const [{default:pg},ops,env,publicConfig,contracts,handoff,control]=await Promise.all([
      import('pg'),import('./local-operations.mjs'),import('./local-environment.mjs'),
      import('../../server/dist/stocks-runtime/public-config.js'),import('../../server/dist/stocks/contracts.js'),
      import('../../server/dist/stocks-signer/external-cash-handoff.js'),import('../../server/dist/stocks-trading-control/service.js')]);
    const requireContracts=createRequire(new URL('../../packages/contracts/package.json',import.meta.url));
    requireContracts('ts-node').register({project:fileURLToPath(new URL('../../packages/contracts/tsconfig.json',import.meta.url))});
    const {filesystemStocksArtifacts}=requireContracts('./scripts/stocks/prepare-deployment.ts');
    const {verifyPreparedExternalCashDeployment}=requireContracts('./scripts/stocks/prepare-external-cash.ts');
    const {verifyExternalCashDeploymentEvidence}=requireContracts('./scripts/stocks/verify-external-cash.ts');
    const {readPublicDeploymentJson}=requireContracts('./scripts/stocks/public-deployment-json.ts');
    const {readLocalCreateIntents}=requireContracts('./scripts/stocks/local-journal.ts');
    const {inspectIncludedExternalCashDeployment,sendNextIncludedExternalCashDeployment}=requireContracts('./scripts/stocks/local-executor.ts');
    const {localDeploymentRpc}=requireContracts('./scripts/stocks/local-transport.ts');
    const {unlockLocalDeploymentWallet}=requireContracts('./scripts/stocks/local-keystore.ts');
    const {promptHidden}=requireContracts('./scripts/hidden-prompt.ts');
    const directory=join(BASE,'tusdc-deployment'), privateDirectory=join(BASE,'private');
    const artifacts=filesystemStocksArtifacts(fileURLToPath(new URL('../../packages/contracts/artifacts/stocks',import.meta.url)));
    const plan=contracts.immutable(await verifyPreparedExternalCashDeployment(await readPublicDeploymentJson(join(directory,'unsigned-plan.json')),artifacts));
    const approval=contracts.immutable(await readPublicDeploymentJson(join(directory,'approval.json')));
    requireTusdcDeploymentInput(plan,approval);
    // Read only the explicitly saved prior manifest. Never replace the active runtime here.
    const runtime=await publicConfig.readStocksPublicJson(join(BASE,'runtime.json'));
    const manifest=contracts.freezeManifest(runtime.manifest);
    if(manifest.schemaVersion!==2 || contracts.manifestDigest(manifest)!==PRIOR_DIGEST || manifest.signerAddress!==ADMIN)
      throw fail('TUSDC_PRIOR_RUNTIME_CHANGED');
    release=await ops.acquireLocalDemoLock();await requirePriorHostsStopped();live(abort.signal);
    await ops.ownedPrivateDirectory(privateDirectory);
    // Refuse any initialization path: this operation requires the already provisioned old journal.
    for(const file of ['provisioned.json','data/PG_VERSION']) {
      const info=await lstat(join(privateDirectory,'signer-postgres',file));
      if(!info.isFile() || info.isSymbolicLink()) throw fail('TUSDC_PRIOR_JOURNAL_REQUIRED');
    }
    const server=await env.readLocalCustomerServerConfig(join(privateDirectory,'server.json'));
    const checkedEnv=env.localCustomerEnvironment(server,join(BASE,'runtime.json'));
    storage=await ops.prepareSignerDatabase(privateDirectory);
    const pool=connectionString=>{const result=new pg.Pool({connectionString,max:3,connectionTimeoutMillis:5000,statement_timeout:10000,query_timeout:12000});result.on('error',stop);return result;};
    prior=pool(storage.connectionString);product=pool(checkedEnv.DATABASE_URL);
    lock=await prior.connect();lock.on('error',stop);lock.on('end',stop);
    if(!(await lock.query("SELECT pg_try_advisory_lock(hashtext('arco-local-customer-runner-012')) AS locked")).rows[0]?.locked)
      throw fail('TUSDC_PRIOR_HOST_STILL_RUNNING');
    const journal=join(privateDirectory,'tusdc-deployment-journal');
    await ops.ownedPrivateDirectory(journal,true);await ops.ownedPrivateDirectory(directory);
    const readRpc=retryTusdcDeploymentReads(localDeploymentRpc(RPC,false),{signal:abort.signal,minimumIntervalMs:500,report:event=>{
      console.log(`GIWA 조회가 지연되거나 요청이 제한되어 ${event.delayMs/1000}초 후 다시 확인합니다 (${event.attempt}/2). 서명·거래 전송은 반복하지 않습니다.`);
    }}), sendRpc=localDeploymentRpc(RPC,true);
    const requireUnused=async()=>{live(abort.signal);await requirePriorJournalFrozen(prior,manifest);await requireNoPriorExposure(product,manifest,readRpc);live(abort.signal);};
    const requireFrozen=async()=>{await requireUnused();await handoff.requireEmptyPriorStocksEpoch(product,PRIOR_DIGEST);};
    const rpc=async(method,params)=>{
      live(abort.signal);
      if(method==='eth_sendRawTransaction'){await requirePriorHostsStopped();await requireFrozen();live(abort.signal);return sendRpc(method,params);}
      return readRpc(method,params);
    };
    const context={plan,approval,expectedDeployer:ADMIN,artifacts,rpc,journal};
    const markerPath=join(privateDirectory,TUSDC_DEPLOYMENT_MARKER);
    const readOptional=async file=>{try{const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink())throw fail('TUSDC_PUBLIC_ARTIFACT_INVALID');return await readPublicDeploymentJson(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
    const save=async(file,value)=>{const old=await readOptional(file);if(old){if(canonical(old)!==canonical(value))throw fail('TUSDC_PUBLIC_ARTIFACT_CONFLICT');}else await ops.exclusiveJson(file,value);};
    console.log(mode==='--deploy'?'GIWA tUSDC Stocks 연속 배포 — 이미 배포한 계약은 건너뛰고 남은 계약을 진행합니다.':'GIWA tUSDC Stocks 최종 확정 증거 확인 — 서명·전송 없음');
    console.log('기존 거래가 없는지 확인한 뒤 Stocks를 중지 상태로 유지합니다. 기존 계약과 정산 기록은 보존됩니다.');
    signingSession=createTusdcSigningSession({transactions:plan.steps.map(step=>step.transaction),expectedSigner:ADMIN,limits:TUSDC_DEPLOYMENT_LIMITS,signal:abort.signal,unlock:async()=>{
      live(abort.signal);
      return unlockLocalDeploymentWallet(KEYSTORE,ADMIN,async()=>{
        try {const value=promptHidden('기존 관리자 키스토어 비밀번호 (이번 실행에서 한 번): ');cancelPrompt=()=>process.stdin.emit('data',Buffer.from([3]));return await value;}
        finally{cancelPrompt=undefined;process.stdin.pause();}
      });
    }});
    const ports={
      stopped:requirePriorHostsStopped,entries:()=>readLocalCreateIntents(journal),marker:()=>readOptional(markerPath),
      unused:requireUnused,frozen:requireFrozen,inspect:()=>inspectIncludedExternalCashDeployment(context),createMarker:value=>ops.exclusiveJson(markerPath,value),
      pause:async()=>{
        await requireUnused();const service=new control.StocksTradingControlService(product,PRIOR_DIGEST),state=await service.read();
        if(!state.paused || state.version===0)await service.change({operatorId:'local-tusdc-deployment-025',permissions:['stocks:control']},
          {paused:true,expectedVersion:state.version,idempotencyKey:'tusdc-025-pause-before-four-create',reason:'Unused Stocks epoch paused for reviewed tUSDC deployment; prior contracts and journals preserved.'});
      },
      predeployment:()=>handoff.verifyExternalCashPredeployment({priorManifest:manifest,reviewedPriorManifestDigest:PRIOR_DIGEST,firstCreateNonce:'232',
        priorJournal:prior,rpc:readRpc,requirePriorEpoch:()=>handoff.requireEmptyPriorStocksEpoch(product,PRIOR_DIGEST)}),
      send:()=>sendNextIncludedExternalCashDeployment(context,async tx=>{
        live(abort.signal);await requireFrozen();
        const signed=await signingSession.sign(tx);await requireFrozen();live(abort.signal);return signed;
      }),
      closeSigning:()=>signingSession.close(),
      saveIncluded:async state=>{
        if(state.next!==null || state.entries.length!==4) throw fail('TUSDC_DEPLOYMENT_INCOMPLETE');
        const transactionHashes=state.entries.map(entry=>entry.transactionHash);
        const evidence={schemaVersion:1,purpose:'GIWA_TUSDC_L2_INCLUDED_026',confirmationPolicy:'L2_INCLUDED',
          planDigest:TUSDC_DEPLOYMENT_PLAN,transactionHashes,
          contracts:plan.steps.map(step=>({nonce:BigInt(step.transaction.nonce).toString(),address:step.predictedAddress,runtimeCodeHash:step.expectedRuntimeCodeHash}))};
        await save(join(directory,'l2-included.json'),evidence);
        await save(join(directory,'creation-evidence.json'),{plan,expectedPlanDigest:TUSDC_DEPLOYMENT_PLAN,transactionHashes});
        return evidence;
      },
      verifyFinalized:async()=>verifyExternalCashDeploymentEvidence({plan,expectedPlanDigest:TUSDC_DEPLOYMENT_PLAN,transactionHashes:(await readLocalCreateIntents(journal)).map(e=>e.transactionHash)},artifacts,readRpc),
      saveFinalized:async result=>{
        const entries=await readLocalCreateIntents(journal), nextDigest=contracts.manifestDigest(result.manifest);
        const publicHandoff={schemaVersion:1,purpose:'GIWA_TUSDC_SIGNER_HANDOFF_025',priorManifest:manifest,manifest:result.manifest,
          reviewedPriorManifestDigest:PRIOR_DIGEST,reviewedManifestDigest:nextDigest,reviewedPriorInitialNonce:'232',reviewedFirstCreateNonce:'232',
          creations:entries.map((entry,i)=>({contract:['fundingVault','mintController','stockToken','redemptionEscrow'][i],nonce:entry.nonce,inputHash:plan.steps[i].initCodeHash,transactionHash:entry.transactionHash}))};
        handoff.parseExternalCashHandoffPlan(publicHandoff,{priorManifestDigest:PRIOR_DIGEST,manifestDigest:nextDigest});
        await save(join(directory,'manifest-v3.json'),result.manifest);
        await save(join(directory,'creation-evidence.json'),{plan,expectedPlanDigest:TUSDC_DEPLOYMENT_PLAN,transactionHashes:entries.map(e=>e.transactionHash)});
        // BASE may have ordinary directory permissions; public handoff output still uses the reviewed safe JSON writer.
        const {writePublicDeploymentJson}=requireContracts('./scripts/stocks/public-deployment-json.ts');
        const old=await readOptional(join(BASE,'tusdc-handoff.json'));
        if(old){if(canonical(old)!==canonical(publicHandoff))throw fail('TUSDC_PUBLIC_ARTIFACT_CONFLICT');}
        else await writePublicDeploymentJson(join(BASE,'tusdc-handoff.json'),publicHandoff);
      },
    };
    if(mode==='--finalize') {
      await finalizeTusdcDeployment({plan,approval,ports,signal:abort.signal});
      console.log('TUSDC_DEPLOYMENT_VERIFIED — 최종 확정 증거 저장 완료. 거래 활성화는 후속 환경 반영이 필요합니다.');
      return;
    }
    await runTusdcDeploymentFlow({plan,approval,signal:abort.signal,ports,report:event=>{
      if(event.status==='SIGN_NEXT')console.log(`계약 ${event.index+1}/4 서명 및 전송`);
      else if(event.status==='WAITING_FOR_ORIGINAL')console.log(`원래 거래 ${event.originalTransactionHash} GIWA 블록 포함 확인 중: ${event.waitedSeconds}초 / 최대 10분. 재전송하지 않습니다.`);
      else if(event.status==='SUBMITTED_WAITING_L2')console.log(`전송 완료: ${event.originalTransactionHash} — GIWA 블록 포함을 확인합니다.`);
      else if(event.status==='RECOVER_ORIGINAL')console.log('전송 응답을 확인하지 못했습니다. 저장된 원래 거래를 복구합니다.');
      else console.log(JSON.stringify(event));
    }});
    console.log('TUSDC_DEPLOYMENT_L2_INCLUDED — 네 계약의 GIWA 블록 포함과 성공을 확인했습니다. 이번 배포 실행은 여기서 완료됩니다.');
    console.log('최종 확정이나 거래 활성화를 뜻하지 않습니다. 기존 실행 환경은 유지했습니다.');
  } finally {
    signingSession?.close();
    lock?.off('error',stop);lock?.off('end',stop);lock?.release();
    await Promise.allSettled([prior?.end(),product?.end()]);
    try{if(storage?.started)await storage.stop();}finally{await release?.();process.off('SIGINT',stop);process.off('SIGTERM',stop);}
  }
}

export function tusdcDeploymentFailure(error) {
  const code=error?.code==='EADDRINUSE'?'TUSDC_PRIOR_HOST_STILL_RUNNING':error?.name==='AbortError'?'TUSDC_DEPLOYMENT_STOPPED'
    :['DEPLOYMENT_RPC_UNAVAILABLE','DEPLOYMENT_RPC_RESPONSE_INVALID'].includes(error?.message)?error.message
    :/^(?:TUSDC|LOCAL_DEPLOYMENT)_[A-Z_]+$/.test(error?.message)?error.message:'TUSDC_DEPLOYMENT_FAILED';
  const hint=code==='TUSDC_PRIOR_HOST_STILL_RUNNING'
    ?'기존 start-local-demo 실행 터미널에서 Ctrl+C로 종료한 뒤 다시 실행하세요. 실행 중인 서버를 자동 종료하지 않았습니다.'
    :code==='TUSDC_USER_TTY_REQUIRED'?'사용자 로컬 터미널에서 승인된 deploy-tusdc 명령을 실행하세요.'
    :READ_FAILURES.has(code)?'GIWA 조회 서버의 응답을 확인하지 못했습니다. 계약 변경이 확인된 것은 아닙니다. 기존 거래 기록은 보존했습니다.'
    :code==='DEPLOYMENT_RPC_RESPONSE_INVALID'?'GIWA 조회 응답을 검증하지 못해 중단했습니다. 기존 거래 기록은 보존했습니다.'
    :code==='LOCAL_DEPLOYMENT_EXTERNAL_CASH_CHANGED'?'tUSDC 계약 또는 기준 블록의 일치 여부를 검증하지 못해 중단했습니다. 기존 기록을 보존했으며 원인 확인이 필요합니다.'
    :'기존 기록을 보존했습니다. 같은 명령으로 원래 거래를 확인하세요.';
  return `${code} — ${hint}`;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
  console.error(tusdcDeploymentFailure(error));process.exitCode=1;
});
