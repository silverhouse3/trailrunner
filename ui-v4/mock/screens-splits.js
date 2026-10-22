// Extra round-3 shots: free-run summary (no comparison) and route with only one past run. Run after start.sh.
var pw=require('/mnt/d/trailrunner/node_modules/playwright');
(async()=>{await fetch('http://localhost:4510/mock/reset',{method:'POST'});
var b=await pw.chromium.launch();var p=await b.newPage({viewport:{width:1920,height:1080}});var errs=[];
p.on('pageerror',e=>errs.push(e.message));
// free run with splits, no route → THIS RUN only + note
await p.goto('http://localhost:8099/?demo=noroute');await new Promise(r=>setTimeout(r,1200));
await p.click('.tile-free');await new Promise(r=>setTimeout(r,600));await p.click('#fcStart');await new Promise(r=>setTimeout(r,2500));
await p.evaluate(()=>{var r=Engine.run;r.distanceM=2300;r.elapsed=760;r.splits=[{km:1,timeSec:330,paceSecPerKm:330,avgHR:140,elapsed:330},{km:2,timeSec:318,paceSecPerKm:318,avgHR:149,elapsed:648,negativeSplit:true}];r._lastSplitElapsed=648;r._lastSplitKm=2;r._splitHRSum=155*20;r._splitHRSamples=20;App.finishRun();document.querySelectorAll('.milestone-popup').forEach(x=>x.classList.remove('show'))});
await new Promise(r=>setTimeout(r,1000));
await p.screenshot({path:'screens/40-summary-free-run-no-compare.png'});
var txt=await p.evaluate(()=>document.querySelector('.sc-basis').textContent+' | cols='+document.querySelectorAll('.sc-table th').length);
console.log(txt);
await p.evaluate(()=>App.discardRun());await new Promise(r=>setTimeout(r,500));
// route with only 1 past run → not enough
await p.goto('http://localhost:8099/?demo=route');await new Promise(r=>setTimeout(r,1500));
await p.evaluate(()=>{var runs=Store.getRuns();var rid=Store.getActiveRouteId();runs.unshift({id:'x1',routeId:rid,routeName:'Ashton',savedAt:new Date().toISOString(),distanceKm:3,elapsed:900,splits:[{km:1,timeSec:300,avgHR:140},{km:2,timeSec:300,avgHR:145},{km:3,timeSec:300,avgHR:150}]});localStorage.setItem('tr_runs',JSON.stringify(runs))});
await p.click('.tile-route');await new Promise(r=>setTimeout(r,500));await p.click('#runRouteBtn');await new Promise(r=>setTimeout(r,1200));await p.click('#fcStart');await new Promise(r=>setTimeout(r,2500));
await p.evaluate(()=>{var r=Engine.run;r.distanceM=2050;r.elapsed=640;r.splits=[{km:1,timeSec:310,avgHR:141,elapsed:310},{km:2,timeSec:320,avgHR:150,elapsed:630}];r._lastSplitElapsed=630;r._lastSplitKm=2;App.finishRun();document.querySelectorAll('.milestone-popup').forEach(x=>x.classList.remove('show'))});
await new Promise(r=>setTimeout(r,1000));
console.log(await p.evaluate(()=>document.querySelector('.sc-basis').textContent));
await p.screenshot({path:'screens/41-summary-route-one-past-run.png'});
await p.evaluate(()=>App.discardRun());
console.log('errors',errs);await b.close();})();
