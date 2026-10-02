import test from 'node:test';
import assert from 'node:assert/strict';
import {checkStorage,installSocketProbe} from '../src/probes.mjs';

test('storage failures never read or mutate previously stored credentials',()=>{
  let touched=0;
  const result=checkStorage(()=>({getItem(){touched++;},setItem(){touched++;},removeItem(){touched++;}}),true);
  assert.equal(result.ok,false);assert.equal(result.results.length,6);
  assert.ok(result.results.every(x=>!x.ok));assert.equal(touched,0);
});
test('real storage API denial is contained',()=>{
  const result=checkStorage(()=>{throw Error('denied');});
  assert.equal(result.ok,false);assert.equal(result.results.length,6);
});
test('socket probe observes actual stream close/open; does not read or replay data',()=>{
  class Socket {
    constructor(url){this.url=url;this.readyState=0;this.events={};this.sent=0;}
    addEventListener(event,cb){this.events[event]=cb;}
    send(){this.sent++;}
    close(){this.readyState=3;this.events.close?.();}
    open(){this.readyState=1;this.events.open?.();}
  }
  const host={WebSocket:Socket,location:{host:'test.example'},crypto:{randomUUID:()=> 'test-tab-id'}};
  const old=new Socket('wss://test.example/~/+/_stcore/stream');old.open();
  const probe=installSocketProbe(host);
  old.send({get token(){throw Error('must never inspect');}});
  assert.equal(probe.snapshot().connected,true);assert.equal(probe.snapshot().opens,0);
  assert.equal(probe.disconnect(),true);assert.equal(probe.snapshot().closes,1);
  const next=new host.WebSocket('wss://test.example/~/+/_stcore/stream');next.open();
  assert.equal(probe.snapshot().opens,1);assert.equal(next.sent,0);assert.equal(old.sent,1);
  const unrelated=new host.WebSocket('wss://test.example/other');unrelated.open();unrelated.close();
  assert.equal(probe.snapshot().closes,1);assert.equal(installSocketProbe(host),probe);
  assert.deepEqual(probe.snapshot().events.map(e=>e.event),['ATTACHED_OPEN','CLOSE','OPEN']);
});
