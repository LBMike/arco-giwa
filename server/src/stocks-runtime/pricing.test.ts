import assert from 'node:assert/strict';
import test from 'node:test';
import { StocksError } from '../stocks/contracts.js';
import { FIXED_PRICING } from '../stocks/pricing.js';
import { stocksPricingFromEnvironment } from './pricing.js';

test('pricing defaults to the fixed mock price; live pricing needs Alpaca credentials and bounded fees', async () => {
    assert.equal(stocksPricingFromEnvironment({}), FIXED_PRICING);
    assert.equal(stocksPricingFromEnvironment({ STOCKS_PRICING: 'FIXED', STOCKS_MINT_FEE_BPS: '10' }), FIXED_PRICING);
    const invalid = (error: unknown) => error instanceof StocksError && error.code === 'STOCKS_PRICING_CONFIGURATION_INVALID';
    for (const env of [
        { STOCKS_PRICING: 'LIVE' },
        { STOCKS_PRICING: 'ALPACA_LIVE' },
        { STOCKS_PRICING: 'ALPACA_LIVE', ALPACA_API_KEY_ID: 'k' },
        { STOCKS_PRICING: 'ALPACA_LIVE', ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's', STOCKS_MINT_FEE_BPS: '1000' },
        { STOCKS_PRICING: 'ALPACA_LIVE', ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's', STOCKS_BURN_FEE_BPS: '0.1' },
    ]) assert.throws(() => stocksPricingFromEnvironment(env), invalid, JSON.stringify(Object.keys(env)));
    // No network read happens when pricing is built; a failing provider only stops quotes.
    const live = stocksPricingFromEnvironment({ STOCKS_PRICING: 'ALPACA_LIVE', ALPACA_API_KEY_ID: 'k', ALPACA_API_SECRET_KEY: 's', STOCKS_MINT_FEE_BPS: '10' }, { fetch: async () => { throw new Error('offline'); } });
    assert.deepEqual([live.mintFeeBps, live.burnFeeBps], [10n, 0n]);
    await assert.rejects(live.price(), (error: unknown) => error instanceof StocksError && error.code === 'PRICE_UNAVAILABLE');
});
