CREATE SCHEMA IF NOT EXISTS "arco_evm";

CREATE TABLE "arco_evm"."EvmNetwork" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "publicRpcUrl" TEXT,
    "explorerUrl" TEXT,
    "blockscoutApiUrl" TEXT,
    "nativeCurrency" JSONB,
    "latestRegistryId" TEXT,
    "registrySyncedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "EvmNetwork_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "arco_evm"."EvmAssetDeployment" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "decimals" INTEGER NOT NULL,
    "tokenAddress" TEXT NOT NULL,
    "faucetAddress" TEXT,
    "deploymentBlock" BIGINT,
    "registryReleaseId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "EvmAssetDeployment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "arco_evm"."EvmProductDeployment" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "productTokenAddress" TEXT NOT NULL,
    "paymentAssetSymbol" TEXT NOT NULL,
    "paymentAssetAddress" TEXT NOT NULL,
    "depositVaultAddress" TEXT NOT NULL,
    "redemptionVaultAddress" TEXT NOT NULL,
    "priceFeedAddress" TEXT NOT NULL,
    "deploymentBlock" BIGINT,
    "registryReleaseId" TEXT,
    "activationFlags" JSONB,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "EvmProductDeployment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "arco_evm"."EvmIndexedEvent" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "contractAddress" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "blockHash" TEXT NOT NULL,
    "txHash" TEXT NOT NULL,
    "logIndex" INTEGER NOT NULL,
    "eventName" TEXT NOT NULL,
    "args" JSONB NOT NULL,
    "removed" BOOLEAN NOT NULL DEFAULT false,
    "indexedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "EvmIndexedEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "arco_evm"."EvmIndexerCursor" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "fromBlock" BIGINT NOT NULL,
    "lastBlock" BIGINT NOT NULL,
    "lastBlockHash" TEXT,
    "confirmations" INTEGER NOT NULL,
    "lagBlocks" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "EvmIndexerCursor_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "arco_evm"."WalletAttestation" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "statement" TEXT,
    "signature" TEXT NOT NULL,
    "issuedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WalletAttestation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "arco_evm"."AuthNonce" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "consumedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuthNonce_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "arco_evm"."IndexedRedemptionRequest" (
    "id" TEXT NOT NULL,
    "chainId" INTEGER NOT NULL,
    "requestId" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTokenAddress" TEXT NOT NULL,
    "redemptionVaultAddress" TEXT NOT NULL,
    "sharesIn" TEXT NOT NULL,
    "lockedAssetsOut" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestedTxHash" TEXT NOT NULL,
    "requestedAtBlock" BIGINT NOT NULL,
    "fulfilledTxHash" TEXT,
    "claimedTxHash" TEXT,
    "fulfilledAt" TIMESTAMPTZ(3),
    "claimedAt" TIMESTAMPTZ(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "IndexedRedemptionRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EvmNetwork_chainId_key" ON "arco_evm"."EvmNetwork"("chainId");
CREATE UNIQUE INDEX "EvmAssetDeployment_chainId_symbol_key" ON "arco_evm"."EvmAssetDeployment"("chainId", "symbol");
CREATE UNIQUE INDEX "EvmAssetDeployment_chainId_tokenAddress_key" ON "arco_evm"."EvmAssetDeployment"("chainId", "tokenAddress");
CREATE UNIQUE INDEX "EvmProductDeployment_chainId_productId_key" ON "arco_evm"."EvmProductDeployment"("chainId", "productId");
CREATE UNIQUE INDEX "EvmProductDeployment_chainId_productTokenAddress_key" ON "arco_evm"."EvmProductDeployment"("chainId", "productTokenAddress");
CREATE UNIQUE INDEX "EvmIndexedEvent_chainId_txHash_logIndex_key" ON "arco_evm"."EvmIndexedEvent"("chainId", "txHash", "logIndex");
CREATE INDEX "EvmIndexedEvent_chainId_contractAddress_blockNumber_idx" ON "arco_evm"."EvmIndexedEvent"("chainId", "contractAddress", "blockNumber");
CREATE INDEX "EvmIndexedEvent_chainId_eventName_blockNumber_idx" ON "arco_evm"."EvmIndexedEvent"("chainId", "eventName", "blockNumber");
CREATE UNIQUE INDEX "EvmIndexerCursor_chainId_name_key" ON "arco_evm"."EvmIndexerCursor"("chainId", "name");
CREATE INDEX "WalletAttestation_walletAddress_domain_idx" ON "arco_evm"."WalletAttestation"("walletAddress", "domain");
CREATE UNIQUE INDEX "AuthNonce_nonce_key" ON "arco_evm"."AuthNonce"("nonce");
CREATE INDEX "AuthNonce_walletAddress_domain_consumedAt_expiresAt_idx" ON "arco_evm"."AuthNonce"("walletAddress", "domain", "consumedAt", "expiresAt");
CREATE UNIQUE INDEX "IndexedRedemptionRequest_chainId_redemptionVaultAddress_requestId_key" ON "arco_evm"."IndexedRedemptionRequest"("chainId", "redemptionVaultAddress", "requestId");
CREATE INDEX "IndexedRedemptionRequest_walletAddress_chainId_status_idx" ON "arco_evm"."IndexedRedemptionRequest"("walletAddress", "chainId", "status");

