import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

for (const [environment, locale] of [['en_US.UTF-8','en-US'], ['cs_CZ.UTF-8','cs-CZ'], ['sk_SK.UTF-8','sk-SK']] as const) {
  test(`canonical digests preserve frozen en-US bytes under real ${locale} process locale`, t => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./canonical-locale-probe.js', import.meta.url))], {
      // Pass only runtime discovery and chosen locale; never forward DB credentials or auth tokens.
      env: {PATH:process.env.PATH, LANG:environment, LC_ALL:environment, TZ:'UTC'}, encoding:'utf8', timeout:10000,
    });
    assert.equal(child.error, undefined); assert.equal(child.signal, null);
    const result = JSON.parse(child.stdout) as {locale:string;node:string;icu:string;vectorCount:number;failures:string[]};
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.locale,locale,'the child must actually use the requested locale');
    assert.equal(result.vectorCount,13);
    assert.equal(child.status,0,`golden failures: ${result.failures.join(', ')}; ${child.stderr}`);
    assert.deepEqual(result.failures,[]);
  });
}
