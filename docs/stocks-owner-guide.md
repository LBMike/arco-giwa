# Stocks 직접 실행·운영·수정 안내

이 안내의 대상은 **NVDA + 테스트 현금 + 모의 브로커**입니다. 실제 주식이나 실자금 거래가 아닙니다.
운영자·투자자 화면은 제품 코드를 사용하고, 실행 도구가 별도 로컬 DB·체인·테스트 지갑을 연결합니다.

## 처음 준비하기

macOS 또는 Linux, Node22.15 이상, Corepack, PostgreSQL16 이상이 필요합니다.
PostgreSQL은 클라이언트(libpq)만으로는 부족하며 서버 프로그램도 있어야 합니다.
설치 경로는 실행 도구가 자동 확인합니다. 다른 경로라면 `STOCKS_PG_BIN`에 bin 폴더의 절대 경로를 지정하세요.
이미 실행 중인 PostgreSQL 서비스나 사용자 DB는 사용하지 않습니다.

저장소 폴더의 터미널에서:

```sh
npm run stocks:setup
npm run stocks:doctor
npm run stocks:dev
```

`setup`은 잠금 파일 기준 의존성을 설치하고 Prisma 클라이언트·계약·서버를 빌드합니다.
최초 설치에는 인터넷이 필요합니다. `doctor`는 부족한 항목과 해결 명령을 표시하며,
DB 생성이나 거래를 하지 않습니다. `dev`는 서버 코드를 다시 빌드하고 임시 서비스를 시작합니다.
준비가 끝나면 터미널에 **투자자 화면**과 **운영자 화면** 주소가 표시됩니다. 포트는 실행마다 달라집니다.
별도 브라우저 설치 자동화나 개인 지갑 확장 프로그램은 필요하지 않습니다.

실행 도구는 `.env`를 읽지 않고, 상속된 공개 DB·지갑·서명 서비스 설정도 전달하지 않습니다.
기존 `npm run dev`/`start:server`는 원래 서비스용 명령입니다. 이 테스트 환경은 `stocks:dev`를 쓰세요.

## 운영자로 거래 허용하기

1. 터미널에 표시된 운영자 화면 주소를 브라우저에서 엽니다.
2. 위쪽 로컬 제어 영역에서 **Operator (sign-in only)**를 누릅니다.
3. **Sign in to Stocks**로 로그인합니다. 로컬 테스트 계정이므로 개인 지갑 승인은 없습니다.
4. 거래 제어 영역의 사유를 입력하고 **Review resume → Confirm resume**을 누릅니다.
5. 다시 막으려면 **Review pause → Confirm pause**를 사용합니다. 변경 이력이 DB에 기록됩니다.

처음에는 중지 상태입니다. 운영자의 재개는 체인 관찰 등 다른 조건을 무시하지 않습니다.
중지 후에도 기존 전송의 조회·복구는 가능합니다. 운영자 계정의 지갑 기능은 로그인 서명에 한정됩니다.
Account B는 읽기 전용 운영자, Account A는 투자자입니다.

## 투자자로 매수·매도하기

1. **Account A**를 선택하고 터미널의 투자자 화면 주소로 이동합니다.
2. **Sign in to Stocks**로 로그인합니다. 첫 시작의 테스트 현금은2,000, NVDA 모의 가격은120입니다.
3. Stocks 탭에서 NVDA를 열고 수량을 입력합니다. **Get quote → Place buy order**를 누릅니다.
4. 주문 지갑 패널에서 상태 확인, 승인, 이체를 각각 진행합니다. 승인만으로 매수가 끝나지 않습니다.
5. 완료 후 Portfolio에서 수량을 확인합니다. 매도는 SELL을 선택해 동일한 순서로 진행합니다.

검증된 예: 2주 매수 후0.5주 매도 → 주식1.5, 투자자 현금1,820, 금고180, 에스크로0.
주문이 불확실하면 새 주문·재전송을 반복하지 말고 기존 주문과 알려진 거래 hash의 복구 화면을 사용하세요.

## 위쪽 로컬 제어 도구

