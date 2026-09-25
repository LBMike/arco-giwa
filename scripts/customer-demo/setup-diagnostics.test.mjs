import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseInputIssue,setupDiagnostic } from './setup-diagnostics.mjs';
import { createLocalCustomerServerConfig } from './local-environment.mjs';

const valid='postgresql://postgres.munsybkrsxrmajmbssli:SYNTHETIC_VALUE_NEVER_ECHO@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres';
test('fixed categories distinguish rejected PostgreSQL inputs without echoing any input or secret',()=>{
  const cases=[['','INPUT_EMPTY'],['x'.repeat(4097),'INPUT_TOO_LONG'],['DATABASE_URL='+valid,'INPUT_WRAPPED'],['"'+valid+'"','INPUT_WRAPPED'],
    ['[200~'+valid+'[201~','INPUT_PASTE_CONTROL'],[valid+'\nextra','INPUT_CONTROL'],['https://example.supabase.co','PROJECT_API_URL'],
    ['not-a-url','URL_MALFORMED'],[valid.replace('postgresql:','ftp:'),'POSTGRES_URL_REQUIRED'],
    [valid.replace('aws-1-ap-southeast-2','foreign'),'ENDPOINT_PROJECT'],[valid.replace('postgres.munsybkrsxrmajmbssli','postgres.foreign'),'DATABASE_USER'],
    [valid.replace('SYNTHETIC_VALUE_NEVER_ECHO',''),'DATABASE_PASSWORD'],[valid.replace(':5432',''),'PORT_MISSING'],[valid.replace(':5432',':6543'),'TRANSACTION_POOLER'],
    [valid.replace(':5432',':5433'),'DATABASE_PORT'],[valid.replace(/\/postgres$/,'/different'),'DATABASE_NAME'],
    [valid+'#fragment','URL_FRAGMENT'],[valid+'?pgbouncer=true','URL_OPTIONS'],[valid+'?host=foreign.example','URL_OPTIONS'],
    [valid+'?sslmode=disable','TLS_OPTION'],[valid+'?sslmode=require&sslmode=require','TLS_OPTION']];
  for(const [input,expected] of cases){
    assert.equal(databaseInputIssue(input),expected);
    const message=setupDiagnostic(expected);
    assert.doesNotMatch(message,/SYNTHETIC_VALUE_NEVER_ECHO|aws-1-ap-southeast-2|postgres\.munsybkrsxrmajmbssli|foreign\.example/);
    assert.match(message,new RegExp('\\['+expected+'\\]'));
  }
  assert.equal(setupDiagnostic('UNTRUSTED_SENTINEL'),setupDiagnostic('STARTUP'));
});
test('valid diagnostic does not replace authoritative project, endpoint and option validation',()=>{
  for(const input of [valid,valid.replace('SYNTHETIC_VALUE_NEVER_ECHO','prefix[200~suffix'),valid+'?sslmode=verify-full',valid.replace('postgresql:','postgres:'),
    'postgresql://postgres:SYNTHETIC_VALUE_NEVER_ECHO@db.munsybkrsxrmajmbssli.supabase.co:5432/postgres']){
    assert.equal(databaseInputIssue(input),null);
    assert.equal(createLocalCustomerServerConfig(input).DATABASE_URL,input);
  }
  assert.throws(()=>createLocalCustomerServerConfig(valid+'?host=foreign.example'));
});
