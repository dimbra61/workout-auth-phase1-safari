import {createClient} from '@supabase/supabase-js';
import {AuthBridge,clearProjectStorage} from './bridge.mjs';

// This prototype requires same-origin component hosting. Never trust an arbitrary
// embedding page's referrer as a destination for an access token.
const parentOrigin=location.origin;
if(document.referrer && new URL(document.referrer).origin!==parentOrigin) {
  throw new Error('Cross-origin authentication embedding is not supported.');
}
const send=(type,extra={})=>parent.postMessage({isStreamlitMessage:true,type,...extra},parentOrigin);
const ui=id=>document.getElementById(id);
let bridge, client, config, subscription;
let sequence=0;
const nextSequence=()=>{
  // Retained across iframe remounts in this browser tab, but not an auth claim.
  try {sequence=Math.max(sequence,Number(sessionStorage.getItem('workout.auth.sequence'))||0);}
  catch (_) {}
  sequence=Math.max(sequence+1,Date.now()*1000);
  try {sessionStorage.setItem('workout.auth.sequence',String(sequence));} catch (_) {}
  return sequence;
};
let memory=new Map();
let remember=false;
const storage={
  getItem(key){return remember ? localStorage.getItem(key) : memory.get(key)??null;},
  setItem(key,value){if(remember) localStorage.setItem(key,value); else memory.set(key,value);},
  removeItem(key){memory.delete(key);try {localStorage.removeItem(key);} catch(_) {if(remember) throw new Error('storage unavailable');}}
};
function erase() {
  memory.clear();
  if(config) {
    return clearProjectStorage(localStorage,`workout.phase1.${new URL(config.url).host}`);
  }
  return true;
}
function makeClient() {
  const key=`workout.phase1.${new URL(config.url).host}`;
  client=createClient(config.url,config.publishable_key,{auth:{storageKey:key,storage,persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  bridge=new AuthBridge({auth:client.auth,nonce:config.nonce,nextSequence,online:()=>navigator.onLine,
    emit:value=>{
      ui('status').textContent=value.status==='ready' ? 'サーバーで本人確認中です。' : '未ログイン、または通信・認証を確認中です。';
      send('streamlit:setComponentValue',{value,dataType:'json'});
    }});
  subscription=client.auth.onAuthStateChange(event=>bridge.onAuth(event)).data.subscription;
  bridge.restore();
}
addEventListener('message',event=>{
  if(event.source!==parent || event.origin!==parentOrigin || event.data?.type!=='streamlit:render') return;
  const args=event.data.args;
  if(!args || typeof args.nonce!=='string') return;
  if(config?.nonce===args.nonce) return;
  if(bridge) {bridge.closed=true;subscription?.unsubscribe();client.auth.stopAutoRefresh();}
  config=args;
  try {
    remember=localStorage.getItem(`workout.phase1.${new URL(config.url).host}.remember`)==='true';
    ui('remember').checked=remember;
  } catch(_) {remember=false;ui('remember').checked=false;ui('remember').disabled=true;}
  makeClient();
});
ui('login').addEventListener('submit',async event=>{
  event.preventDefault();
  if(!bridge) return;
  const password=ui('password').value;ui('password').value='';
  try {
    if(bridge.closed) makeClient();
    remember=ui('remember').checked;
    const key=`workout.phase1.${new URL(config.url).host}.remember`;
    if(remember) localStorage.setItem(key,'true'); else if(!erase()) throw new Error('storage removal unconfirmed');
    await bridge.login(ui('email').value,password);
  } catch(_) {ui('status').textContent='ログインできませんでした。入力と接続を確認してください。';}
});
ui('logout').addEventListener('click',async()=>{
  if(!bridge) return;
  let revoked=true;
  try {await bridge.logout();} catch(_){revoked=false;}
  client.auth.stopAutoRefresh();subscription?.unsubscribe();
  const cleared=erase();ui('remember').checked=false;remember=false;
  ui('status').textContent=!cleared ? '保存情報の削除を確認できません。ブラウザのサイトデータを削除し、通信復旧後にセッションを確認してください。' :
    revoked ? 'ログアウトしました。' : '端末の保存情報は削除しました。通信復旧後、再ログインしてサーバー側のセッションを確認してください。';
});
const restore=()=>bridge?.restore();
ui('retry').addEventListener('click',restore);
addEventListener('online',restore);
addEventListener('offline',()=>bridge?.block());
addEventListener('pageshow',restore);
addEventListener('focus',restore);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible') restore();});
send('streamlit:componentReady',{apiVersion:1});
send('streamlit:setFrameHeight',{height:390});
