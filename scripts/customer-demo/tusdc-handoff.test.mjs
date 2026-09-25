import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tusdcJournalConnection, readTusdcRunnerHandoff, requireLegacyLocalEpoch } from './tusdc-handoff.mjs';
test('a pre-deployment reservation retires v2 even before the final handoff artifact exists',async()=>{
  const missing=async()=>{throw Object.assign(Error('missing'),{code:'ENOENT'});};
  await requireLegacyLocalEpoch('/test',missing);
  for(const existing of ['/test/tusdc-handoff.json','/test/private/tusdc-deployment-started.json']){
    await assert.rejects(requireLegacyLocalEpoch('/test',async path=>path===existing?{}:missing()),/LOCAL_PRIOR_EPOCH_RETIRED/);
  }
  await assert.rejects(requireLegacyLocalEpoch('/test',async()=>{throw Object.assign(Error('INPUT_MUST_NOT_LEAK'),{code:'EACCES'});}),/^Error: LOCAL_TUSDC_HANDOFF_NOT_PREPARED$/);
});
test('new local signer database connection preserves only the exact reviewed local Unix socket identity',()=>{
  const original='postgresql://arco_signer@localhost/arco_signer_journal?host=%2Fprivate%2Ftest%2Fs';
  assert.equal(new URL(tusdcJournalConnection(original)).pathname,'/arco_signer_tusdc_025');
  for(const value of [original.replace('localhost','remote.test'),original.replace('arco_signer_journal','postgres'),
    original+'&password=INPUT_MUST_NOT_LEAK',original.replace('%2Fprivate%2Ftest%2Fs','relative'),original.replace('arco_signer@','arco_signer:INPUT_MUST_NOT_LEAK@')])
    assert.throws(()=>tusdcJournalConnection(value),/^Error: LOCAL_TUSDC_HANDOFF_NOT_PREPARED$/);
});
test('unreviewed v3 runner stops before opening artifacts or accessing any database',async()=>{
  await assert.rejects(readTusdcRunnerHandoff({runtimeManifest:{schemaVersion:3},readPublic:()=>assert.fail('must not read'),reviewedManifestDigest:null}),/LOCAL_TUSDC_HANDOFF_NOT_PREPARED/);
});
test('preparation CLI requires explicit action and the compiled reviewed v3 pin before accessing local state',()=>{
  // Never run a valid preparation command from a test, even after a real pin is installed.
  for(const args of [[],['--prepare','INPUT_MUST_NOT_LEAK'],['--unknown']]){
    const r=spawnSync(process.execPath,['scripts/customer-demo/prepare-tusdc-handoff.mjs',...args],{encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,HOME:process.env.HOME}});
    assert.equal(r.status,1);assert.match(r.stderr,/TUSDC_HANDOFF_PREPARATION_FAILED/);assert.doesNotMatch(r.stderr,/INPUT_MUST_NOT_LEAK|postgresql:|ENOTFOUND/);
  }
});
