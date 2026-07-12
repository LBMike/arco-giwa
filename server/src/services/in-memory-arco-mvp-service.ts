export class InMemoryArcoMvpService {
  readonly mode = "mock-only"

  assertMockMode(enabled: boolean) {
    if (!enabled) {
      throw new Error("InMemoryArcoMvpService is allowed only in tests or explicit mock mode")
    }
  }
}

