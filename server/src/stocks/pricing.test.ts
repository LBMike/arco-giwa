import assert from 'node:assert/strict';
import test from 'node:test';
import { StocksError } from './contracts.js';
import { buyCost, buyQuantity, FIXED_PRICE, FIXED_PRICING, formatPriceUnits, liveStocksPricing, priceUnits, sellPayout } from './pricing.js';

test('with no fees the formulas are the fixed mock price formulas', async () => {
    assert.equal(await FIXED_PRICING.price(), 120_000_000n);
    for (const quantity of [1n, 8n, 9n, 500_000_000n, 833_333_333n, 1_000_000_000n, 123_456_789_012n]) {
        assert.equal(buyCost(quantity, FIXED_PRICE, 0n), (quantity * 120000000n + 999999999n) / 1000000000n);
        assert.equal(sellPayout(quantity, FIXED_PRICE, 0n), quantity * 120000000n / 1000000000n);
    }
});

test('an exact payment buys the NVDA it covers, and that quantity never costs more than the payment', () => {
    const prices = [120_000_000n, 223_710_000n, 1n, 9_999_999_999_999n, 187_654_321n];
    const payments = [1n, 999n, 60_000_000n, 100_000_000n, 2_000_000_000n, 7n * 10n ** 18n];
    for (const fee of [0n, 10n, 999n]) for (const price of prices) for (const cash of payments) {
        const quantity = buyQuantity(cash, price, fee);
        if (quantity > 0n) assert.ok(buyCost(quantity, price, fee) <= cash, `${cash} @ ${price} fee ${fee}`);
        // One more base unit would cost more than the payment.
        assert.ok(buyCost(quantity + 1n, price, fee) > cash || quantity === 0n, `${cash} @ ${price} fee ${fee}`);
    }
    assert.equal(buyQuantity(60_000_000n, 120_000_000n, 0n), 500_000_000n);
    assert.equal(buyQuantity(60_000_000n, 223_710_000n, 0n), 268_204_371n);
    // 0.1%: 60 tUSDC pays 0.06 as the mint fee and buys 59.94 tUSDC of NVDA.
    assert.equal(buyQuantity(60_000_000n, 120_000_000n, 10n), 499_500_000n);
    assert.equal(sellPayout(500_000_000n, 120_000_000n, 10n), 59_940_000n);
});

test('a market price is read as 6-decimal tUSDC, rounded half up, within bounds', () => {
    assert.equal(priceUnits('223.71'), 223_710_000n);
    assert.equal(priceUnits('223.7100004'), 223_710_000n);
    assert.equal(priceUnits('223.7100005'), 223_710_001n);
    assert.equal(priceUnits('0.000001'), 1n);
    assert.equal(formatPriceUnits(223_710_000n), '223.710000');
    assert.equal(formatPriceUnits(1n), '0.000001');
    assert.equal(formatPriceUnits(FIXED_PRICE), '120.000000');
    for (const value of ['0', '0.0000004', '-1', '1e2', '12345678901', '', null, 223.71, ' 1'])
        assert.throws(() => priceUnits(value), (error: unknown) => error instanceof StocksError && error.code === 'PRICE_UNAVAILABLE' && error.status === 503, String(value));
});

test('live pricing uses the chart observation, and anything unusable stops the quote', async () => {
    const snapshot = (price: string | null, status: string) => ({ underlying: { price, status } });
    const fees = { mintFeeBps: 0n, burnFeeBps: 0n };
    assert.equal(await liveStocksPricing(async () => snapshot('223.71', 'AVAILABLE'), fees).price(), 223_710_000n);
    // The last observation while the market is closed is what the chart shows.
    assert.equal(await liveStocksPricing(async () => snapshot('223.71', 'STALE'), fees).price(), 223_710_000n);
    const unavailable = (error: unknown) => error instanceof StocksError && error.code === 'PRICE_UNAVAILABLE' && error.status === 503;
    for (const read of [
        async () => snapshot('223.71', 'UNAVAILABLE'),
        async () => snapshot(null, 'AVAILABLE'),
        async () => snapshot('abc', 'AVAILABLE'),
        async () => { throw new Error('ALPACA_SECRET_IN_MESSAGE'); },
        async () => null as never,
    ]) await assert.rejects(liveStocksPricing(read, fees).price(), unavailable);
    await assert.rejects(liveStocksPricing(() => new Promise(() => undefined), fees, 20).price(), unavailable);
    assert.throws(() => liveStocksPricing(async () => snapshot('1', 'AVAILABLE'), { mintFeeBps: 1_000n, burnFeeBps: 0n }), StocksError);
    const withFees = liveStocksPricing(async () => snapshot('1', 'AVAILABLE'), { mintFeeBps: 10n, burnFeeBps: 20n });
    assert.deepEqual([withFees.mintFeeBps, withFees.burnFeeBps], [10n, 20n]);
});
