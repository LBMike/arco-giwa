# Claude Code 교차 검토 — GIWA Stocks

당신은 구현자와 분리된 읽기 전용 검토자다. 사용자 지시에 따라 GIWA를 먼저 완성하며 XRPL 구현은 마지막이다. 코드를 수정하거나 브랜치에 통합하지 말고, 아래 커밋의 실제 파일을 읽어 자금 경로의 결함을 검토하라. 이 검토 작업은 지휘관이 승인했으므로 계획 승인을 다시 요청하지 않는다.

- 검토 세션: `f31e1a5b-02c6-4cf2-b178-7eed71ce8160`
- 작업공간: `/private/tmp/arco-giwa-stocks-claude-review-20260916`
- Base: `8160f354b55dfe9a525565e30ddc007f51448f3d`
- 검토 Head: `a4422f66d137c650b2895eebde621f69c01beb8e`
- Stocks 구현자 Head: `2abfb9bd04aa260747500b9e8994c38bce46a297`
- DB 검사기 구현자 Head: `329a3f6c672d324cc93615393253a9b1b8ee7182`

먼저 `docs/tasks/stocks-giwa-backend-20260916.md`, `docs/contracts/stocks-giwa-v1.md`, `docs/evidence/stocks-giwa-backend-20260916.md`를 읽는다. 실제 범위는 신규 `server/src/stocks/**`, `scripts/stocks/**`, Stocks 전용 추가 Prisma 모델과 `prisma/migrations/20260916000000_stocks_testnet/migration.sql`, DB 검사기 두 파일 및 문서다. 기존 프로세스·UI·배포·컨트랙트는 변경하지 않았다.

핵심 검토:

1. actor·지갑·견적·배포 식별자 결합, 견적 만료와 재사용, 객체 접근 권한.
2. 실제 현금 Transfer 단위 중복 방지, 순서 변경, 다른 지갑 입금, 부족·초과·늦은 입금, 불명 입금 보관 및 반환.
3. PostgreSQL 잠금·멱등성·원장 불변성·잔액 보존, 외부 호출과 DB 트랜잭션의 경계.
4. durable intent → submit → UNKNOWN → 원래 요청 조회, 재시작·중복 worker·일시 중지 중 동작. 제출 결과를 모를 때 새로 제출하지 않는지.
5. RPC의 체인·checkpoint·codehash·canonical finalized 블록·원래 calldata·event·정확한 ERC20 이동 검증. 완료 전에는 보유량을 부여하지 않는지.
6. JSONB 키 순서와 digest, mutable adapter 입출력, 다른 배포의 주문·작업·잔액 노출.
7. 독립 잔액 대사와 관측 범위, 데이터가 없거나 오래됐을 때 잘못 정상으로 표시하는지.
8. 실제 DB 테스트의 의미. 구현자 보고는 PG 20/20, 단위 11/11이나 보고만으로 통과를 추정하지 말고 assertion과 실패 경계를 읽는다. 테스트가 실제로 다루지 않은 위험은 구분한다.
9. DB 검사기의 trigger TRUNCATE 이벤트 예외가 실제 위험한 TRUNCATE 문장이나 실행 문자열을 허용하는지.

이번 범위는 NVDA 한 종목, 고정 모의 가격, 명시적 모의 브로커, 비활성 테스트넷 모듈이다. 실제 Stocks 컨트랙트·서명·로그인 연결·관측기·매도·40종목·Alpaca·UI는 후속 범위다. 이 부재 자체를 버그로 처리하지 말고, 비활성 상태가 실제로 강제되는지 검토한다. 이 결과는 테스트넷 배포 승인이 아니다.

현재 작업공간 파일만 읽는다. `.env*`, `.secrets`, 인증 설정이나 키를 읽지 않는다. 형제 제품·다른 작업공간은 조사하지 않는다. 네트워크·DB·서명·배포·프로세스 실행·파일 수정은 하지 않는다.

결과는 한국어로 반환한다. 확정 문제마다 `등급 | 파일:줄 | 재현 조건 | 영향 | 최소 수정`을 적는다. 가정에 의존하면 그 가정을 밝힌다. 차단할 P0/P1이 없으면 그대로 명시하고 남은 제한을 간단히 기록한다. 마지막에는 `Unactivated-module readiness: ready / blocked / needs decision`을 적는다. 테스트를 실행하지 않았으므로 실행했다고 주장하지 않는다.
