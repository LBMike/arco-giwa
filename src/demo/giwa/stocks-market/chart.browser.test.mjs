// Offline actual-route regression. Provide a separately owned Vite origin and existing Playwright runtime.
// GIWA_MARKET_BROWSER_URL=http://127.0.0.1:5724 GIWA_MARKET_PLAYWRIGHT=/absolute/playwright node --import tsx --test this-file
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fixtureMarketFetch} from './fixtures.ts';
import {createFakeStocksServer} from '../stocks-investor/fixtures/fake-stocks-server.ts';
const {chromium}=createRequire(import.meta.url)(process.env.GIWA_MARKET_PLAYWRIGHT);
const origin=new URL(process.env.GIWA_MARKET_BROWSER_URL).origin;
for(const width of [375,1440])test(`singleton gap observations remain visible and selection exits at ${width}px`,async()=>{
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking']});
 try{
  const context=await browser.newContext({viewport:{width,height:1000},hasTouch:width===375});const page=await context.newPage();
  const fetch=fixtureMarketFetch('ready',['NVDA']);const trade=createFakeStocksServer();
  await page.route('**/*',async route=>{const u=new URL(route.request().url());if(u.origin===origin)return route.continue();
   if(u.hostname!=='localhost'||u.port!=='8080')return route.abort();
   const response=u.pathname.includes('/market/')?await fetch(u.href,{method:'GET'}):await trade.fetch(u.href,{method:'GET'});
   const body=JSON.parse(await response.text());if(u.pathname.endsWith('/chart')){body.data.bars=[body.data.bars[0],body.data.bars[2]];body.data.history='TRUNCATED';body.data.complete=false}
   return route.fulfill({status:response.status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`${origin}/stocks`);await page.getByText('정확한 OHLCV 원자료 (2개)',{exact:true}).waitFor();await page.waitForTimeout(300);
  const dots=await page.locator('.recharts-area-dot').count();
  const slider=page.getByLabel('관측값 선택 · 방향키로 이동 · 종가와 봉 시작 시각');await slider.scrollIntoViewIfNeeded();
  if(width===375)await slider.tap({position:{x:8,y:8}});else{await slider.focus();await page.keyboard.press('ArrowLeft')}
  await page.getByText('5m 구간 종가 · 시각은 봉 시작',{exact:true}).waitFor();
  await page.getByRole('heading',{name:'NVDA · 테스트넷 모의 거래'}).click();
  const pointerExit=await page.getByText('기초 주식 시세 · USD',{exact:true}).count();
  await slider.focus();await page.getByRole('button',{name:'1D',exact:true}).focus();await page.getByRole('button',{name:'1D',exact:true}).evaluate(button=>button.blur());
  if(width===375)await slider.tap({position:{x:8,y:8}});else{await slider.focus();await page.keyboard.press('ArrowLeft')}
  await page.getByText('5m 구간 종가 · 시각은 봉 시작',{exact:true}).waitFor();
  await page.getByRole('button',{name:'1D',exact:true}).focus();
  const focusExit=await page.getByText('기초 주식 시세 · USD',{exact:true}).count();
  console.log(JSON.stringify({width,dots,pointerExit,focusExit}));
  assert.deepEqual({dots,pointerExit,focusExit},{dots:2,pointerExit:1,focusExit:1});
 }finally{await browser.close()}
});
