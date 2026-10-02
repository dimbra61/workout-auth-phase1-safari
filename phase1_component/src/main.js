import {createClient} from '@supabase/supabase-js';
import {AuthBridge,clearProjectStorage} from './bridge.mjs';
import {checkStorage,installSocketProbe} from './probes.mjs';

// This prototype requires same-origin component hosting. Never trust an arbitrary
// embedding page's referrer as a destination for an access token.
const parentOrigin=location.origin;
if(document.referrer && new URL(document.referrer).origin!==parentOrigin) {
  throw new Error('Cross-origin authentication embedding is not supported.');
}
const send=(type,extra={})=>parent.postMessage({isStreamlitMessage:true,type,...extra},parentOrigin);
const ui=id=>document.getElementById(id);
let bridge, client, config, subscription;
let storageBlocked=false;
let socketProbe;
try {socketProbe=installSocketProbe(parent);} catch(_) { /* displayed as unavailable */ }
function renderProbe() {
  if(!socketProbe) {ui('socket-status').textContent='WebSocket計測不可（未合格）';return;}
  const s=socketProbe.snapshot();
  ui('socket-status').textContent=`タブ ${s.tab} / ${s.connected?'接続中':'未接続・未捕捉'} / CLOSE ${s.closes} / OPEN ${s.opens}`;
  ui('socket-events').textContent=s.events.map(e=>`${e.time} ${e.event} 接続${e.id}`).join('\n');
}
setInterval(renderProbe,500);
ui('disconnect').addEventListener('click',()=>{
  if(!socketProbe?.disconnect()) ui('socket-status').textContent='未捕捉です。先にサーバー側で再確認を押してください。';
});
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
  if(storageBlocked) return;
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
  const available=checkStorage(kind=>kind==='localStorage'?localStorage:sessionStorage, args.storage_fault===true);
  storageBlocked=!available.ok;
  ui('storage-status').textContent=storageBlocked ?
    `保存領域を利用できません。認証を停止しました。再ログインが必要です。${args.storage_fault?'（API失敗の模擬）':''} 既存保存情報の削除は確認していません。` : '保存領域の読み書き確認：成功';
  ui('storage-events').textContent=available.results.map(x=>`${x.kind}.${x.operation}: ${x.ok?'OK':'ERROR'}`).join('\n');
  if(storageBlocked) {
    if(bridge) {bridge.closed=true;bridge.block();}
    memory.clear(); remember=false;
    ui('password').value='';ui('remember').checked=false;ui('remember').disabled=true;
    send('streamlit:setComponentValue',{value:{nonce:config.nonce,sequence:nextSequence(),status:'blocked',access_token:null},dataType:'json'});
    ui('status').textContent='保存不可のため未認証です。';
    return;
  }
  ui('remember').disabled=false;
  try {
    remember=localStorage.getItem(`workout.phase1.${new URL(config.url).host}.remember`)==='true';
    ui('remember').checked=remember;
  } catch(_) {remember=false;ui('remember').checked=false;ui('remember').disabled=true;}
  makeClient();
});
ui('login').addEventListener('submit',async event=>{
  event.preventDefault();
  if(storageBlocked || !bridge) {ui('password').value='';return;}
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
const restore=()=>{if(!storageBlocked) bridge?.restore();};
ui('retry').addEventListener('click',restore);
addEventListener('online',restore);
addEventListener('offline',()=>bridge?.block());
addEventListener('pageshow',restore);
addEventListener('focus',restore);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible') restore();});
send('streamlit:componentReady',{apiVersion:1});
send('streamlit:setFrameHeight',{height:850});
