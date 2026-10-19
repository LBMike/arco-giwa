import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// Makes a NEW wallet for the ArcoUSD queue keeper and saves it as an encrypted keystore
// (docs/operations/arcousd-keeper.md §2). Run on your own machine, in a terminal:
//
//   node scripts/arcousd/new-keeper-keystore.mjs /absolute/path/arcousd-keeper-keystore.json
//
// It asks for a password twice (hidden), writes the keystore (owner-only, never overwrites) and prints
// only the wallet ADDRESS. The private key is never shown or written anywhere else. The keeper wallet
// needs no role on any contract: send it a little GIWA Sepolia ETH for gas, and set
// ARCOUSD_KEEPER_ADDRESS to the printed address.
const output = process.argv[2];
if (process.argv.length !== 3 || !output || !isAbsolute(output) || !output.endsWith('.json')) {
  process.stderr.write('Usage: node scripts/arcousd/new-keeper-keystore.mjs /absolute/path/keystore.json\n');
  process.exit(1);
}
if (existsSync(output)) {
  process.stderr.write('That file already exists; choose another path (an existing keystore is never overwritten).\n');
  process.exit(1);
}

const requireContracts = createRequire(new URL('../../packages/contracts/package.json', import.meta.url));
requireContracts('ts-node').register({ project: fileURLToPath(new URL('../../packages/contracts/tsconfig.json', import.meta.url)) });
const { promptHidden } = requireContracts('./scripts/hidden-prompt.ts');
const { Wallet } = requireContracts('ethers');

try {
  const password = await promptHidden('New keystore password: ');
  const confirmation = await promptHidden('Confirm the password: ');
  if (password.length < 12) throw new Error('Use a password of at least 12 characters');
  if (password !== confirmation) throw new Error('The passwords do not match');
  const wallet = Wallet.createRandom();
  const encrypted = await wallet.encrypt(password);
  await writeFile(output, encrypted, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`Keeper wallet: ${wallet.address}\nKeystore saved to ${output}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Failed'}\n`);
  process.exitCode = 1;
} finally {
  process.stdin.pause(); // the hidden prompt leaves stdin flowing; let the process exit
}
