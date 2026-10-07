'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('function powerViewModel(');
const script = html.slice(start, html.indexOf('</script>', start));
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  return {generatedAt:new Date().toISOString(),rate:{usdPerKwh:.1},totalW:800,uptimeS:3600,
    lifetime:{kwh:12,avgW:500,hours:24,sinceMs:Date.now()-86400000},
    sources:[{kind:'gpu',name:'GPU',w:null,note:'Not measurable on this host'},
      {kind:'baseline',name:'Baseline',w:50}],samples:[]};
}
function boot({initial=fixture(), failGet=false}={}) {
  const elements = new Map(), timers = new Map(), calls = [], listeners = {};
  let nextTimer = 0, current = initial, getFails = failGet, putFails = false, pendingGet = null;
  const document = {visibilityState:'visible',body:{},activeElement:null,
    addEventListener(name,fn){listeners[name]=fn},getElementById:el,
    createElement(tag){return create(tag)}};
  function create(id) {
    const classes = new Set();
    return {id,children:[],listeners:{},textContent:'',value:'',disabled:false,clientWidth:700,
      classList:{add:n=>classes.add(n),remove:n=>classes.delete(n),contains:n=>classes.has(n),toggle(n,force){force ? classes.add(n):classes.delete(n)}},
      append(...nodes){this.children.push(...nodes)},appendChild(n){this.children.push(n)},replaceChildren(){this.children=[]},
      focus(){document.activeElement=this},select(){},addEventListener(name,fn){this.listeners[name]=fn},
      getContext(){return new Proxy({}, {get:()=>()=>{}})}};
  }
  function el(id){if(!elements.has(id))elements.set(id,create(id));return elements.get(id)}
  const sandbox={document,console,Date,AbortController,
    getComputedStyle:()=>({getPropertyValue:()=> '#8797ad'}),
    setTimeout(fn,ms){const id=++nextTimer;timers.set(id,{fn,ms});return id},clearTimeout:id=>timers.delete(id),
    fetch:async(url,options={})=>{
      calls.push({url,options});
      if(options.method==='PUT'){
        if(putFails)return {ok:false,status:500};
        current={...current,rate:{usdPerKwh:JSON.parse(options.body).rate.usdPerKwh}};
        return {ok:true,json:async()=>({ok:true})};
      }
      if(pendingGet){const pending=pendingGet;pendingGet=null;return pending;}
      return getFails ? {ok:false,status:503} : {ok:true,json:async()=>current};
    }};
  sandbox.window=sandbox;vm.createContext(sandbox);vm.runInContext(script,sandbox);
  return {el,document,calls,timers,model:vm.runInContext('powerViewModel',sandbox),
    failGet(v){getFails=v},failPut(v){putFails=v},setData(v){current=v},delayGet(p){pendingGet=p},
    click(id){return el(id).listeners.click()},submit(){return el('powerRateForm').listeners.submit({preventDefault(){}})},
    poll(){const entry=[...timers].find(([,t])=>t.ms===5000);assert.ok(entry,'visible power poll scheduled');timers.delete(entry[0]);return entry[1].fn()},
    visibility(value){document.visibilityState=value;listeners.visibilitychange()}};
}

test('costs use recorded energy, the configured rate and the monitored average', async()=>{
  const app=boot();await flush();
  const v=app.model(fixture());
  assert.equal(v.cost,1.2000000000000002);assert.equal(v.daily,1.2000000000000002);assert.equal(v.monthly,36.00000000000001);
  assert.equal(v.hourly,.08000000000000002);
  assert.equal(app.el('powerCost').textContent,'$1.20');assert.equal(app.el('powerProjection').textContent,'$36.00');
  for(const lifetime of [{kwh:1,hours:0,avgW:800},{kwh:1,hours:2},{kwh:1,hours:2,avgW:null},{kwh:1,hours:Infinity,avgW:800}]){
    const v=app.model({...fixture(),lifetime});assert.equal(v.daily,null);assert.equal(v.monthly,null);
  }
  assert.equal(app.model({...fixture(),lifetime:{hours:1,avgW:0,kwh:0}}).monthly,0,'measured zero is valid');
  assert.equal(app.model({...fixture(),rate:{}}).cost,null);
});

test('missing sensors and empty history remain explicit rather than appearing as zero', async()=>{
  const app=boot();await flush();
  assert.equal(app.el('powerSources').children[0].children[1].textContent,'Not measurable on this host');
  assert.match(app.el('powerSources').children[1].children[0].textContent,/estimate/);
  assert.match(app.el('powerChartSummary').textContent,/No power history/);
});

test('polling preserves focus and rate edits, including a failed save followed by retry', async()=>{
  const app=boot();await flush();app.click('powerRateEdit');app.el('powerRateInput').value='0.2';
  await app.poll();
  assert.equal(app.el('powerRateInput').value,'0.2');assert.equal(app.document.activeElement,app.el('powerRateInput'));
  app.failPut(true);await app.submit();
  assert.match(app.el('powerRateError').textContent,/Could not save/);assert.equal(app.el('powerRateInput').value,'0.2');
  assert.equal(app.el('powerRateForm').classList.contains('hidden'),false);
  app.failPut(false);await app.submit();
  assert.equal(app.el('powerCost').textContent,'$2.40');assert.equal(app.el('powerProjection').textContent,'$72.00');
  assert.equal(app.el('powerRateForm').classList.contains('hidden'),true);
  assert.equal(app.document.activeElement,app.el('powerRateEdit'));
});

test('a poll started before a rate save cannot overwrite the saved rate', async()=>{
  const app=boot();await flush();let resolve;
  app.delayGet(new Promise(r=>resolve=r));const polling=app.poll();
  app.click('powerRateEdit');app.el('powerRateInput').value='0.2';await app.submit();
  resolve({ok:true,json:async()=>fixture()});await polling;await flush();
  assert.equal(app.el('powerRateValue').textContent,'$0.2/kWh');
  assert.equal(app.el('powerCost').textContent,'$2.40');
});

test('initial errors and stale requests recover, and hidden documents stop polling', async()=>{
  const app=boot({failGet:true});await flush();assert.match(app.el('powerStatus').textContent,/unavailable/);
  assert.equal(app.el('powerCost').textContent,'—');
  app.failGet(false);await app.poll();assert.equal(app.el('powerStatus').textContent,'');
  app.failGet(true);await app.poll();assert.match(app.el('powerStatus').textContent,/stale/);assert.equal(app.el('powerCost').textContent,'$1.20');
  app.visibility('hidden');assert.equal([...app.timers.values()].filter(t=>t.ms===5000).length,0);
  app.failGet(false);const before=app.calls.length;app.visibility('visible');await flush();
  assert.equal(app.calls.length,before+1);assert.equal(app.el('powerStatus').textContent,'');
});

test('invalid rate input sends no request and preserves the edit', async()=>{
  const app=boot();await flush();app.click('powerRateEdit');const before=app.calls.length;
  for(const value of ['', '-1','11','abc']){
    app.el('powerRateInput').value=value;await app.submit();assert.match(app.el('powerRateError').textContent,/Enter a rate/);
  }
  assert.equal(app.calls.length,before);assert.equal(app.el('powerRateForm').classList.contains('hidden'),false);
});
