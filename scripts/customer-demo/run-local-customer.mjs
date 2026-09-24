import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { lstat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { readStocksPublicJson } from '../../server/dist/stocks-runtime/public-config.js';
import { parseStocksRuntimeConfig, configuredStocksRuntime } from '../../server/dist/stocks-runtime/runtime.js';
import { LOCAL_CUSTOMER_ADMIN, LOCAL_CUSTOMER_MANIFEST, LOCAL_CUSTOMER_RPC } from '../../server/dist/stocks-runtime/local-customer.js';
import { httpStocksRpc } from '../../server/dist/stocks-runtime/transport.js';
import { createStocksRpcPort } from '../../server/dist/stocks/rpc.js';
import { createLocalKeystoreCustody } from '../../server/dist/stocks-signer/custody-local.js';
import { httpStocksSignerRpc } from '../../server/dist/stocks-signer/http-rpc.js';
import { parseSignerHostConfig } from '../../server/dist/stocks-signer/host-config.js';
import { startStocksSignerHost } from '../../server/dist/stocks-signer/host.js';
import { runStocksBootstrap } from '../../server/dist/stocks-signer/bootstrap-faucet.js';
import { createBootstrapFileStore } from '../../server/dist/stocks-signer/bootstrap-file-store.js';
import { startServer } from '../../server/dist/index.js';
import { readLocalCustomerServerConfig, localCustomerEnvironment } from './local-environment.mjs';
import { prepareProductDatabase, prepareSignerDatabase, exclusiveJson, acquireLocalDemoLock } from './local-operations.mjs';
import { resumeInitialLocalTrading } from './local-readiness.mjs';

// User-operated TTY only. No password in argv/env, no auto migration, no seed guessing.
const base = '/Users/whdqkf88/Desktop/arco-giwa/GIWA_LOCAL_DEMO_20260924';
const keystore = '/Users/whdqkf88/Desktop/arco-giwa/packages/contracts/.secrets/giwa-deployer.json';
const customer = '0x3185f0efb95228c9e476de5c9da1d1aa8ccf76d2';
const transaction = { gas:'750000',maxFeePerGas:'1000000000',maxPriorityFeePerGas:'1000000' };
const limitStrings = { maxGas:'750000',maxFeePerGas:'1000000000',maxTotalFeeWei:'750000000000000' };
const limits = Object.fromEntries(Object.entries(limitStrings).map(([k,v])=>[k,BigInt(v)]));
const abort = new AbortController();
let stage='LOCAL_CONFIGURATION';
const hints={LOCAL_CONFIGURATION:'configure-server.command에서 Supabase 연결값을 저장하세요.',
  LOCAL_SINGLE_INSTANCE:'이미 실행 중인 로컬 데모 터미널을 확인하세요.',
  PRODUCT_DATABASE:'prepare-local.command로 데이터베이스 준비를 완료하세요.',
  SIGNER_DATABASE:'기존 정산 기록을 보존하고 저장 폴더를 확인하세요. 삭제하거나 초기화하지 마세요.',
  KEYSTORE_UNLOCK:'기존 키스토어의 비밀번호와 파일을 확인하세요. 개인키를 입력하지 마세요.',
  TEST_CASH_BOOTSTRAP:'원래 테스트 자금 거래와 저장 기록을 확인하세요. 재실행은 같은 거래만 확인하며 새로 지급하지 않습니다.',
  SIGNER_START:'정산기의 거래 순서와 기존 실행 여부를 확인하세요. 관리자 지갑으로 별도 거래를 보내지 마세요.',
  OBSERVER_RECONCILIATION:'거래 기록 동기화와 잔액 대조 또는 운영자 중지 상태를 확인하세요.',
  API_START:'로컬 API 연결 상태와 4493 포트의 기존 실행 여부를 확인하세요.'};
let cancelPrompt, signer, signerOwned=false, signerPool, custody, journal, lock, storage, warm, api, release;
const stop = () => { abort.abort(); cancelPrompt?.(); };
process.on('SIGINT',stop);process.on('SIGTERM',stop);
try {
  if (process.argv.length!==2 || !process.stdin.isTTY || !process.stdout.isTTY) throw Error('LOCAL_TTY_REQUIRED');
  if (['DEPLOYER_PRIVATE_KEY','GIWA_KEYSTORE_PASSWORD','STOCKS_SIGNER_PRIVATE_KEY','STOCKS_SIGNER_KEYSTORE_PASSWORD'].some(k=>process.env[k]!==undefined)) throw Error('SECRET_ENV_FORBIDDEN');
  const runtimePath=join(base,'runtime.json'), serverPath=join(base,'private/server.json');
  const runtimeConfig=parseStocksRuntimeConfig(await readStocksPublicJson(runtimePath),true);
  const env=localCustomerEnvironment(await readLocalCustomerServerConfig(serverPath),runtimePath);
  stage='LOCAL_SINGLE_INSTANCE';
  release=await acquireLocalDemoLock();
  stage='PRODUCT_DATABASE';console.log('저장된 서버 설정과 데이터베이스 준비 상태를 확인합니다.');
  if ((await prepareProductDatabase({serverPath,runtimePath})).status!=='DATABASE_READY') throw Error('LOCAL_DATABASE_PREPARATION_REQUIRED');
  stage='SIGNER_DATABASE';storage=await prepareSignerDatabase(join(base,'private'));
  journal=new pg.Pool({connectionString:storage.connectionString,max:4,connectionTimeoutMillis:5000,statement_timeout:10000});
  journal.on('error',stop);
  lock=await journal.connect();
  lock.on('error',stop);lock.on('end',stop);
  if (!(await lock.query("SELECT pg_try_advisory_lock(hashtext('arco-local-customer-runner-012')) AS locked")).rows[0].locked) throw Error('LOCAL_DEMO_ALREADY_RUNNING');
  const files=createBootstrapFileStore(storage.bootstrapDirectory);
  const markerPath=join(base,'private/bootstrap-started.json');
  const marker={version:1,manifestDigest:LOCAL_CUSTOMER_MANIFEST,customer,amount:'10000000000'};
  let prior=false;
  try { await lstat(markerPath); prior=true; } catch(e) { if(e.code!=='ENOENT')throw e; }
  const plan=await files.read('plan');
  if (prior!==Boolean(plan) || prior && JSON.stringify(await readLocalCustomerServerConfig(markerPath))!==JSON.stringify(marker)) throw Error('LOCAL_BOOTSTRAP_HISTORY_REVIEW_REQUIRED');
  const store={read:name=>files.read(name),create:async(name,value)=>{
    await files.create(name,value);
    // Persist after the engine's validated plan, but before it may sign.
    if(name==='plan')await exclusiveJson(markerPath,marker);
  }};
  // Reusing an existing completed journal is read-only at bootstrap, never another faucet.
  const requireContracts=createRequire(new URL('../../packages/contracts/package.json',import.meta.url));
  requireContracts('ts-node').register({project:fileURLToPath(new URL('../../packages/contracts/tsconfig.json',import.meta.url))});
  const {unlockLocalDeploymentWallet}=requireContracts('./scripts/stocks/local-keystore.ts');
  const {promptHidden}=requireContracts('./scripts/hidden-prompt.ts');
  console.log('GIWA 로컬 데모 — 테스트 지갑 0x3185…76D2');
  console.log('최초 실행은 테스트 자금 10,000 ARCO_TEST_USDC를 준비한 뒤 자동 정산기를 시작합니다.');
  stage='KEYSTORE_UNLOCK';
  const wallet=await unlockLocalDeploymentWallet(keystore,LOCAL_CUSTOMER_ADMIN,async()=>{
    if(abort.signal.aborted)throw Error('CANCELLED');
    try{const input=promptHidden('기존 관리자 키스토어 비밀번호: ');cancelPrompt=()=>process.stdin.emit('data',Buffer.from([3]));return await input;}
    finally{cancelPrompt=undefined;process.stdin.pause();}
  });
  custody=createLocalKeystoreCustody({signerAddress:LOCAL_CUSTOMER_ADMIN,fees:Object.fromEntries(Object.entries(transaction).map(([k,v])=>[k,BigInt(v)])),limits,signTransaction:wallet.signTransaction});
  if(abort.signal.aborted)throw Error('CANCELLED');
  const readRpc=httpStocksRpc(LOCAL_CUSTOMER_RPC),signRpc=httpStocksSignerRpc(LOCAL_CUSTOMER_RPC);
  const live=()=>{if(abort.signal.aborted)throw Error('CANCELLED');};
  const rpc=async(method,params)=>{live();return ['eth_getTransactionCount','eth_sendRawTransaction'].includes(method)?signRpc(method,params):readRpc(method,params);};
  const bootstrapCustody={signOriginal:async request=>{live();const signed=await custody.signOriginal(request);live();return signed;}};
  let handoff, lastHash;
  const until=Date.now()+90*60*1000;
  stage='TEST_CASH_BOOTSTRAP';
  while(!abort.signal.aborted&&Date.now()<until){
    handoff=await runStocksBootstrap({manifest:runtimeConfig.manifest,reviewedManifestDigest:LOCAL_CUSTOMER_MANIFEST,recipient:customer,amount:'10000000000',pool:journal,
      chain:createStocksRpcPort(rpc,runtimeConfig.manifest),rpc,custody:bootstrapCustody,limits,store});
    if(handoff.status==='COMPLETE')break;
    if(handoff.originalTransactionHash!==lastHash){console.log(JSON.stringify({status:'TEST_CASH_FINALITY_PENDING',originalTransactionHash:handoff.originalTransactionHash}));lastHash=handoff.originalTransactionHash;}
    console.log('원래 테스트 자금 거래의 최종 확정을 기다리고 있습니다.');
    await delay(30000,undefined,{signal:abort.signal});
  }
  if(abort.signal.aborted||handoff?.status!=='COMPLETE')throw Error('LOCAL_BOOTSTRAP_PENDING');
  console.log('테스트 자금 확정 및 정산 기록 준비 완료.');
  stage='SIGNER_START';
  const signerConfig=parseSignerHostConfig({schemaVersion:1,profile:'DEMO_TESTNET',manifest:runtimeConfig.manifest,
    reviewedManifestDigest:LOCAL_CUSTOMER_MANIFEST,reviewedInitialNonce:handoff.initialNonce,rpcUrl:LOCAL_CUSTOMER_RPC,
    listen:{host:'127.0.0.1',port:4394},custody:{type:'LOCAL_KEYSTORE',exclusiveAccountControlConfirmed:true},transaction,limits:limitStrings});
  signerPool=new pg.Pool({connectionString:storage.connectionString,max:4,connectionTimeoutMillis:5000,statement_timeout:5000});
  signerPool.on('error',stop);
  signerOwned=true;
  signer=await startStocksSignerHost({config:signerConfig,pool:signerPool,rpc:signRpc,custody,bearerToken:env.STOCKS_SIGNER_TOKEN,mode:'serve',signal:abort.signal});
  // Dedicated trusted composition; no forged browser/operator session and no new HTTP route.
  stage='OBSERVER_RECONCILIATION';warm=await configuredStocksRuntime(env,env.DATABASE_URL,true);
  await resumeInitialLocalTrading(warm,{signal:abort.signal,report:message=>console.log(message)});
  await warm.close();warm=undefined;
  for(const key of Object.keys(process.env))delete process.env[key];
  Object.assign(process.env,env);
  if(abort.signal.aborted)throw Error('CANCELLED');
  stage='API_START';api=await startServer(process.env,false,true);
  const ready=await fetch('http://127.0.0.1:4493/ready/stocks',{redirect:'error',signal:AbortSignal.timeout(10000)});
  if(ready.status!==200)throw Error('LOCAL_API_NOT_READY');
  console.log('LOCAL_CUSTOMER_API_READY — 4392 화면 연결 준비 완료. 종료하려면 Ctrl+C.');
  if(!abort.signal.aborted)await new Promise(resolve=>abort.signal.addEventListener('abort',resolve,{once:true}));
}catch{
  console.error(abort.signal.aborted?'LOCAL_DEMO_STOPPED':`LOCAL_DEMO_START_FAILED [${stage}]: ${hints[stage]}`);
  if(!abort.signal.aborted)process.exitCode=1;
}finally{
  try{
    const apps=await Promise.allSettled([api?.app.close(),warm?.close()]);
    const hosts=await Promise.allSettled([signer?.close()]);
    if([...apps,...hosts].some(r=>r.status==='rejected')){console.error('LOCAL_DEMO_DRAIN_FAILED');process.exitCode=1;}
  }
  finally{
    if(!signerOwned){await signerPool?.end();custody?.close();}
    lock?.off('error',stop);lock?.off('end',stop);lock?.release();await journal?.end();
    if(storage?.started)await storage.stop().catch(()=>{console.error('LOCAL_POSTGRES_STOP_REQUIRED');process.exitCode=1;});
    await release?.();
    process.off('SIGINT',stop);process.off('SIGTERM',stop);
  }
}
