# Stocks 백업·복원 검증 — 2026-09-20

기준: owner workspace `f873658` 이후 백엔드 검증 도구 확장.
사용자가 반복 실행할 명령은 `npm run stocks:recovery:check`다.

## 로컬 실제 결과

- 기본 Node24.14, macOS PostgreSQL18.6에서 사용자 명령으로 실행했다.
- 기존 실제 DB 테스트90개: pass90, fail0, skip0.
- 프로세스·PostgreSQL 재시작 후 주문/제출/운영자 복구 통과.
- custom archive를 새 DB에 복원한 뒤 이 리허설의 원본 DB를 제거했다.
- 22개 테이블, 1,643개 행, DB 규칙·열·시퀀스 정보 비교 통과.
- 복원 DB에서 원래 매수·매도 주문과 확정된 제출 증거를 조회했다.
- 새로운 claim을 만들지 않고, 과거 재개 요청을 재시도해도 이후 중지(version2)를 유지했다.
- `backup.created/restored/sourceRemoved/verified/archiveRemoved` 모두 true.
- DB 프로세스·PID 파일·Unix 소켓 종료 확인. 백업 archive는 삭제했다.
- 실행 도구 회귀85개: pass85, fail0, skip0.

행 수는 이 테스트 데이터의 관측값이며 서비스 용량이나 처리량 수치가 아니다.
실제 체인이나 외부 signer를 과거 DB와 재동기화한 검증도 아니다.

## 실패를 통해 확인한 사항

초기 비교에서 마이그레이션 이력 테이블을 허용 목록에 포함하지 않아 중단됐다.
검토된 `_prisma_migrations`를 포함하여 이력 누락도 복원 실패로 검출하도록 했다.

PostgreSQL18의 dump/restore가 두 CHECK 제약식의 동치 AND 괄호를 평탄화했다.
별도 최소 DB로 전후394개 규칙을 비교해 두 차이가 이 괄호뿐임을 확인했다.
PostgreSQL의 `pg_get_constraintdef(..., true)`로 비교하면 동치 표현이 일치한다.
이후 열·트리거 상태 등의 비교를 추가한588개 정의에서도 최소 재현의 차이가0이었다.
임의의 문자열 치환으로 괄호나 조건을 삭제하지 않았다.

추가 실패 검사는 dump 오류, 잘못된 archive, restore 오류, 원본 제거 실패,
내용 비교 실패와 복원 도중 SIGTERM을 포함한다. 어느 경우도 최종 복원 성공을
보고하지 않고 소유 DB 종료와 archive 정리를 수행한다.

## 범위와 증거

현재 로컬 사용자 화면은 중지하거나 초기화하지 않았다. 별도 DB만 사용했다.
원시 backup/DB/행 데이터는 커밋하거나 업로드하지 않았다.
로컬 로그와 소유권 기록은 `review-results/20260920/backup-restore-evidence/`에 있다.
Hosted Linux 결과는 해당 소스 커밋의 PR/Actions 실행에서 별도로 확인한다.

보존 기간·백업 저장소·암호화·권한·시점 복구는 공개 환경의 연결 정보에 따라
구성해야 한다. 운영 적용 전 조건은 [복원 리허설 안내](../contracts/stocks-backup-restore-rehearsal.md)에 있다.
