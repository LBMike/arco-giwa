// Diagnostic labels only. Never return any input, URL component or raw exception.
const project='munsybkrsxrmajmbssli';
const hints=Object.freeze({
  INPUT_EMPTY:'입력이 비어 있습니다. DATABASE_URL 전체 값을 붙여넣고 Enter를 누르세요.',
  INPUT_TOO_LONG:'입력 길이가 허용 범위를 넘었습니다. 연결값 하나만 복사하세요.',
  INPUT_WRAPPED:'DATABASE_URL= 또는 바깥 따옴표를 제외한 값만 입력하세요.',
  INPUT_PASTE_CONTROL:'붙여넣기 제어 문자가 포함됐습니다. 새 터미널에서 실행 파일을 다시 실행해 주세요.',
  INPUT_CONTROL:'입력에 줄바꿈 또는 제어 문자가 포함됐습니다. 연결값 한 줄만 입력하세요.',
  PROJECT_API_URL:'프로젝트의 https 주소가 입력됐습니다. Render의 DATABASE_URL 값을 사용하세요.',
  POSTGRES_URL_REQUIRED:'postgresql:// 또는 postgres://로 시작하는 데이터베이스 연결값이 필요합니다.',
  URL_MALFORMED:'연결값 형식을 해석할 수 없습니다. Render에서 전체 값을 다시 복사하세요.',
  ENDPOINT_PROJECT:'허용된 Supabase 프로젝트의 연결 주소와 다릅니다. arco-giwa-api의 DATABASE_URL인지 확인하세요.',
  DATABASE_USER:'연결 주소의 데이터베이스 사용자 정보가 예상한 프로젝트와 다릅니다.',
  DATABASE_PASSWORD:'연결 주소에 데이터베이스 비밀번호가 없습니다. 완성된 DATABASE_URL을 복사하세요.',
  PORT_MISSING:'주소에 포트가 명시되어 있지 않습니다. 이번 도구는 :5432가 포함된 연결값을 요구합니다.',
  TRANSACTION_POOLER:'6543 포트는 허용하지 않습니다. DB 준비에는 5432 포트의 Session pooler 주소가 필요합니다.',
  DATABASE_PORT:'이번 도구는 5432 포트만 허용합니다. Session pooler 연결값을 확인하세요.',
  DATABASE_NAME:'데이터베이스 경로가 /postgres와 다릅니다.',
  URL_FRAGMENT:'연결 주소에 # 부분이 포함되어 있습니다. 전체 값을 다시 복사하고 비밀번호의 URL 인코딩을 확인하세요.',
  URL_OPTIONS:'추가 연결 옵션이 현재 로컬 정책과 맞지 않습니다. 이 오류 코드만 채팅에 알려주세요.',
  TLS_OPTION:'TLS 연결 옵션이 허용 범위와 다릅니다. 이 오류 코드만 채팅에 알려주세요.',
  URL_POLICY:'연결값이 로컬 검증을 통과하지 못했습니다. 실제 값 대신 이 오류 코드만 알려주세요.',
  CANCELLED:'실행을 중단했습니다. 입력값은 출력하지 않았습니다.',
  CONFIGURATION_EXISTS:'설정 파일이 이미 있습니다. 덮어쓰지 않았습니다. prepare-local.command를 실행하세요.',
  TTY_REQUIRED:'Mac 터미널에서 configure-server.command를 직접 실행하세요.',
  STORAGE:'설정 폴더 접근 또는 파일 저장에 실패했습니다. 이 오류 코드만 알려주세요.',
  STARTUP:'설정 도구를 시작하지 못했습니다. 이 오류 코드만 알려주세요.',
});

export function setupDiagnostic(code) {
  const safe=Object.hasOwn(hints,code)?code:'STARTUP';
  return `LOCAL_SERVER_CONFIG_SETUP_FAILED [${safe}]: ${hints[safe]}`;
}

/** Informative check only; the unchanged authoritative config validator must still run. */
export function databaseInputIssue(value) {
  if(typeof value!=='string'||!value.trim())return 'INPUT_EMPTY';
  if(value.length>4096)return 'INPUT_TOO_LONG';
  const input=value.trim();
  if(/^(?:\x1b)?\[200~/.test(input)||/(?:\x1b)?\[201~$/.test(input))return 'INPUT_PASTE_CONTROL';
  if(/[\x00-\x1f\x7f]/.test(input))return 'INPUT_CONTROL';
  if(/^DATABASE_URL\s*=/i.test(input)||/^['"`]/.test(input))return 'INPUT_WRAPPED';
  let url;
  try{url=new URL(value);}catch{return 'URL_MALFORMED';}
  if(url.protocol==='https:'||url.protocol==='http:')return 'PROJECT_API_URL';
  if(!['postgres:','postgresql:'].includes(url.protocol))return 'POSTGRES_URL_REQUIRED';
  const direct=url.hostname===`db.${project}.supabase.co`;
  const pooled=url.hostname==='aws-1-ap-southeast-2.pooler.supabase.com';
  if(!direct&&!pooled)return 'ENDPOINT_PROJECT';
  let user;
  try{user=decodeURIComponent(url.username);}catch{return 'DATABASE_USER';}
  if(user!==(direct?'postgres':`postgres.${project}`))return 'DATABASE_USER';
  if(!url.password)return 'DATABASE_PASSWORD';
  if(!url.port)return 'PORT_MISSING';
  if(url.port==='6543')return 'TRANSACTION_POOLER';
  if(url.port!=='5432')return 'DATABASE_PORT';
  if(url.pathname!=='/postgres')return 'DATABASE_NAME';
  if(url.hash)return 'URL_FRAGMENT';
  if([...url.searchParams.keys()].some(k=>k!=='sslmode'))return 'URL_OPTIONS';
  if(url.searchParams.getAll('sslmode').length>1||url.searchParams.has('sslmode')&&!['require','verify-full'].includes(url.searchParams.get('sslmode')))return 'TLS_OPTION';
  return null;
}
