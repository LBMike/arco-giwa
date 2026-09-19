# Claude Code 수정 프롬프트 — GIWA-STOCKS-KNOWN-HASH-UI-003D-1

Codex가 003D UI를 실제 로컬 Chrome·PostgreSQL·EVM에 연결해 검토하면서 P3 문구 문제 한 건을 재현했습니다. UI 담당자로서 아래 범위만 수정하세요.

기준은 `/private/tmp/arco-giwa-known-hash-ui-integration-20260919`의 최종 clean HEAD입니다. 시작 시 실제 커밋을 기록하고 별도 clone/`codex/` 브랜치를 사용하세요. `CLAUDE.md`와 `docs/evidence/giwa-stocks-known-hash-ui-integration-20260919.md`를 확인하세요. push·배포·공개 RPC·실지갑·`.env`/`.secrets` 접근은 없습니다.

## 확인된 문제: RECORDED 이후 영수증 조회 실패 안내

`src/demo/giwa/stocks-known-hash-recovery/KnownHashRecoveryCard.tsx`의 `copyFor`는 `state.kind === "RECORDED"`일 때 서버가 해시를 기록했다고 말합니다. 그런데 `last.kind === "FAILED"`이면 바로 이어서 서버가 해시를 기록했을 수도, 아닐 수도 있다고 표시합니다.

실제 재현:

1. 원래 지갑 요청의 해시를 같은 탭에 보관하고 재로그인합니다.
2. 실제 **Record this hash** 버튼을 누릅니다.
3. outcomes 요청은 실제 DB에 저장되고 성공 응답까지 받습니다.
4. 다음 reconcile 요청만 네트워크에서 끊깁니다.
5. 카드 상태는 RECORDED이고 실제 DB도 SUBMITTED + 원래 hash이지만 두 문장이 모순됩니다.

증거: `/private/tmp/arco-giwa-known-hash-ui-integration-evidence-20260919/ui-accepted/known-hash-pending-desktop.png` 및 모바일 이미지. Codex의 `known-hash-ui` 검증 경로는 이 네트워크 단절과 실제 **Check the receipt again** 버튼 복구를 재현합니다. 이는 금융 상태나 재전송 결함이 아니라 상태 안내 결함입니다.

## 수정 범위와 조건

- `KnownHashRecoveryCard.tsx`와 관련 문구 테스트·필요한 문서만 수정하세요. capture/store/recover, 원래 gate/controller, API/DB/컨트랙트, Codex 테스트 드라이버는 수정하지 마세요.
- RECORDED + FAILED에서는 해시가 서버에 기록됐다는 사실을 유지하고, 영수증 확인 응답을 받지 못했거나 오류였으므로 명시적으로 다시 확인할 수 있다고 안내하세요.
- KEPT + FAILED에서는 outcomes가 서버에 도달했는지 불확실할 수 있으므로 기존의 기록 여부 불확실성을 보존하세요. 모든 FAILED를 '기록 완료'라고 바꾸면 안 됩니다.
- 지갑을 열지 않았다는 사실, 단계별 재전송 금지, 같은 탭 메모리 한계, 영수증 확인과 주문 완료의 구분, 버튼 조건은 유지하세요.
- 최소한 KEPT + FAILED와 RECORDED + FAILED를 분리한 회귀 검사를 추가하세요. 후자는 '기록됐을 수도/아닐 수도'라는 모순 문구가 없고 **Check the receipt again**이 유지되는지 검증하세요. BUY/SELL 단계 표현도 유지하세요.
- 관련 카드/복구/실제 페이지 DOM 검사, 전체 frontend/typecheck/build/security를 실행하고 정확한 pass/fail/skip과 최종 HEAD/clean 상태를 보고하세요. 기존 token 위반 7건은 늘리지 마세요.

후속 운영자 진단 UI(003E)는 별도 작업입니다. 이번 수정에 섞지 마세요. Codex가 수정본을 다시 독립 검토합니다.
