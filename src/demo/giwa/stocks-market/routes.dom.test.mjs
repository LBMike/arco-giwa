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
const chartText=()=>container.querySelector('[aria-label="Underlying security chart"]')?.textContent??'';
const statisticsText=()=>[...container.querySelectorAll('article section')].find(section=>section.querySelector('h2')?.textContent==='Statistics')?.textContent??'';
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
test('real /stocks keyless route lists NVDA and separates display from fixed mock trading; no auto sign-in',async()=>{const m=await mount();try{assert.match(m.text(),/Price feed setup pending/);assert.match(m.text(),/Stocks & ETFs/);assert.match(m.text(),/고정 모의 가격 120/);assert.match(m.text(),/Not signed in/);assert.equal(m.authCount,0);assert.equal(m.calls.some(c=>c.init.method==='POST'),false);assert.equal(container.querySelector('iframe'),null)}finally{await m.close()}});
test('real route no-client state is explicit and makes no API calls',async()=>{const m=await mount({apiBase:null});try{assert.match(m.text(),/Market data API setup pending/);assert.equal(m.calls.length,0)}finally{await m.close()}});
test('admin without an API base still has one page h1 and makes no API calls',async()=>{const m=await mount({path:'/admin/stocks',apiBase:null});try{const h1=[...container.querySelectorAll('h1')].map(e=>e.textContent);assert.deepEqual(h1,['Stocks operations']);assert.match(m.text(),/Stocks admin API is not connected yet/);assert.equal(m.calls.length,0)}finally{await m.close()}});
test('Stocks admin is a sibling route using common session and server403, not a browser allowlist',async()=>{const m=await mount({path:'/admin/stocks'});try{assert.match(m.text(),/Operator session required/);await m.login();assert.match(m.text(),/No Stocks read permission/);assert.equal(m.authCount,2);assert.ok(m.calls.some(c=>c.url.includes('/admin/stocks/')&&new Headers(c.init.headers).has('authorization')));assert.doesNotMatch(m.text(),/Operator token/)}finally{await m.close()}});
test('navigation retains one host login and a new-account first commit hides admin order data',async()=>{const m=await mount({adminAllowed:true});try{await m.login();assert.match(m.text(),/Signed in to Stocks/);await act(async()=>{await m.router.navigate('/admin/stocks');await flush()});assert.match(m.text(),new RegExp(FIXTURE_IDS.buyFinality));assert.equal(m.authCount,2);await m.render(B,true);assert.doesNotMatch(m.firstCommit,new RegExp(FIXTURE_IDS.buyFinality));assert.match(m.text(),/Operator session required/);await act(async()=>{await m.router.navigate('/stocks');await flush()});assert.match(m.text(),/Not signed in/);assert.equal(m.authCount,2)}finally{await m.close()}});
// The detail replaced the list at ?symbol= (bare /stocks is the list), so chart states are read on the NVDA detail.
for(const mode of ['stale','partial','empty','one'])test(`actual Stocks route renders ${mode} market history`,async()=>{const m=await mount({mode,path:'/stocks?symbol=NVDA'});try{assert.match(m.text(),new RegExp(mode==='stale'?'Last observed prices · Stale data':mode==='partial'?'Partial history returned':mode==='empty'?'No chart observations returned':'One observation'));assert.match(m.text(),/Feed delay unknown/)}finally{await m.close()}});
test('symbol/range switching ignores late previous response and never changes NVDA order identity',async()=>{const held=[];const m=await mount({mode:'ready',intercept:(url,init)=>{if(url.includes('/AAPL/chart'))return new Promise(resolve=>held.push({url,init,resolve}));return null}});try{
 // The vertical symbol list became the Stocks & ETFs table; its row button selects through ?symbol=.
 await act(async()=>{container.querySelector('[role="table"][aria-label="Stocks & ETFs"] button[data-symbol="AAPL"]').click();await flush()});assert.equal(m.router.state.location.search,'?symbol=AAPL');
 await act(async()=>{[...container.querySelectorAll('[aria-label="Chart period"] button')].find(b=>b.textContent==='1W').click();await flush()});
 const newest=held.findLast(item=>item.url.endsWith("range=1W"));const old=held.findLast(item=>item.url.endsWith("range=1D"));assert.ok(newest&&old);assert.equal(old.init.signal.aborted,true);
 await act(async()=>{newest.resolve(Response.json(fixtureEnvelope(fixtureChart('AAPL','1W'))));await flush()});assert.match(m.text(),/1W · 1h/);
 await act(async()=>{old.resolve(Response.json(fixtureEnvelope(fixtureChart('AAPL','1D'))));await flush()});assert.match(m.text(),/1W · 1h/);assert.doesNotMatch(chartText(),/Latest observed trading session/,'the late 1D answer never paints the chart');assert.doesNotMatch(statisticsText(),/Latest observed trading day · first open/,'nor the 1D statistics');assert.equal(m.text().split('AAPL supports market data only').length-1,1,'the view-only copy once, in the right column');assert.match(m.text(),/NVDA · testnet mock trading/);
}finally{for(const item of held)item.resolve(new Response('{}',{status:401}));await m.close()}});
test('stale company information has its own status and timestamp alongside fresh quotes',async()=>{const m=await mount({mode:'ready',path:'/stocks?symbol=NVDA',intercept:url=>url.endsWith('/profile')?Promise.resolve(Response.json(fixtureEnvelope(fixtureProfile('NVDA'),'STALE'))):null});try{const status=container.querySelector('[aria-label="Company profile status"]').textContent;assert.match(status,/stale data/);assert.match(status,/Company profile fetched/);assert.match(status,/provider data date: unknown/);assert.match(status,/Separate from the quote observation time/)}finally{await m.close()}});
test('API switch retires late401 from old market reads without invalidating the new login',async()=>{
 const held=[];const m=await mount({mode:'ready',path:'/stocks?symbol=NVDA',intercept:(url,init)=>url.startsWith('https://api.fixture/')&&url.includes('/NVDA/chart')?new Promise(resolve=>held.push({resolve,init})):null});
 try{await m.setApi('https://api-b.fixture');await m.login();assert.match(m.text(),/Signed in to Stocks/);assert.match(chartText(),/Latest observed trading session/);assert.ok(held.every(item=>item.init.signal.aborted));await act(async()=>{for(const item of held)item.resolve(new Response('{}',{status:401}));await flush()});assert.match(m.text(),/Signed in to Stocks/);assert.match(chartText(),/Latest observed trading session/)}finally{await m.close()}
});
test('market HTTP errors stay explicit without becoming a trading price or logging the user out',async()=>{const m=await mount({intercept:url=>url.endsWith('/market/catalog')?Promise.resolve(new Response('upstream secret',{status:401})):null});try{assert.match(m.text(),/Market prices unavailable/);assert.doesNotMatch(m.text(),/upstream secret/);await m.login();assert.match(m.text(),/Signed in to Stocks/);assert.match(m.text(),/고정 모의 가격 120/)}finally{await m.close()}});
test('a detail deep link with the market API failing names the symbol, shows the error and leaves the NVDA order panel working',async()=>{const m=await mount({mode:'ready',path:'/stocks?symbol=NVDA',intercept:url=>url.includes('/stocks/market/')?Promise.resolve(new Response('upstream secret',{status:404})):null});try{
 assert.match(container.querySelector('article h1').textContent,/NVDA/);assert.match(m.text(),/Market prices unavailable/);assert.doesNotMatch(m.text(),/upstream secret/);
 assert.equal(m.calls.filter(c=>/\/market\/.+\/(profile|chart)/.test(c.url)).length,0,'no profile or chart read without a market catalog');
 assert.equal(container.querySelectorAll('input[inputmode="decimal"]').length,1,'the NVDA order form does not wait for market data');assert.match(m.text(),/Demo trading/,'the capability badge comes from the order catalog');
 await m.login();assert.match(m.text(),/Signed in to Stocks/);assert.match(m.text(),/Signed in as/);
}finally{await m.close()}});
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
test('unsupported wallet source copy says orders can still be placed but not funded from this wallet',async()=>{const m=await mount({walletSource:{mode:'dynamic',client:{}}});try{const note=container.querySelector('[data-testid="stocks-execution-capability"]').textContent;assert.ok(note.startsWith('The connected wallet cannot guarantee that a transaction request is sent only once, so this app does not support deposits or sell escrows with it. You can create orders, but with this wallet you can only check their status.'),note);assert.doesNotMatch(note,/주문 상태 조회만 가능합니다/);assert.equal(m.authCount,0)}finally{await m.close()}});
test('a non-NVDA detail requests nothing from the order API; list ↔ detail keeps one order controller; View NVDA opens the NVDA detail in the same click',async()=>{const m=await mount({mode:'ready'});try{
 const investor=()=>m.calls.filter(c=>c.url.includes('/api/v1/stocks/')&&!c.url.includes('/stocks/market/'));
 const catalogReads=()=>investor().filter(c=>c.url.endsWith('/api/v1/stocks/catalog')).length;
 const reads=catalogReads();assert.ok(reads>=1);
 await act(async()=>{container.querySelector('button[data-symbol="AAPL"]').click();await flush()});
 assert.equal(m.router.state.location.search,'?symbol=AAPL');assert.equal(container.querySelector('[role="table"][aria-label="Stocks & ETFs"]'),null,'the detail replaces the list');
 const card=[...container.querySelectorAll('[role="status"]')].filter(e=>/AAPL supports market data only\. Mock orders support NVDA only, and this symbol is not turned into an NVDA order\./.test(e.textContent));assert.equal(card.length,1);
 assert.equal(container.querySelector('input[inputmode="decimal"]'),null,'no order form for AAPL');
 await act(async()=>{[...container.querySelectorAll('[aria-label="Chart period"] button')].find(b=>b.textContent==='1M').click();await flush()});
 await act(async()=>{[...container.querySelectorAll('button')].find(b=>b.textContent==='Stocks & ETFs list').click();await flush()});
 assert.equal(m.router.state.location.search,'');
 assert.deepEqual(investor().filter(c=>!c.url.endsWith('/api/v1/stocks/catalog')).map(c=>c.url),[],'no quote, order or portfolio request');assert.equal(m.calls.some(c=>c.init.method==='POST'),false);
 assert.equal(catalogReads(),reads,'the order controller never remounted (no second catalog read)');
 await act(async()=>{container.querySelector('button[data-symbol="AAPL"]').click();await flush()});
 const view=container.querySelector('button[aria-label="View NVDA"]');assert.ok(view,'the order panel offers View NVDA on the AAPL detail');view.focus();
 act(()=>{view.click()});
 assert.ok(container.querySelector('input[inputmode="decimal"]'),'the NVDA order form is on the page in the click\'s own commit');
 assert.match(container.querySelector('article h1')?.textContent??'',/NVDA/);
 await act(async()=>{await flush()});
 assert.equal(m.router.state.location.search,'?symbol=NVDA');
 assert.equal(container.querySelectorAll('input[inputmode="decimal"]').length,1);assert.equal(container.querySelectorAll('[data-side="BUY"]').length,1);
 assert.ok(document.activeElement!==container.querySelector('article h1'),'the page leaves focus to the order panel');
 assert.equal(catalogReads(),reads);assert.equal(m.calls.some(c=>c.init.method==='POST'),false);assert.equal(m.authCount,0);
}finally{await m.close()}});
test('detail mode: only the heading sits above the NVDA order panel; the full explanation follows the panel (list mode keeps it under the heading)',async()=>{
 const section=()=>container.querySelector('section[aria-label="NVDA testnet mock trading"]');
 for(const [path,detail] of [['/stocks?symbol=NVDA',true],['/stocks?symbol=MU',true],['/stocks',false]]){const m=await mount({mode:'ready',path});try{
  const header=section().firstElementChild;assert.equal(header.querySelector('h2').textContent,'NVDA · testnet mock trading',path);
  if(detail){assert.equal(header.textContent,'NVDA · testnet mock trading',`${path}: nothing but the heading above the panel`);assert.doesNotMatch(section().textContent,/자세한 안내는 주문 패널 아래에 있습니다/);assert.match(section().lastElementChild.textContent,/^Testnet mock fill price: set by the server-issued quote/,`${path}: the explanation after the panel`)}
  else assert.match(header.textContent,/Testnet mock fill price: set by the server-issued quote/,'list: the explanation stays under the heading');
 }finally{await m.close()}}
});
test('market catalog unavailable: an unknown symbol gets no view-only card and no market-data badge; a curated symbol keeps both',async()=>{
 for(const [symbol,known] of [['ZZZZ',false],['MU',true]])for(const status of [503,'UNAVAILABLE']){const m=await mount({mode:'ready',path:`/stocks?symbol=${symbol}`,intercept:url=>url.endsWith('/market/catalog')?Promise.resolve(status===503?new Response('{}',{status}):Response.json(fixtureEnvelope(null,'UNAVAILABLE'))):null});try{
  const where=`${symbol} ${status}`;const header=container.querySelector('article header').textContent;
  assert.match(container.querySelector('article h1').textContent,new RegExp(symbol),where);assert.match(m.text(),/Market prices unavailable/,where);
  assert.equal(/View only/.test(m.text()),known,`${where}: view-only card`);assert.equal(/supports market data only/.test(m.text()),known,where);assert.equal(/Market data only/.test(header),known,`${where}: badge`);
  if(!known)assert.match(m.text(),/ZZZZ has not been verified in the market data catalog\./);
  assert.equal(m.calls.some(c=>c.url.includes(`/${symbol}/`)),false,`${where}: nothing requested for the symbol`);
 }finally{await m.close()}}
});
test('the page tells the trade panel WALLET_CHANGED when another wallet is connected after a sign-in (no address), and forgets it on a fresh page',async()=>{
 const changed=/The connected wallet changed\. Sign in again with this wallet\./;
 const m=await mount({mode:'ready',path:'/stocks?symbol=NVDA'});try{
  assert.doesNotMatch(m.text(),changed,'nothing signed in yet');await m.login();assert.match(m.text(),/Signed in to Stocks/);
  await m.render(B);assert.match(m.text(),/Not signed in/);assert.match(m.text(),changed,'B after A signed in');
  await m.render(A);assert.doesNotMatch(m.text(),changed,'back to the signed-in wallet: an ordinary signed-out state');
 }finally{await m.close()}
 const fresh=await mount({mode:'ready',path:'/stocks?symbol=NVDA',initialAddress:B});try{assert.doesNotMatch(fresh.text(),changed,'a fresh page knows no earlier sign-in')}finally{await fresh.close()}
});
test.after(()=>dom.window.close());
