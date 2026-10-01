import test from 'node:test';
import assert from 'node:assert/strict';
import {AuthBridge,clearProjectStorage} from '../src/bridge.mjs';

function fixture(session={access_token:'access',refresh_token:'never-emit',expires_at:100}) {
  let time=0, online=true, seq=0, refreshes=0;
  const events=[];
  const saved={session};
  const auth={
    async getSession(){if(!online) throw Error('offline'); return {data:{session:saved.session}};},
    async refreshSession(){refreshes++;saved.session={...saved.session,access_token:'refreshed',expires_at:time/1000+100};return {data:{session:saved.session}};},
    async signInWithPassword(){return {data:{session:saved.session}};},
    async signOut(){saved.session=null;return {};},
  };
  const create=()=>new AuthBridge({auth,emit:x=>events.push(x),nonce:'server-nonce',nextSequence:()=>++seq,now:()=>time,online:()=>online,schedule:fn=>fn()});
  return {create,events,saved,auth,setTime:x=>time=x,setOnline:x=>online=x,refreshes:()=>refreshes};
}
test('reload reconstructs bridge from SDK storage; refresh token never crosses boundary',async()=>{
  const f=fixture();await f.create().restore();await f.create().restore();
  assert.equal(f.events.length,2);assert.equal(f.events[1].status,'ready');
  assert.deepEqual(Object.keys(f.events[0]).sort(),['access_token','nonce','sequence','status']);
  assert.ok(!JSON.stringify(f.events).includes('never-emit'));
});
test('return after background token expiry refreshes before emitting',async()=>{
  const f=fixture(),b=f.create();await b.restore();f.setTime(200000);await b.restore();
  assert.equal(f.refreshes(),1);assert.equal(f.events.at(-1).access_token,'refreshed');
});
test('offline blocks; reconnect restores without a database replay',async()=>{
  const f=fixture(),b=f.create();await b.restore();f.setOnline(false);await b.restore();
  assert.equal(f.events.at(-1).status,'blocked');assert.equal(f.events.at(-1).access_token,null);
  f.setOnline(true);await b.restore();assert.equal(f.events.at(-1).status,'ready');
});
test('concurrent wakeups use one pending restore',async()=>{
  const f=fixture(),b=f.create();f.setTime(200000);
  await Promise.all([b.restore(),b.restore(),b.restore()]);assert.equal(f.refreshes(),1);
});
test('logout invalidates an in-flight restore',async()=>{
  const f=fixture(),b=f.create();let finish;
  f.auth.getSession=()=>new Promise(r=>finish=r);
  const pending=b.restore();await b.logout();finish({data:{session:{access_token:'old',expires_at:100}}});await pending;
  assert.ok(!f.events.some(e=>e.status==='ready'));
  await b.restore();assert.equal(f.events.at(-1).status,'blocked');
});
test('refresh failure never reuses expired access token',async()=>{
  const f=fixture(),b=f.create();f.setTime(200000);f.auth.refreshSession=async()=>({error:new Error('secret')});
  await b.restore();assert.equal(f.events.at(-1).status,'blocked');assert.ok(!JSON.stringify(f.events).includes('secret'));
});
test('missing saved session is signed out',async()=>{
  const f=fixture(null);await f.create().restore();assert.equal(f.events.at(-1).status,'signed_out');
});
test('storage deletion failure is not reported as a successful logout',()=>{
  const storage={'workout.phase1.test':'token',removeItem(){throw Error('blocked');},getItem(){return 'token';}};
  assert.equal(clearProjectStorage(storage,'workout.phase1.test'),false);
});
test('logout clears only this project storage and verifies removal',()=>{
  const storage={'workout.phase1.test':'token','unrelated':'value',removeItem(key){delete this[key];},getItem(key){return this[key]??null;}};
  assert.equal(clearProjectStorage(storage,'workout.phase1.test'),true);
  assert.equal(storage.unrelated,'value');
});
