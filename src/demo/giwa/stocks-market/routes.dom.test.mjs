// Actual production route objects + pages + common host; explicit offline transports only.
// GIWA_MARKET_DOM_RUNTIME=/absolute/jsdom/package.json node --import tsx --test this-file
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {JSDOM}=createRequire(process.env.GIWA_MARKET_DOM_RUNTIME)('jsdom');
const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'https://fixture.invalid',pretendToBeVisual:true});
for(const [key,value] of Object.entries({window:dom.window,document:dom.window.document,navigator:dom.window.navigator,HTMLElement:dom.window.HTMLElement,SVGElement:dom.window.SVGElement,IS_REACT_ACT_ENVIRONMENT:true,ResizeObserver:class{observe(){} unobserve(){} disconnect(){}}}))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
const {act,createElement:h,useLayoutEffect,StrictMode}=require('react');
const {createRoot}=require('react-dom/client');
const {createMemoryRouter,RouterProvider,Outlet}=await import('react-router-dom');
const {parseSiweMessage}=require('viem/siwe');
const {stocksRoutes}=await import('./routes.tsx');
const {StocksPageEnvironment}=await import('./StocksPages.tsx');
const {StocksHostProvider}=await import('../stocks-host/StocksHostProvider.tsx');
const {fixtureMarketFetch,fixtureEnvelope,fixtureChart,fixtureProfile}=await import('./fixtures.ts');
const {createFakeStocksServer}=await import('../stocks-investor/fixtures/fake-stocks-server.ts');
const {createFixtureTransport,fixtureRoute,FIXTURE_IDS}=await import('../stocks-admin/fixtures.ts');
const A='0x1111111111111111111111111111111111111111',B='0x2222222222222222222222222222222222222222';
const container=document.getElementById('root');
async function flush(){for(let i=0;i<15;i++)await new Promise(resolve=>setImmediate(resolve))}
async function mount({path='/stocks',mode='keyless',apiBase='https://api.fixture',adminAllowed=false,intercept,initialAddress=A,chainId=91342,walletSource=null,signMessage=async()=>`0x${'11'.repeat(65)}`}={}){
 const server=createFakeStocksServer();const market=fixtureMarketFetch(mode,mode==='keyless'?['NVDA']:['NVDA','AAPL']);
 const admin=createFixtureTransport(fixtureRoute(adminAllowed?{}:{access:'forbidden'}));const tokens=new Map();const calls=[];
 let now=Date.now();let authCount=0;let firstCommit=null;
 const fetch=async(url,init)=>{calls.push({url,init});if(intercept){const r=intercept(url,init);if(r)return r}if(url.includes('/stocks/market/'))return market(url,init);if(url.includes('/admin/stocks/')){const r=await admin.fetch(url,init);return new Response(await r.text(),{status:r.status})}const headers=new Headers(init.headers);const token=headers.get('authorization')?.slice(7);if(token&&tokens.has(token))headers.set('authorization',`Bearer ${tokens.get(token)}`);return server.fetch(url,{...init,headers})};
 const dependencies={now:()=>now,signMessage,fetch:async(url,init)=>{
  authCount++;const body=JSON.parse(init.body);if(url.endsWith('/nonce'))return Response.json({walletAddress:body.walletAddress,domain:body.domain,nonce:'abcdefgh12345678',expiresAt:new Date(now+60000).toISOString()});
  const message=parseSiweMessage(body.message);const token=`e30.${Buffer.from(JSON.stringify({sub:message.address,domain:message.domain,chainId:91342,iat:Math.floor(now/1000),exp:Math.floor(now/1000)+900})).toString('base64url')}.fixture`;tokens.set(token,server.controls.issueToken(message.address));return Response.json({walletAddress:message.address,chainId:91342,expiresIn:900,token});
 }};
 const root=createRoot(container);const router=createMemoryRouter(stocksRoutes(h(Outlet)),{initialEntries:[path]});
 function Capture({address,observe}){useLayoutEffect(()=>{if(observe)firstCommit=container.textContent},[address,observe]);return h(StocksHostProvider,{context:{walletAddress:address,chainId,frontendOrigin:'https://fixture.invalid',apiBase:apiBase??'https://api.fixture'},dependencies,walletSource},h(StocksPageEnvironment.Provider,{value:{apiBase,fetch}},h(RouterProvider,{router})))}
 const render=async(address=A,observe=false)=>{await act(async()=>{root.render(h(StrictMode,null,h(Capture,{address,observe})));await flush()})};await render(initialAddress);
 return {calls,router,server,render,async setApi(value){apiBase=value;await render()},get firstCommit(){return firstCommit},get authCount(){return authCount},async login(){await act(async()=>{[...container.querySelectorAll('button')].find(b=>b.textContent==='Sign in to Stocks').click();await flush()})},async close(){await act(async()=>root.unmount());router.dispose()},text:()=>container.textContent};
}
test('real /stocks keyless route lists NVDA and separates display from fixed mock trading; no auto sign-in',async()=>{const m=await mount();try{assert.match(m.text(),/시세 연결 준비 중/);assert.match(m.text(),/파일럿 목록/);assert.match(m.text(),/고정 모의 가격 120/);assert.match(m.text(),/Not signed in/);assert.equal(m.authCount,0);assert.equal(m.calls.some(c=>c.init.method==='POST'),false);assert.equal(container.querySelector('iframe'),null)}finally{await m.close()}});
test('real route no-client state is explicit and makes no API calls',async()=>{const m=await mount({apiBase:null});try{assert.match(m.text(),/시장정보 API 연결 준비 중/);assert.equal(m.calls.length,0)}finally{await m.close()}});
test('admin without an API base still has one page h1 and makes no API calls',async()=>{const m=await mount({path:'/admin/stocks',apiBase:null});try{const h1=[...container.querySelectorAll('h1')].map(e=>e.textContent);assert.deepEqual(h1,['Stocks operations']);assert.match(m.text(),/Stocks 관리자 API 연결 준비 중/);assert.equal(m.calls.length,0)}finally{await m.close()}});
test('Stocks admin is a sibling route using common session and server403, not a browser allowlist',async()=>{const m=await mount({path:'/admin/stocks'});try{assert.match(m.text(),/Operator session required/);await m.login();assert.match(m.text(),/No Stocks read permission/);assert.equal(m.authCount,2);assert.ok(m.calls.some(c=>c.url.includes('/admin/stocks/')&&new Headers(c.init.headers).has('authorization')));assert.doesNotMatch(m.text(),/Operator token/)}finally{await m.close()}});
test('navigation retains one host login and a new-account first commit hides admin order data',async()=>{const m=await mount({adminAllowed:true});try{await m.login();assert.match(m.text(),/Signed in to Stocks/);await act(async()=>{await m.router.navigate('/admin/stocks');await flush()});assert.match(m.text(),new RegExp(FIXTURE_IDS.buyFinality));assert.equal(m.authCount,2);await m.render(B,true);assert.doesNotMatch(m.firstCommit,new RegExp(FIXTURE_IDS.buyFinality));assert.match(m.text(),/Operator session required/);await act(async()=>{await m.router.navigate('/stocks');await flush()});assert.match(m.text(),/Not signed in/);assert.equal(m.authCount,2)}finally{await m.close()}});
for(const mode of ['stale','partial','empty','one'])test(`actual Stocks route renders ${mode} market history`,async()=>{const m=await mount({mode});try{assert.match(m.text(),new RegExp(mode==='stale'?'마지막 확인 시세 · 오래된 데이터':mode==='partial'?'일부 이력만 반환됨':mode==='empty'?'반환된 차트 관측값이 없습니다':'관측값 1개'));assert.match(m.text(),/시세 지연 정보 미확인/)}finally{await m.close()}});
test('symbol/range switching ignores late previous response and never changes NVDA order identity',async()=>{const held=[];const m=await mount({mode:'ready',intercept:(url,init)=>{if(url.includes('/AAPL/chart'))return new Promise(resolve=>held.push({url,init,resolve}));return null}});try{
 // The vertical symbol list became the Stocks & ETFs table; its row button selects through ?symbol=.
 await act(async()=>{container.querySelector('[role="table"][aria-label="Stocks & ETFs"] button[data-symbol="AAPL"]').click();await flush()});assert.equal(m.router.state.location.search,'?symbol=AAPL');
 await act(async()=>{[...container.querySelectorAll('[aria-label="차트 기간"] button')].find(b=>b.textContent==='1W').click();await flush()});
 const newest=held.findLast(item=>item.url.endsWith("range=1W"));const old=held.findLast(item=>item.url.endsWith("range=1D"));assert.ok(newest&&old);assert.equal(old.init.signal.aborted,true);
 await act(async()=>{newest.resolve(Response.json(fixtureEnvelope(fixtureChart('AAPL','1W'))));await flush()});assert.match(m.text(),/1W · 1h/);
 await act(async()=>{old.resolve(Response.json(fixtureEnvelope(fixtureChart('AAPL','1D'))));await flush()});assert.match(m.text(),/1W · 1h/);assert.doesNotMatch(m.text(),/최근 24시간/);assert.match(m.text(),/AAPL은 시장정보 조회만 지원/);assert.match(m.text(),/NVDA · 테스트넷 모의 거래/);
}finally{for(const item of held)item.resolve(new Response('{}',{status:401}));await m.close()}});
test('stale company information has its own status and timestamp alongside fresh quotes',async()=>{const m=await mount({mode:'ready',intercept:url=>url.endsWith('/profile')?Promise.resolve(Response.json(fixtureEnvelope(fixtureProfile('NVDA'),'STALE'))):null});try{const status=container.querySelector('[aria-label="기업정보 상태"]').textContent;assert.match(status,/오래된 데이터/);assert.match(status,/기업정보 최근 수집/);assert.match(status,/공급자 기준일: 미확인/);assert.match(status,/시세 관측 시각과 별개/)}finally{await m.close()}});
test('API switch retires late401 from old market reads without invalidating the new login',async()=>{
 const held=[];const m=await mount({mode:'ready',intercept:(url,init)=>url.startsWith('https://api.fixture/')&&url.includes('/NVDA/chart')?new Promise(resolve=>held.push({resolve,init})):null});
 try{await m.setApi('https://api-b.fixture');await m.login();assert.match(m.text(),/Signed in to Stocks/);assert.match(m.text(),/최근 24시간/);assert.ok(held.every(item=>item.init.signal.aborted));await act(async()=>{for(const item of held)item.resolve(new Response('{}',{status:401}));await flush()});assert.match(m.text(),/Signed in to Stocks/);assert.match(m.text(),/최근 24시간/)}finally{await m.close()}
});
test('market HTTP errors stay explicit without becoming a trading price or logging the user out',async()=>{const m=await mount({intercept:url=>url.endsWith('/market/catalog')?Promise.resolve(new Response('upstream secret',{status:401})):null});try{assert.match(m.text(),/시세를 불러올 수 없습니다/);assert.doesNotMatch(m.text(),/upstream secret/);await m.login();assert.match(m.text(),/Signed in to Stocks/);assert.match(m.text(),/고정 모의 가격 120/)}finally{await m.close()}});
const button=name=>[...container.querySelectorAll('button')].find(b=>b.textContent===name);
test('admin offers operator sign-in only when the host can sign in; one click signs in once',async()=>{
 for(const blocked of [{initialAddress:null},{chainId:1}]){const m=await mount({path:'/admin/stocks',...blocked});try{assert.match(m.text(),/Operator session required/);assert.equal(Boolean(button('Sign in with operator wallet')),false,JSON.stringify(blocked));assert.equal(button('Sign in to Stocks').disabled,true);assert.equal(m.authCount,0)}finally{await m.close()}}
 const m=await mount({path:'/admin/stocks'});try{const operator=button('Sign in with operator wallet');assert.ok(Boolean(operator));assert.equal(m.authCount,0);await act(async()=>{operator.click();await flush()});assert.equal(m.authCount,2,'one nonce and one verify');assert.match(m.text(),/Signed in to Stocks/);assert.match(m.text(),/No Stocks read permission/)}finally{await m.close()}
});
test('operator sign-in keeps its button and keyboard focus while the signature is pending and after a rejection',async()=>{
 let reject;const signMessage=()=>new Promise((_,fail)=>{reject=fail});
 const m=await mount({path:'/admin/stocks',signMessage});try{
  const operator=button('Sign in with operator wallet');operator.focus();
  await act(async()=>{operator.click();await flush()});
  const pending=button('Sign in with operator wallet');
  assert.ok(Boolean(pending),'the shortcut stays while the signature is pending');assert.ok(document.activeElement===pending,`pending: focus stays on the shortcut, not ${document.activeElement?.tagName}`);
  assert.match(m.text(),/Complete the sign-in message in your wallet/);assert.equal(m.authCount,1,'one nonce only');
  await act(async()=>{pending.click();await flush()});assert.equal(m.authCount,1,'a second press while pending starts nothing new');
  await act(async()=>{reject(Object.assign(new Error('User rejected'),{code:4001}));await flush()});
  const after=button('Sign in with operator wallet');assert.ok(Boolean(after));assert.ok(document.activeElement===after,`after rejection: focus stays on the shortcut, not ${document.activeElement?.tagName}`);
  assert.match(m.text(),/Stocks sign-in could not be completed/);assert.equal(m.authCount,1)
 }finally{await m.close()}
});
test('unsupported wallet source copy says orders can still be placed but not funded from this wallet',async()=>{const m=await mount({walletSource:{mode:'dynamic',client:{}}});try{const note=container.querySelector('[data-testid="stocks-execution-capability"]').textContent;assert.ok(note.startsWith('현재 연결된 지갑 방식은 거래 요청을 한 번만 보내도록 보장할 수 없어 이 앱에서 입금·매도 예치를 지원하지 않습니다. 주문은 만들 수 있지만 이 지갑으로는 입금·예치할 수 없고, 주문 상태만 확인할 수 있습니다.'),note);assert.doesNotMatch(note,/주문 상태 조회만 가능합니다/);assert.equal(m.authCount,0)}finally{await m.close()}});
test.after(()=>dom.window.close());
