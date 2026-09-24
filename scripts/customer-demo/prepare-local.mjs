import { dirname } from 'node:path';
import { prepareProductDatabase, prepareSignerDatabase, acquireLocalDemoLock } from './local-operations.mjs';

let release;
try {
  const [mode, serverFlag, serverPath, runtimeFlag, runtimePath] = process.argv.slice(2);
  if (process.argv.length !== 7 || !['--check','--prepare'].includes(mode)
    || serverFlag !== '--server-config' || runtimeFlag !== '--runtime-config') throw Error('ARGS');
  release=await acquireLocalDemoLock();
  const product = await prepareProductDatabase({ serverPath,runtimePath,apply:mode==='--prepare',report:row=>console.log(JSON.stringify(row)) });
  if (product.status !== 'DATABASE_READY') { console.log(JSON.stringify(product)); process.exitCode=2; }
  else {
    if (mode==='--prepare') {
      const signer = await prepareSignerDatabase(dirname(serverPath));
      if (signer.started) await signer.stop();
    }
    console.log(mode==='--prepare' ? 'LOCAL_DATABASES_PREPARED' : 'LOCAL_PRODUCT_DATABASE_CHECK_PASSED');
  }
} catch { console.error('LOCAL_DATABASE_PREPARATION_FAILED: 서버 설정과 준비 기록을 확인하세요. 비밀값은 출력하지 않았습니다.'); process.exitCode=1; }
finally { await release?.(); }
