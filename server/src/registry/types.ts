export type AddressValue = `0x${string}` | null

export type ContractDeployment = {
  readonly proxy: AddressValue
  readonly implementation: AddressValue
  readonly bytecodeHash: `0x${string}` | null
}

export type RegistryRoles = {
  readonly tier1DefaultAdmin: AddressValue
  readonly tier1ProxyAdminOwner: AddressValue
  readonly tier1Safe: AddressValue
  readonly tier1Timelock: AddressValue
  readonly tier2Operator: AddressValue
  readonly pauser: AddressValue
  readonly feedAdmin: AddressValue
  readonly faucetAdmin: AddressValue
}

export type RegistryAsset = {
  readonly symbol: string
  readonly name: string
  readonly decimals: number
  readonly contract: ContractDeployment
  readonly faucet: AddressValue
  readonly deploymentBlock: number | null
}

export type RegistryProduct = {
  readonly productId: string
  readonly symbol: string
  readonly name: string
  readonly paymentAssetSymbol: string
  readonly productToken: ContractDeployment
  readonly depositVault: ContractDeployment
  readonly redemptionVault: ContractDeployment
  readonly priceFeed: ContractDeployment
  readonly deploymentBlock: number | null
  readonly activationFlags: Record<string, boolean>
}

export type RegistryEvent = {
  readonly name: string
  readonly signature: string
  readonly sourceContracts: readonly string[]
  readonly inputs: readonly {
    readonly name: string
    readonly type: string
    readonly indexed: boolean
  }[]
}

export type RegistryEventMismatch = {
  readonly eventName: string
  readonly status: "extra-indexed-event" | "missing-target-event"
  readonly action: string
}

export type GiwaDeploymentRegistry = {
  readonly schemaVersion: 1
  readonly releaseId: string
  readonly gitCommit: string
  readonly chainId: 91342
  readonly network: "giwa-sepolia"
  readonly name: "GIWA Sepolia"
  readonly nativeCurrency: {
    readonly name: "Ether"
    readonly symbol: "ETH"
    readonly decimals: 18
  }
  readonly publicRpcUrl: "https://sepolia-rpc.giwa.io"
  readonly explorerBaseUrl: "https://sepolia-explorer.giwa.io"
  readonly blockscoutApiUrl: "https://sepolia-explorer.giwa.io/api"
  readonly deploymentBlock: number | null
  readonly deployer: AddressValue
  readonly evmVersion: "cancun" | "shanghai" | "prague"
  readonly proxyAdmin: ContractDeployment
  readonly roles: RegistryRoles
  readonly activationFlags: {
    readonly deployed: boolean
    readonly dryRun: boolean
    readonly frontendEnabled: boolean
    readonly indexerEnabled: boolean
    readonly onchainAttestationRequired: boolean
  }
  readonly assets: readonly RegistryAsset[]
  readonly faucet: ContractDeployment
  readonly products: readonly RegistryProduct[]
  readonly productPaymentMappings: Record<string, string>
  readonly events: {
    readonly targetEvents: readonly string[]
    readonly indexedEvents: readonly RegistryEvent[]
    readonly mismatches: readonly RegistryEventMismatch[]
  }
}

export type RegistryValidationResult = {
  readonly ok: boolean
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
  readonly eventMismatches: readonly RegistryEventMismatch[]
}
