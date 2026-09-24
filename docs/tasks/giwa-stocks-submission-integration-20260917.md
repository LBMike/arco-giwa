# GIWA-STOCKS-SUBMISSIONS-001

User authorized continued development on2026-09-17. Plan before implementation: add durable wallet submission journal, authenticated browser adapter, optional real app wiring, isolated PostgreSQL concurrency/recovery tests and independent review. Base market integration a50e2f9 plus reviewed wallet185fcbb/d4668ff. Contract is docs/contracts/stocks-wallet-submissions-v1.md.

Ownership: backend agent server/src/stocks-submissions/**, one new migration/schema model, dedicated test harness/docs. Browser agent src/demo/giwa/stocks-wallet-submissions/** and its docs. Root owns server app/index registration, combined tests and evidence. Reviewer uses separate fixed-source clone. Separate local clones prevent shared file edits. No changes to wallet controller, investor uncertainty rules, deployed contracts, existing data, browser wallet activation, public network or deployments. Root verifies local DB harness availability and owns isolated test coordination.

Independent contract review found historical-order admission gap. Backend ownership expanded to minimal new-order enrollment calls in service.ts/sell-service.ts and affected tests. Enrollment is atomic with a new order, never added by idempotent retry/backfill. Both stages share the physical lock. Root owns this contract amendment; API shape unchanged.
