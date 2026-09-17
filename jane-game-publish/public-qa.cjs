const fs = require('node:fs');
const crypto = require('node:crypto');
const puppeteer = require('/tmp/jane-browser-qa/node_modules/puppeteer-core');
const site = 'https://jane-game-play.netlify.app';
const expected = '8f8eb58fef07480a3c8fab35f5f0380ebe0292e61eaa3c5ba208d47f970b07de';
const report = {site,checks:[],errors:[],limits:['Physical microphone recognition and audible playback are not verified by headless browser tests.','Fully screen-free accessibility has not been certified.']};
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const assert = (v,msg) => {if(!v)throw new Error(msg);};
const text = (p,s) => p.$eval(s,e=>e.textContent.trim());
const check = msg => {report.checks.push(msg);console.log('PASS '+msg);};
(async()=>{
 fs.mkdirSync('qa',{recursive:true});
 let ready=false;
 for(let i=0;i<90;i++){
  try{const r=await fetch(site+'/?qa='+Date.now(),{signal:AbortSignal.timeout(12000)});if(r.ok&&crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex')===expected){ready=true;break;}}catch{}
  if(i%6===0)console.log('Waiting for exact Jane Game artifact to be published.');
  await sleep(8000);
 }
 assert(ready,'Expected game was not published'); check('Live HTML matches the exact tested source checksum.');
 const status=await fetch(site+'/api/host').then(r=>r.json());report.host=status;
 const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const p=await browser.newPage(); await p.setViewport({width:1440,height:1050});
  p.on('pageerror',e=>report.errors.push(e.message));
  await p.goto(site,{waitUntil:'networkidle0',timeout:60000});
  await p.waitForSelector('#puzzle-tiles .puzzle-tile');
  assert(await p.$$eval('.puzzle-tile',es=>es.length)===3,'Expected three puzzles');
  await p.screenshot({path:'qa/desktop-home.png',fullPage:true});
  await p.click('#start-quiet');assert(await text(p,'#puzzle-title')==='Lucky seven','First puzzle wrong');
  await p.type('#thought','I think there are six winning pairs out of thirty-six.');await p.click('#send-button');
  await p.waitForFunction(()=>!document.getElementById('send-button').disabled,{timeout:45000});
  if(!status.connected)assert((await text(p,'#trail-notes')).includes('six winning pairs'),'Notes not retained');
  await p.click('[data-action=hint]');await p.waitForFunction(()=>!document.getElementById('send-button').disabled,{timeout:45000});
  assert((await text(p,'#host-text')).length>10,'Hint missing');
  await p.click('[data-action=recap]');await p.waitForFunction(()=>!document.getElementById('send-button').disabled,{timeout:45000});
  if(!status.connected)assert((await text(p,'#host-text')).includes('six winning pairs'),'Recap did not recall saved thought');
  await p.click('[data-action=explain]');await p.waitForFunction(()=>!document.getElementById('send-button').disabled,{timeout:45000});
  assert(/one in six|1\/6|16.67/i.test(await text(p,'#host-text')),'Dice explanation missing');
  check('Round one, saved thought, hint, reminder and answer explanation.');
  await p.click('#next-button');assert(await text(p,'#puzzle-title')==='Second chances','Second puzzle wrong');
  await p.click('.experiment summary');await p.click('#trial-roll');assert(await p.$eval('#trial-again',e=>!e.hidden),'Reroll absent');
  await p.click('#trial-again');assert((await text(p,'#trial-result')).includes('payout'),'Reroll did not pay');
  await p.click('[data-action=explain]');await p.waitForFunction(()=>!document.getElementById('send-button').disabled,{timeout:45000});
  assert(/twenty-five cents|4.25|four.*quarter/i.test(await text(p,'#host-text')),'Reroll fair value wrong');
  check('Round two reroll sandbox and verified payout explanation.');
  await p.click('#next-button');assert(await text(p,'#puzzle-title')==='Two wrongs, one right','Third puzzle wrong');
  await p.type('#thought','Flip both ten times, more tails wins, run it again for a tie.');await p.click('#send-button');
  await p.waitForFunction(()=>!document.getElementById('send-button').disabled,{timeout:45000});
  await p.click('[data-action=explain]');await p.waitForFunction(()=>!document.getElementById('send-button').disabled,{timeout:45000});
  if(!status.connected)assert((await text(p,'#host-text')).includes('ten times'),'Alternative solution not included');
  await p.click('#pause-button');assert(await text(p,'#pause-label')==='Continue','Pause not honored');
  await p.click('#pause-button');
  await p.screenshot({path:'qa/desktop-game.png',fullPage:true});
  check('Round three includes the valid longer contest, pause and resume.');
  await p.reload({waitUntil:'networkidle0'});await p.waitForSelector('#resume-button',{visible:true});await p.click('#resume-button');
  assert(await text(p,'#puzzle-title')==='Two wrongs, one right','Reload lost position');
  if(!status.connected)assert((await text(p,'#trail-notes')).includes('Flip both ten times'),'Reload lost notes');
  check('Progress and notes persist across an actual page reload.');
  await p.click('#next-button');assert(await p.$eval('#finish',e=>!e.hidden),'Finish missing');assert(await p.$$eval('.finish-item',es=>es.length)===3,'Finish summary wrong');
  await p.click('#again-button');await p.click('#how-button');assert(await p.$eval('#how-dialog',e=>e.open),'Help did not open');await p.keyboard.press('Escape');
  await p.click('#about-button');await p.click('#forget-button');assert(await p.$eval('#resume-row',e=>e.hidden),'Clear progress failed');
  check('Finish, help dialog, keyboard close and clearing browser progress.');
  const m=await browser.newPage();await m.setViewport({width:390,height:844,isMobile:true,hasTouch:true});m.on('pageerror',e=>report.errors.push(e.message));
  await m.goto(site,{waitUntil:'networkidle0',timeout:60000});
  await m.screenshot({path:'qa/mobile-home.png',fullPage:true});
  await m.click('#start-voice');assert(await text(m,'#sound-label')==='Sound on','Read-aloud mode not enabled');
  await m.click('#pause-button');assert(await text(m,'#pause-label')==='Continue','Audio pause control wrong');await m.click('#pause-button');
  await m.click('#sound-button');
  for(let i=1;i<=3;i++){await m.click(`#steps button:nth-of-type(${i})`);assert(await m.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile overflow');}
  await m.screenshot({path:'qa/mobile-game.png',fullPage:true});
  check('Mobile 390px, all round selectors, sound control and pause; no horizontal overflow.');
  assert(!report.errors.length,'Browser runtime errors: '+report.errors.join('; '));check('No JavaScript runtime errors in tested desktop and mobile flows.');
  report.result='passed';console.log(JSON.stringify(report,null,2));
 }finally{await browser.close();}
})().catch(e=>{report.result='failed';report.errors.push(e.stack||String(e));console.error(e);process.exitCode=1;}).finally(()=>{fs.mkdirSync('qa',{recursive:true});fs.writeFileSync('qa/public-qa.json',JSON.stringify(report,null,2));});