| 도구 | 용도 |
| --- | --- |
| Account A / Account B / Operator | 역할 전환. 전환 후 제품 로그인을 다시 해야 합니다. |
| Restart API | API만 재시작합니다. 같은 세션의 DB·체인·주문·중지 기록은 유지합니다. |
| Pause processing / Resume processing | 시험용 worker 처리를 멈추거나 재개합니다. 제품의 운영자 중지와 별개입니다. |
| Hold next response / Release / Drop | 다음 테스트 지갑 응답을 지연·반환·유실시켜 복구를 시험합니다. 거래 자체를 취소하지 않습니다. |
| Next login: 30s JWT | 다음 투자자 로그인 한 번만 짧게 만들어 만료 복구를 시험합니다. |
| Refresh test state | 테스트 계정과 호출 수를 다시 읽습니다. |

계정 선택은 이 로컬 실행 전체가 공유하므로 처음에는 한 브라우저 탭으로 사용하세요.
제품의 장기 운영용 관리 기능과 상단 시험용 도구를 구분하세요.

## 종료·재실행과 데이터

실행한 터미널에서 **Ctrl+C**를 누릅니다. 소유한 API·화면 서버·DB·체인만 종료하고 임시 데이터를 삭제합니다.
다음 `stocks:dev`는 새 계정 상태와 초기 현금으로 시작합니다. 이것이 전체 시험 초기화 방법입니다.
API 재시작은 기록을 유지하지만, 전체 실행 종료 후에는 테스트 거래 기록을 보존하지 않습니다.
작성한 소스 코드는 저장소에 남습니다. 시작 실패 시 진단 폴더가 남을 수 있으며 경로가 출력됩니다.

운영자 변경 이력에 자동7일 삭제 기능을 추가한 것이 아닙니다. 위 삭제는 이 임시 시험 환경의 전체 종료 동작입니다.
실제 서비스 DB의 백업·보존과는 별개입니다.

## 어디를 수정하는가

| 바꾸려는 내용 | 주요 위치 |
| --- | --- |
| 투자자 화면과 표시 | `src/demo/giwa/stocks-market/`, `stocks-investor/` |
| 운영자 거래 중지/재개 화면 | `src/demo/giwa/stocks-trading-control/` |
| 지갑 연결·제출·복구 화면 | `stocks-host/`, `stocks-wallet-ui/`, `stocks-known-hash-recovery/` |
| 색상·공통 디자인 | `src/demo/theme.css` 및 기존 디자인 토큰 |
| 주문 처리·잔고·대사 | `server/src/stocks/`, `server/src/stocks-runtime/` |
| 중복 전송 방지·제출 기록 | `server/src/stocks-submissions/`, `server/src/stocks-execution/` |
| 운영자 권한·중지 이력 API | `server/src/stocks-trading-control/`, `docs/contracts/stocks-trading-control-api.md` |
| 데이터 구조 | `prisma/schema.prisma`, `prisma/migrations/` |
| 이 로컬 실행 도구 | `scripts/stocks-local/owner.mjs`, `owner-run.mjs` |

UI 파일은 수정 후 브라우저를 새로고침합니다. 자동 HMR은 끈 상태라 새로고침해야 반영됩니다.
백엔드 코드는 Ctrl+C 후 `stocks:dev`를 다시 실행합니다. 이번에는 테스트 기록도 초기화됩니다.
Claude의 제품 UI 담당 범위는 유지하며, Codex는 백엔드·실행 도구·검증을 관리합니다.

모의 가격·지원 종목을 바꾸는 것은 운영 화면의 단순 표시 수정과 다릅니다.
현재 거래 가능 종목은 NVDA 하나입니다. 새 거래 종목·가격 공급자는 계약·견적·원장·검증의
일관성을 함께 구현해야 합니다. 브라우저 표시를 바꿨다고 주문 지원이 생기지 않습니다.

## 수정 후 확인

```sh
npm run typecheck
npm run build
npm run test:security
npm run test:server
```

전체 DOM·DB·브라우저 검사는 GitHub의 Stocks integration에서 수행합니다.
`owner-workspace` 항목은 위 실제 실행 명령, 운영자 재개, 매수·매도, API 재시작과 Ctrl+C 종료를 검증합니다.
기존 디자인 토큰 위반7건은 별도 알려진 항목입니다. 새 위반을 추가하지 마세요.

## 현재 공개 서비스와의 차이

이 실행은 내 컴퓨터의 루프백 주소에만 열립니다. 공개 배포·실제 지갑·실제 증권 브로커 연결을 뜻하지 않습니다.
공개 테스트 환경에는 호스팅/DB 대상, 명확한 공개 역할 주소, 제한된 외부 서명 서비스와
실제 Stocks 배포 증거가 추가로 필요합니다. 기존 LIVE Savings/Funds 계약은 재배포 대상이 아닙니다.
