import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { checkStocksPreflight } from '../../server/dist/stocks-preflight/checker.js';
import { createPreflightProbes } from '../../server/dist/stocks-preflight/adapters.js';

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/stocks-preflight/run.mjs [--online]\nDefault: offline configuration checks. --online: read-only DB, deployment and signer capability checks. No dotenv loading, startup, deployment, migration or signing. See docs/contracts/stocks-preflight-v1.md.');
} else if (args.length > 1 || (args.length === 1 && args[0] !== '--online')) {
    console.log(JSON.stringify({ status: 'BLOCKED', tradingAuthorized: false, error: 'INVALID_ARGUMENTS' }));
    process.exitCode = 1;
} else {
    try {
        const migrationsDir = fileURLToPath(new URL('../../prisma/migrations/', import.meta.url));
        const migrations = [];
        for (const entry of (await readdir(migrationsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isDirectory()) migrations.push({ name: entry.name, checksum: createHash('sha256').update(await readFile(resolve(migrationsDir, entry.name, 'migration.sql'))).digest('hex') });
        }
        const report = await checkStocksPreflight(process.env, {
            online: args[0] === '--online',
            readConfig: async path => {
                const target = await realpath(path);
                if (target.split('/').some(part => part.startsWith('.env') || part === '.secrets')) throw new Error('PUBLIC_CONFIG_REQUIRED');
                const info = await stat(target);
                if (!info.isFile() || info.size > 65536) throw new Error('PUBLIC_CONFIG_INVALID');
                return JSON.parse(await readFile(target, 'utf8'));
            },
            probes: prepared => createPreflightProbes(prepared, migrations),
        });
        console.log(JSON.stringify(report, null, 2));
        process.exitCode = report.status === 'STARTUP_CHECKS_PASSED' ? 0 : report.status === 'BLOCKED' ? 1 : 2;
    } catch {
        console.log(JSON.stringify({ status: 'BLOCKED', tradingAuthorized: false, error: 'PREFLIGHT_UNAVAILABLE' }));
        process.exitCode = 1;
    }
}
