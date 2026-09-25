import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, chmodSync, readFileSync, statSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('actual local TTY setup hides input, persists an exclusive0600 config and restores echo', () => {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), 'giwa-setup-tty-')); chmodSync(directory, 0o700);
  const output = join(directory, 'server.json');
  const value = 'postgresql://postgres.munsybkrsxrmajmbssli:TEST_ONLY_NOT_A_CREDENTIAL@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres?sslmode=verify-full';
  try {
    const script = `
import os, pty, select, subprocess, sys, termios, time
master, slave = pty.openpty()
initial = termios.tcgetattr(slave)
child = subprocess.Popen(sys.argv[2:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
output = b''
try:
    deadline = time.monotonic() + 15
    while b'(postgresql://...): ' not in output and time.monotonic() < deadline:
        if select.select([master], [], [], .1)[0]: output += os.read(master, 65536)
        if child.poll() is not None: break
    assert b'(postgresql://...): ' in output, 'PROMPT_NOT_REACHED'
    deadline = time.monotonic() + 1
    while termios.tcgetattr(slave)[3] & termios.ECHO and time.monotonic() < deadline: time.sleep(.01)
    assert not (termios.tcgetattr(slave)[3] & termios.ECHO), 'ECHO_ENABLED'
    os.write(master, sys.argv[1].encode() + b'\\r')
    assert child.wait(timeout=10) == 0, 'SETUP_FAILED'
    while select.select([master], [], [], .1)[0]: output += os.read(master, 65536)
    assert b'TEST_ONLY_NOT_A_CREDENTIAL' not in output, 'INPUT_WAS_ECHOED'
    assert termios.tcgetattr(slave)[3] & (termios.ECHO | termios.ICANON) == initial[3] & (termios.ECHO | termios.ICANON), 'TTY_NOT_RESTORED'
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master); os.close(slave)
print('LOCAL_SERVER_CONFIG_TTY_PASSED')
`;
    const result = spawnSync('python3', ['-c', script, value, process.execPath, 'scripts/customer-demo/setup-server.mjs', '--output', output],
      { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH } });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'LOCAL_SERVER_CONFIG_TTY_PASSED');
    assert.equal(statSync(output).mode & 0o777, 0o600);
    const config = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(config.DATABASE_URL, value); assert.equal(config.DIRECT_URL, value);
    assert.match(config.STOCKS_SIGNER_TOKEN, /^[0-9a-f]{64}$/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('hidden-TTY rejected full URLs and cancellation return fixed diagnostics without a saved file or leaked input',()=>{
  const valid='postgresql://postgres.munsybkrsxrmajmbssli:SYNTHETIC_VALUE_NEVER_ECHO@aws-1-ap-southeast-2.pooler.supabase.com:5432/postgres';
  for(const [input,code] of [[valid+'?pgbouncer=true','URL_OPTIONS'],[valid.replace(':5432',':6543'),'TRANSACTION_POOLER'],
    ['\x1b[200~'+valid+'\x1b[201~','INPUT_PASTE_CONTROL'],['\x03','CANCELLED']]){
    const directory=mkdtempSync(join(realpathSync(tmpdir()),'giwa-setup-failure-'));chmodSync(directory,0o700);
    const output=join(directory,'server.json');
    try{
      const script=`
import os, pty, select, subprocess, sys, termios, time
master, slave = pty.openpty()
initial = termios.tcgetattr(slave)
child = subprocess.Popen(sys.argv[3:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
output = b''
try:
    deadline = time.monotonic() + 15
    while b'(postgresql://...): ' not in output and time.monotonic() < deadline:
        if select.select([master], [], [], .1)[0]: output += os.read(master, 65536)
        if child.poll() is not None: break
    assert b'(postgresql://...): ' in output, 'PROMPT_NOT_REACHED'
    deadline = time.monotonic() + 1
    while termios.tcgetattr(slave)[3] & termios.ECHO and time.monotonic() < deadline: time.sleep(.01)
    assert not (termios.tcgetattr(slave)[3] & termios.ECHO), 'ECHO_ENABLED'
    os.write(master, sys.argv[1].encode() + b'\\r')
    assert child.wait(timeout=10) == 1, 'UNEXPECTED_EXIT'
    while select.select([master], [], [], .1)[0]: output += os.read(master, 65536)
    assert ('[' + sys.argv[2] + ']').encode() in output, 'DIAGNOSTIC_MISSING'
    for forbidden in [b'SYNTHETIC_VALUE_NEVER_ECHO', b'aws-1-ap-southeast-2', b'pgbouncer=true', b'postgres.munsybkrsxrmajmbssli']:
        assert forbidden not in output, 'INPUT_LEAKED'
    assert termios.tcgetattr(slave)[3] & (termios.ECHO | termios.ICANON) == initial[3] & (termios.ECHO | termios.ICANON), 'TTY_NOT_RESTORED'
finally:
    if child.poll() is None: child.kill(); child.wait()
    os.close(master); os.close(slave)
print('SAFE_SETUP_FAILURE_CONFIRMED')
`;
      const result=spawnSync('python3',['-c',script,input,code,process.execPath,'scripts/customer-demo/setup-server.mjs','--output',output],
        {encoding:'utf8',timeout:30000,env:{PATH:process.env.PATH}});
      assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
      assert.equal(result.stdout.trim(),'SAFE_SETUP_FAILURE_CONFIRMED');assert.equal(existsSync(output),false);
    }finally{rmSync(directory,{recursive:true,force:true});}
  }
});
