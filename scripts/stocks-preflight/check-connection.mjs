const args = process.argv.slice(2);
try {
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: npm run stocks:connection:check -- --api https://api.example --origin https://app.example\nThe fixed local frontend origin http://127.0.0.1:4392 is also accepted; the API must use HTTPS.\nRead-only public GET/OPTIONS checks: API identity, Stocks readiness, browser CORS and denied anonymous operator access. No credentials, dotenv, wallet, signing or orders. Exit 0: connection checks passed; 2: connected but Stocks not ready; 1: blocked. Does not verify deployment identity or authorize trading.');
  } else {
    if (args.length !== 4 || args[0] !== '--api' || args[2] !== '--origin') throw Error('INVALID_ARGUMENTS');
    const { checkStocksConnection } = await import('../../server/dist/stocks-preflight/connection.js');
    const report = await checkStocksConnection(args[1], args[3]);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === 'CONNECTION_CHECKS_PASSED' ? 0 : report.status === 'NOT_READY' ? 2 : 1;
  }
} catch {
  console.log(JSON.stringify({ status: 'BLOCKED', tradingAuthorized: false, error: 'CONNECTION_CHECK_UNAVAILABLE' }));
  process.exitCode = 1;
}
