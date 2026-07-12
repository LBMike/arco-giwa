-- Direct-transfer payout settlement (admin wallet -> requester).
-- SETTLED status lives in the existing status column; these record when and with which tx.
ALTER TABLE "arco_evm"."IndexedRedemptionRequest"
  ADD COLUMN "settledAt" TIMESTAMPTZ(3),
  ADD COLUMN "settledTxHash" TEXT;
