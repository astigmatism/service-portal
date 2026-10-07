'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const start = html.indexOf('window.portalPanels = (() => {');
const code = html.slice(start, html.indexOf('/* ===== Activity panel', start));

test('both dialogs close before the shared notification container', () => {
  const markup = html.slice(0, html.indexOf('<script>'));
  assert.equal((markup.match(/<dialog\b/g) || []).length, 2);
  assert.equal((markup.match(/<\/dialog>/g) || []).length, 2);
  assert.ok(markup.lastIndexOf('</dialog>') < markup.indexOf('id="toasts"'));
});

function boot() {
  const handlers = {}, documentHandlers = {};
  let focused, resizeObserver;
  const win = {innerWidth:1920, innerHeight:1080, addEventListener:(name, fn) => { handlers[name] = fn; }};
  function element() {
    const events = {}, attrs = {}, classes = new Set(['hidden']);
    return {events, attrs, style:{}, disabled:false, inert:false,
      classList:{add:n=>classes.add(n), remove:n=>classes.delete(n), contains:n=>classes.has(n)},
      setAttribute:(n,v)=>{attrs[n]=v;}, removeAttribute:n=>{delete attrs[n];},
      addEventListener:(n,fn)=>{events[n]=fn;}, focus(){focused=this;},
      getClientRects:()=>[{}], closest:()=>null};
  }
  function panel() {
    const p = element(), handle = element(), close = element(), input = element(), last = element();
    let captured = null;
    handle.setPointerCapture = id => {captured=id;};
    handle.hasPointerCapture = id => captured===id;
    handle.releasePointerCapture = () => {captured=null;};
    p.handle=handle; p.closeButton=close; p.input=input; p.last=last;
    p.scrollTop=0; p.open=false; p.naturalHeight=800;
    p.showModal=()=>{p.open=true;}; p.close=()=>{p.open=false;};
    p.querySelector=selector=>selector==='button'?close:handle;
    p.querySelectorAll=()=>[handle,close,input,last];
    p.getBoundingClientRect=()=>{const margin=win.innerWidth<600?12:16;
      return {left:parseFloat(p.style.left)||0,top:parseFloat(p.style.top)||0,
        width:Math.min(880,win.innerWidth-2*margin),height:Math.min(p.naturalHeight,win.innerHeight-2*margin)};};
    return p;
  }
  const appearance=panel(), activity=panel(), main=element(), header=element(), opener=element();
  const doc = {querySelectorAll:()=>[appearance,activity],addEventListener:(name,fn)=>{documentHandlers[name]=fn;},get activeElement(){return focused;}};
  const sandbox={window:win,document:doc,$:selector=>selector==='#pageContent'?main:header,
    ResizeObserver:class {constructor(fn){resizeObserver=fn;} observe(){} }};
  vm.runInNewContext(code,sandbox);
  const fire=(el,type,data={})=>{const ev={target:el,button:0,isPrimary:true,pointerId:1,clientX:600,clientY:160,preventDefault(){this.prevented=true;},...data};el.events[type](ev);return ev;};
  return {win,appearance,activity,main,header,opener,api:win.portalPanels,fire,handlers,documentHandlers,resize:()=>resizeObserver(),focused:()=>focused};
}

test('dialogs open centered in the native modal layer and restore focus on dismissal', () => {
  const t=boot(); let closed=0;
  t.api.open(t.appearance,t.opener,()=>closed++);
  assert.equal(t.appearance.open,true);
  assert.equal(t.appearance.style.left,'520px');
  assert.equal(t.appearance.style.top,'140px');
  assert.equal(t.main.inert,true); assert.equal(t.header.inert,true);
  assert.equal(t.focused(),t.appearance.closeButton);
  t.api.close();
  assert.equal(t.appearance.open,false); assert.equal(closed,1);
  assert.equal(t.main.inert,false); assert.equal(t.header.inert,false);
  assert.equal(t.focused(),t.opener); assert.equal(t.opener.attrs['aria-expanded'],'false');
  t.api.open(t.appearance,t.opener);
  const cancel=t.fire(t.appearance,'cancel');
  assert.equal(cancel.prevented,true); assert.equal(t.appearance.open,false);
});

test('pointer dragging preserves edits and scroll, clamps bounds, and cancels cleanly', () => {
  const t=boot(), p=t.appearance;
  t.api.open(p,t.opener); p.input.value='unfinished name'; p.input.focus(); p.scrollTop=120;
  assert.equal(t.fire(p.handle,'pointerdown').prevented,true);
  t.fire(p.handle,'pointermove',{clientX:850,clientY:220});
  assert.equal(p.style.left,'770px'); assert.equal(p.style.top,'200px');
  assert.equal(t.focused(),p.input); assert.equal(p.input.value,'unfinished name'); assert.equal(p.scrollTop,120);
  t.fire(p.handle,'pointermove',{clientX:9000,clientY:9000});
  assert.equal(p.style.left,'1024px'); assert.equal(p.style.top,'264px');
  t.fire(p.handle,'pointercancel'); assert.equal(p.classList.contains('is-dragging'),false);
  t.fire(p.handle,'pointermove',{clientX:0,clientY:0}); assert.equal(p.style.left,'1024px');
  t.win.innerWidth=390; t.win.innerHeight=844; t.handlers.resize();
  assert.equal(p.style.left,'12px'); assert.equal(p.style.top,'32px');
  assert.equal(p.input.value,'unfinished name');
  t.api.close(); t.win.innerWidth=1920; t.win.innerHeight=1080;
  t.api.open(p,t.opener); assert.equal(p.style.left,'520px'); assert.equal(p.style.top,'140px');
});

test('title controls do not start dragging; title keyboard movement and focus trapping work', () => {
  const t=boot(), p=t.appearance;
  t.api.open(p,t.opener);
  const button={closest:()=>true};
  t.fire(p.handle,'pointerdown',{target:button});
  t.fire(p.handle,'pointermove',{clientX:1000}); assert.equal(p.style.left,'520px');
  t.fire(p.handle,'keydown',{key:'ArrowRight'}); assert.equal(p.style.left,'544px');
  t.fire(p.handle,'keydown',{key:'ArrowDown',shiftKey:true}); assert.equal(p.style.top,'145px');
  t.fire(p.handle,'keydown',{key:'Home'}); assert.equal(p.style.left,'520px'); assert.equal(p.style.top,'140px');
  p.last.focus(); t.documentHandlers.keydown({key:'Tab',preventDefault(){}}); assert.equal(t.focused(),p.handle);
  t.documentHandlers.keydown({key:'Tab',shiftKey:true,preventDefault(){}}); assert.equal(t.focused(),p.last);
  t.documentHandlers.keydown({key:'Escape',preventDefault(){}}); assert.equal(p.open,false); assert.equal(t.focused(),t.opener);
});

test('Activity shares modal behavior; content growth recenters until the user moves it', () => {
  const t=boot(); let closed=0;
  t.api.open(t.appearance,t.opener,()=>closed++);
  t.activity.naturalHeight=200;
  t.api.open(t.activity,t.opener);
  assert.equal(closed,1); assert.equal(t.appearance.open,false); assert.equal(t.activity.open,true);
  assert.equal(t.activity.style.top,'440px');
  t.activity.naturalHeight=400; t.resize(); assert.equal(t.activity.style.top,'340px');
  t.fire(t.activity.handle,'keydown',{key:'ArrowUp'});
  t.activity.naturalHeight=500; t.resize(); assert.equal(t.activity.style.top,'316px');
});
