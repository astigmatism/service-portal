'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const script = html.slice(html.indexOf('/* ---- Compact view sizing'),html.indexOf('/* ---- Power / efficiency'));
function boot(stored={},failStorage=false){
  const store = new Map(Object.entries(stored)), elements=new Map(), events={};
  const sandbox={innerWidth:1920,innerHeight:1080,
    localStorage:{getItem(k){if(failStorage)throw Error('blocked');return store.get(k)||null;},setItem(k,v){if(failStorage)throw Error('blocked');store.set(k,v);}},
    document:{getElementById:el},addEventListener(n,f){events[n]=f;}};
  function el(id){
    if(elements.has(id))return elements.get(id);
    const classes=new Set(),capture=new Set();
    const e={style:{setProperty(k,v){this[k]=v;}},attrs:{},listeners:{},
      classList:{toggle(k,v){v?classes.add(k):classes.delete(k);},add(k){classes.add(k);},remove(k){classes.delete(k);},contains(k){return classes.has(k);}},
      setAttribute(k,v){this.attrs[k]=v;},addEventListener(n,f){this.listeners[n]=f;},
      setPointerCapture(id){capture.add(id);},hasPointerCapture(id){return capture.has(id);},releasePointerCapture(id){capture.delete(id);},
      getBoundingClientRect(){return {width:parseFloat(this.style['--compact-width'])||360,height:parseFloat(this.style['--compact-height'])||360};}};
    elements.set(id,e);return e;
  }
  sandbox.window=sandbox;vm.runInNewContext(script,sandbox);
  const fire=(id,event,data={})=>el(id).listeners[event]({button:0,pointerId:1,clientX:0,clientY:0,preventDefault(){},...data});
  return {el,store,fire,toggle:()=>fire('viewModeToggle','click'),
    size:()=>el('app').getBoundingClientRect(),resize(w,h){sandbox.innerWidth=w;sandbox.innerHeight=h;events.resize();},
    drag(id,x,y){fire(id,'pointerdown');fire(id,'pointermove',{clientX:x,clientY:y});fire(id,'pointerup');}};
}
test('compact defaults, preference validation, and unavailable storage',()=>{
  const app=boot();assert.equal(app.el('app').classList.contains('is-compact'),false);
  app.toggle();assert.equal(app.store.get('sp-compact-view'),'1');assert.equal(app.size().width,360);
  assert.equal(app.el('app').style['--compact-height'],'auto');
  for(const bad of ['{bad','null','{"width":-1,"height":300}','{"width":350,"height":"bad"}']){
    assert.equal(boot({'sp-compact-size':bad}).size().width,360);
  }
  const blocked=boot({},true);assert.doesNotThrow(()=>{blocked.toggle();blocked.drag('compactResizeCorner',20,30);});
});
test('edge resizing changes only its axis and corner respects minimum dimensions',()=>{
  const app=boot({'sp-compact-view':'1'});
  app.drag('compactResizeRight',40,120);assert.equal(app.size().width,400);
  assert.equal(app.el('app').style['--compact-height'],'auto');
  app.drag('compactResizeBottom',150,-60);assert.deepEqual(app.size(),{width:400,height:300});
  app.drag('compactResizeCorner',-1000,-1000);assert.deepEqual(app.size(),{width:280,height:250});
  const reopened=boot(Object.fromEntries(app.store));assert.deepEqual(reopened.size(),app.size());
  app.toggle();assert.equal(app.el('app').classList.contains('is-compact'),false);
  app.toggle();assert.deepEqual(app.size(),{width:280,height:250});
});
test('viewport and two-page clamps preserve preferred dimensions for restoration',()=>{
  const app=boot({'sp-compact-view':'1'});
  app.drag('compactResizeCorner',1000,1000);assert.deepEqual(app.size(),{width:880,height:1032});
  app.resize(1440,900);assert.deepEqual(app.size(),{width:672,height:852});
  app.resize(390,844);assert.deepEqual(app.size(),{width:366,height:820});
  app.resize(250,230);assert.deepEqual(app.size(),{width:226,height:206});
  app.resize(1920,1080);assert.deepEqual(app.size(),{width:880,height:1032});
  assert.deepEqual(JSON.parse(app.store.get('sp-compact-size')),{width:880,height:1032});
});
test('keyboard sizing, cancellation, foreign pointers and default reset',()=>{
  const app=boot({'sp-compact-view':'1'});
  app.fire('compactResizeRight','keydown',{key:'ArrowLeft'});assert.equal(app.size().width,350);
  app.fire('compactResizeBottom','keydown',{key:'ArrowUp',shiftKey:true});assert.equal(app.size().height,359);
  app.fire('compactResizeRight','pointerdown');
  app.fire('compactResizeRight','pointermove',{pointerId:2,clientX:100});assert.equal(app.size().width,350);
  app.fire('compactResizeRight','pointermove',{clientX:10});
  app.fire('compactResizeRight','pointercancel');assert.equal(app.el('app').classList.contains('is-resizing'),false);
  app.fire('compactResizeRight','pointermove',{clientX:200});assert.equal(app.size().width,360);
  app.fire('compactResizeCorner','keydown',{key:'Home'});assert.equal(app.el('app').style['--compact-height'],'auto');
});
