// Fixed, repository-owned integration suites; no caller-supplied test or DB URL.
export const postgresSuites = Object.freeze([
  'server/dist/stocks/stocks.postgres.test.js',
  'server/dist/stocks/order-recovery.postgres.test.js',
  'server/dist/stocks-execution/service.postgres.test.js',
  'server/dist/stocks-preflight/database.postgres.test.js',
  'server/dist/stocks-submissions/session-recovery.postgres.test.js',
  'server/dist/stocks-submission-diagnostics/service.postgres.test.js',
  'server/dist/stocks-trading-control/service.postgres.test.js',
  'scripts/stocks-submissions-integration/client-roundtrip.test.mjs',
]);
