# 배포된 Stocks API와 UI 주소 연결 점검

서버를 시작한 뒤 UI에 사용할 주소가 API와 맞는지 확인하는 읽기 전용 도구입니다.
DB·RPC·서명 서비스의 배포 전 검사는 [기존 사전 검사](stocks-preflight-v1.md)를 사용합니다.

```sh
npm run build:server
npm run stocks:connection:check -- --api https://api.example --origin https://app.example
```

예시 주소를 실제 API 원점과 UI 원점으로 바꾸세요. 두 값은 HTTPS여야 하며 경로 접두사,
사용자명·비밀번호, query·fragment, 공백과 와일드카드는 허용하지 않습니다. UI의 포트도
일치해야 합니다. 명령은 `.env`를 읽지 않으며 인증 토큰이나 개인키를 받지 않습니다.
검토된 연결 묶음이 있다면 `browserEnvironment.VITE_ARCO_API_BASE`와 해당 `frontendOrigins`
항목을 사용하세요. 여러 UI 원점은 각각 확인합니다.

| 출력 항목 | 확인 내용 |
| --- | --- |
| `apiLiveness` | `/health`의 상태 코드와 정확한 API 식별 응답 |
| `stocksReadiness` | `/ready/stocks` 응답, 캐시 금지, 거래 실행 권한을 부여하지 않는 표시 |
| `browserCors` | 허용 UI의 실제 GET 응답·사전 요청, 인증 헤더 허용, `Vary: Origin`, 미허용 원점 차단 |
| `operatorAuthentication` | 익명 운영자 진단 요청이 고정된 403 응답으로 거절되는지 |

검사 결과는 `PASS`, `FAIL`, `NOT_READY`, `NOT_RUN`입니다. API 식별 확인에 실패하면 나머지
요청을 보내지 않습니다. 실제 응답 본문, URL, 인증 정보와 원본 오류는 결과에 넣지 않습니다.

| 최종 상태 / 종료 코드 | 다음 행동 |
| --- | --- |
| `CONNECTION_CHECKS_PASSED` / 0 | 해당 API와 UI 원점의 제한된 연결 검사 통과. 운영자 로그인·잔고 대조 등 다음 검증 진행 |
| `NOT_READY` / 2 | 연결·접근 제어 검사는 통과했지만 Stocks 관찰 등이 아직 준비되지 않음. 운영자 진단 확인 |
| `BLOCKED` / 1 | 실패 항목 확인. 주소, Stocks 활성화, 프록시/CORS와 API 응답을 수정한 뒤 재검사 |

최대 5개의 공개 GET/OPTIONS 요청만 보내고 리다이렉트를 따라가지 않습니다. 각 요청은 헤더·
본문 수신을 포함해 10초 이내이며 JSON 응답은 압축 해제 후 최대 4KiB입니다. 전체 정상
실행의 요청 대기 상한은 약 30초입니다. OPTIONS는 본문을 읽지 않고 취소합니다.
미허용 원점 검사는 예약된 `https://stocks-connection-probe.invalid`를 Origin 헤더로만
사용하며 그 도메인에 접속하지 않습니다. 이 원점을 UI 주소로 사용하지 마세요.

검사는 로그인, 주문 생성, 지갑 서명, 관찰 실행, 거래 재개와 설정 변경을 하지 않습니다.
모든 결과의 `tradingAuthorized`는 `false`입니다. 운영자/설정 중지는 정상 준비 상태와
양립하므로 통과가 거래 재개 허가는 아닙니다.

이 도구는 UI 배포 파일·실제 지갑 로그인·실제 브라우저 정책 전체를 검사하지 않습니다.
또한 **배포 명세·컨트랙트 주소 일치, 실시간 DB·RPC·서명 서비스 상태나 잔고 대사**를
검증하지 않습니다. 동일한 API 형식의 다른 배포를 지정해도 통과할 수 있습니다.
기존 온라인 사전 검사, 검토된 명세 확인, 실제 UI의 로그인·거래 검증을 이어서 수행하세요.
