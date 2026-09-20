# Stocks 배포 정보와 백엔드·UI 연결 설정 준비

이 도구는 검토한 배포 명세와 명시적으로 제공한 공개 설정으로 **중지 상태의 서버 설정과 UI 연결 안내**를 만듭니다. 네트워크 요청, 컨트랙트 배포, 지갑 서명, DB 변경, 서버 시작, 거래 재개는 하지 않습니다. 새 종목 생성 기능이 아니며 기존 NVDA 테스트 거래 연결을 대상으로 합니다.

## 입력

1. [배포 검증기](stocks-giwa-deployment-verification.md)가 출력한 v2 `manifest.json`. 서명 전 배포 계획이나 로컬 도구의 `{manifest, publicAccounts}` 묶음을 대신 넣지 마세요.
2. 공개 설정 JSON. 아래 항목을 모두 직접 지정합니다. 누락값·추가 필드·기본 주소는 허용하지 않습니다.

| 필드 | 내용 |
| --- | --- |
| `expectedManifestDigest` | 검토한 원래 명세의 SHA-256 `manifestDigest`. 서버의 canonical 계산 방식 사용. 새로 받은 파일에서 다시 계산한 값만으로 원래 검토를 대체하지 않습니다. |
| `contractPolicyVerified` | 검토한 테스트 계약 정책이면 `true`. 이 입력은 온라인 검증을 대신하지 않습니다. |
| `rpcUrl` | 서버용 HTTPS RPC. 브라우저 설정으로 복사하지 않습니다. |
| `publicRpcUrl` | 브라우저에 공개 가능한 HTTPS RPC를 별도 지정합니다. 비밀 키가 포함된 주소를 넣지 마세요. |
| `signerUrl` | 외부 서명 서비스의 HTTPS 원점. 루트 이외 경로는 허용하지 않습니다. |
| `apiBaseUrl` | UI가 연결할 API의 HTTPS 원점. 이 도구는 경로 접두사가 없는 배포만 지원합니다. |
| `frontendOrigins` | 허용할 UI의 HTTPS 원점 배열, 1~10개. 와일드카드·경로·중복은 불가합니다. 포트는 CORS와 SIWE 도메인에 유지합니다. |
| `operators` | 1~100개의 `{wallet, operatorId, permissions}`. 지갑과 ID는 중복되지 않아야 합니다. 모든 운영자에 `stocks:read`, 최소 한 명에 추가 `stocks:control` 권한이 필요합니다. 그 외 권한은 거절합니다. |

URL에 사용자명·비밀번호·query·fragment·공백을 허용하지 않습니다. 인증 토큰, DB 연결 문자열, 지갑 키는 이 JSON의 필드가 아닙니다. 이 도구는 `.env*` 또는 `.secrets` 경로를 읽거나 쓰지 않습니다. 두 입력 파일은 각각 최대64KiB의 UTF-8 JSON이어야 합니다.

## 실행

저장소 루트에서 서버를 빌드한 뒤, 직접 준비한 파일과 **존재하지 않는 출력 폴더**의 절대 경로를 넘깁니다.

```sh
npm run build:server
npm run stocks:integration:prepare -- --manifest /absolute/manifest.json --settings /absolute/public-settings.json --output /absolute/new-bundle
```

출력 부모 폴더는 이미 존재해야 합니다. 기존 출력 폴더/파일/링크를 덮어쓰지 않습니다. 성공 시 `PREPARED_NOT_PROBED`, `tradingAuthorized: false`, 종료 코드0을 반환합니다. 입력 또는 I/O 실패 시 비밀값·원본 오류를 출력하지 않고 고정 오류와 종료 코드1을 반환합니다.

새 폴더 권한은0700, 파일 권한은0600입니다. 파일 쓰기 도중 실패하면 부분 결과를 보존하고 실패로 종료합니다. 마지막 파일 `integration.json`이 없으면 완성된 묶음이 아닙니다. 기존 폴더를 재사용하지 말고 문제를 확인한 뒤 새 출력 폴더를 지정하세요.

## 결과와 다음 단계

- `runtime-config.json`: 기존 서버 파서가 그대로 읽는 설정입니다. `paused: true`, `operatorControls: true`를 고정합니다. 서버의 `STOCKS_CONFIG_PATH`에 이 파일의 배포된 절대 경로를 지정합니다.
- `integration.json`: 해당 파일의 SHA-256, 배포 명세 digest, UI 빌드용 공개 설정, 서버 CORS/관찰 설정, SIWE 도메인과 남은 단계를 담습니다. 자동 적용되는 배포 파일은 아닙니다. `browserEnvironment`의 세 항목만 UI 빌드에 전달하고, 서버 전용 설정 파일 전체를 UI 정적 자산에 복사하지 마세요.

UI의 `VITE_ARCO_API_BASE`, `VITE_PUBLIC_GIWA_RPC`, `VITE_GIWA_ADMIN_ADDRESSES`를 기존 빌드 환경에 적용하면 됩니다. 마지막 값은 관리자 화면의 **표시**를 위한 값이며 서버 권한을 부여하지 않습니다. 서버는 명시된 운영자 권한과 지갑 로그인으로 요청을 검증합니다. 연결 설정은 UI를 다시 빌드해야 반영됩니다. Dynamic 지갑 서비스 설정 등 기존 앱의 다른 환경 설정은 별도로 유지합니다.

`requiredServerOnlyNames`는 필요한 기존 서버 설정의 이름만 나열하며 값을 생성하지 않습니다. 배포 환경의 비밀정보 관리 방식을 사용하세요. 선택적 별도 `STOCKS_DATABASE_URL`과 기존 앱의 `DATABASE_URL` 관계는 [서버 연결 문서](stocks-giwa-runtime-activation.md)를 따릅니다.

이후 [온라인 읽기 전용 사전 검사](stocks-preflight-v1.md) → 중지 상태로 관찰 시작 → CURRENT 관찰과 원장·체인 잔고 대조 → 설정 중지 해제 검토 → 운영자 화면에서 재개 순서로 진행합니다. **운영자 화면의 재개만으로 `paused: true` 설정이 해제되지는 않습니다.** 설정 중지 변경은 기존 서버 재시작 절차가 필요합니다.

오프라인 명세 형식·digest 일치는 실제 공개망 배포를 증명하지 않습니다. 로컬 체인에서 만들어진 명세도 형식상 같을 수 있으므로, 실제 대상 RPC에서 기존 온라인 검증을 반드시 수행해야 합니다. 이 도구는 배포 증거·호스팅·서명 서비스를 만들어내거나 승인하지 않습니다.
