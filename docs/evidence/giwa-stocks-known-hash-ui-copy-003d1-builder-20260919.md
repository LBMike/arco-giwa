# GIWA-STOCKS-KNOWN-HASH-UI-003D-1 — builder evidence (card failure copy)

This is a builder-side fix of Codex's P3 finding KH-UI-003D-P3-01 (`docs/evidence/giwa-stocks-known-hash-ui-integration-20260919.md`), for Codex's re-review. It is not independent review, not a real wallet and not public-network trading.

| Item | Value |
| --- | --- |
| Base | `/private/tmp/arco-giwa-known-hash-ui-integration-20260919` @ `6455d4d522e7b3ccaaaeae545ec2de3181096f12`, branch `codex/giwa-known-hash-ui-integration-20260919`. Clean (0 files) at the start (`base.txt`) and at the end |
| Work clone / branch | `/private/tmp/arco-giwa-known-hash-ui-copy-20260919`, `codex/giwa-known-hash-ui-copy-20260919` (push URL disabled) |
| Evidence | `/private/tmp/arco-giwa-known-hash-ui-copy-evidence-20260919/` |
| Builder | Claude Code, `claude-opus-5` |

## Finding and fix

**Finding.** A kept hash was recorded (outcomes succeeded; the DB row is `SUBMITTED` with the original hash), and then the reconcile request was lost. The card showed `RECORDED` ("The server has recorded this … hash") and, under it, the generic failure line "…so it may or may not have recorded the hash".

**Fix.** `KnownHashRecoveryCard.tsx` `copyFor` only: the failure line now depends on the state.
- **`RECORDED` + FAILED:** "The receipt check could not be completed: the server's answer did not arrive or was an error. The {approval|deposit|escrow} hash stays recorded on the server, and this check did not open your wallet. Check the receipt again to see whether it is verified." The button stays "Check the receipt again". The store reaches `RECORDED` only from a server answer (a successful record, an inspect that showed the same hash, or a pending reconcile), so this is always true.
- **`KEPT` + FAILED:** unchanged, because the record request may or may not have reached the server: "…so it may or may not have recorded the hash. This did not open your wallet. Check again to see what the server has." The button stays "Check again".

**Kept as before:**
- the per-step never-again line;
- the tab-memory limit;
- receipt ≠ order completion;
- the button conditions;
- that the action did not open the wallet.

**Not changed:**
- capture, store and recover;
- the original gate and controller;
- the API, DB and contracts;
- Codex's drivers;
- any other copy.

003E is not part of this change.

## Tests

- **`KnownHashRecoveryCard.test.tsx`** (new test). For APPROVAL/BUY, APPROVAL/SELL, TRANSFER/BUY (deposit) and TRANSFER/SELL (escrow) × three failure codes:
  - `RECORDED` + FAILED keeps "The server has recorded this {step} hash" and has the exact receipt-check line.
  - It contains no "may or may not", "may not have it" or "not recorded".
  - It shows exactly ["Check the receipt again"], the step's never-again line and the tab-memory line.
  - `KEPT` + FAILED keeps the exact uncertainty line and ["Check again"], and never "stays recorded" or "The server has recorded".
- **`page.dom.test.tsx`** scenarios 21–22, on the real `/stocks` page with StrictMode, the real host, provider, card, recovery and gate, and the real server plugins:
  - **21, BUY approval:**
    - A lost inspect gives `KEPT` + uncertainty copy, "Check again", and 0 outcomes.
    - Then the record succeeds and the receipt check is lost before the server. The card shows `RECORDED` + the receipt-check copy, no "may or may not", and "Check the receipt again". The DB row is `SUBMITTED` + the hash, and after 500 ms still 0 reconciles reached the server (no automatic retry).
    - An explicit double-activated receipt check then verifies it: 1 outcome and 1 reconcile in total, the row `CONFIRMED` + hash, 0 wallet calls, and only the original claim.
  - **22, SELL escrow:** the lost receipt check after recording shows the same `RECORDED` copy with "escrow" wording and "Do not send this escrow again". The explicit check verifies it, with 1 TRANSFER outcome in total.

**Failure first** (`failure-first/`; the card restored from `HEAD`, then the fix restored and compared):

| Run | Before the fix | After |
| --- | --- | --- |
| Card test | 2 pass / 1 fail: the new test, at the receipt-check line of BUY APPROVAL | 3/3 |
| Page DOM | 20 pass / 3 fail: parent + 21 + 22, both at "timed out waiting for RECORDED + FAILED copy" after 21's KEPT + FAILED step had passed | 23/23 |

@@CHECKS@@

## Limits

- This is a copy change only. The existing limits in `giwa-stocks-known-hash-ui-003d-builder-20260918.md` stay:
  - no reload or cross-tab recovery;
  - a 409 conflict that races in first shows as a failure;
  - a RECORDED card is not refreshed by the panel's own reconcile;
  - the memory SQL / fake chain harness.
- Real Chrome/PostgreSQL/EVM re-verification of the new copy is Codex's; the builder did not run Codex's `known-hash-ui` driver.
- Node 22 was not verified.
