import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {AuthBridge,clearProjectStorage} from '../src/bridge.mjs';
const source=fs.readFileSync(new URL('../src/main.js',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,'');
function harness(referrer='https://test-app.example/') {
  const listeners={}, sent=[], clients=[];
  const parent={postMessage:(value,target)=>sent.push({value,target})};
  const elements=new Map();
  const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};
  const context=vm.createContext({AuthBridge,clearProjectStorage,URL,Date,Map,Object,Number,Error,setTimeout,
    navigator:{onLine:true},parent,location:{origin:'https://test-app.example'},
    localStorage:storage(),sessionStorage:storage(),
    addEventListener:(type,fn)=>listeners[type]=fn,
    document:{referrer,visibilityState:'visible',
      addEventListener:(type,fn)=>listeners[type]=fn,
      getElementById:id=>{if(!elements.has(id))elements.set(id,{addEventListener(){},value:'',checked:false});return elements.get(id);}},
    createClient:(...args)=>{clients.push(args);return {auth:{getSession:async()=>({data:{session:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),stopAutoRefresh(){}}};}
  });
  vm.runInContext(source,context);
  return {listeners,sent,clients,parent};
}
test('bridge accepts render only from the actual parent and exact origin',()=>{
  const h=harness(),data={type:'streamlit:render',args:{nonce:'n',url:'https://test.supabase.co',publishable_key:'sb_publishable_test'}};
  h.listeners.message({source:{},origin:'https://test-app.example',data});
  h.listeners.message({source:h.parent,origin:'https://evil.example',data});
  assert.equal(h.clients.length,0);
  h.listeners.message({source:h.parent,origin:'https://test-app.example',data});
  assert.equal(h.clients.length,1);
  assert.ok(h.sent.every(x=>x.target==='https://test-app.example'));
});
test('new server nonce restarts only this component; same rerun does not loop',()=>{
  const h=harness(),render=nonce=>h.listeners.message({source:h.parent,origin:'https://test-app.example',data:{type:'streamlit:render',args:{nonce,url:'https://test.supabase.co',publishable_key:'sb_publishable_test'}}});
  render('one');render('one');assert.equal(h.clients.length,1);
  render('two');assert.equal(h.clients.length,2);
});
test('cross-origin embedding is refused before any SDK client is created',()=>{
  assert.throws(()=>harness('https://evil.example/'),/Cross-origin/);
});
