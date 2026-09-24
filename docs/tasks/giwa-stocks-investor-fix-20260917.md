# GIWA-STOCKS-INVESTOR-FIX-001

Base: `0d07eb2c2fa5ff002c83460fd13bf542af0ea4e6`. Authorized delegated fix; no additional approval pause.

Plan before code: reproduce independent reviewer probes, then fix R1 unknown-order mutable refusal (preserve exact request/key); R2 async continuation/reentrant callback ownership guards (generation, owner and current registry attempt); R3 conservative monotonic quote deadline bounded by server expiry/observation and request transit. Preserve existing render-time fence and fixed API. Add committed regressions, run module/frontend/type/build/security/hooks and scope checks, record limits, locally commit. No shared feature/server/host/router/dependency edits, real wallets/RPC/DB, push/merge/deploy.
