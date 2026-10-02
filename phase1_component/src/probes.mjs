// Test-only probes. Never inspect WebSocket payloads, protocols or credentials.
export function checkStorage(getStorage, fail=false) {
  const operations=['setItem','getItem','removeItem'];
  const results=[];
  for(const kind of ['localStorage','sessionStorage']) {
    const key='phase1.availability.probe';
    for(const operation of operations) {
      try {
        const storage=getStorage(kind);
        if(fail) throw new Error('simulated storage unavailable');
        if(operation==='setItem') storage.setItem(key,'probe');
        else if(operation==='getItem') {if(storage.getItem(key)!=='probe') throw Error('unavailable');}
        else storage.removeItem(key);
        results.push({kind,operation,ok:true});
      } catch (_) {results.push({kind,operation,ok:false});}
    }
  }
  return {ok:results.every(x=>x.ok),results};
}

export function installSocketProbe(host) {
  if(host.__phase1SocketProbe) return host.__phase1SocketProbe;
  const Native=host.WebSocket;
  const state={tab:host.crypto.randomUUID().slice(0,8), events:[], socket:null,
    connected:false, closes:0, opens:0, serial:0};
  const tracked=new WeakSet();
  const record=(event,id)=>{
    state.events.push({event,id,time:new Date().toISOString()});
    state.events=state.events.slice(-12);
  };
  const observe=socket=>{
    const url=new URL(socket.url);
    if(url.host!==host.location.host || !url.pathname.endsWith('/_stcore/stream') || tracked.has(socket)) return;
    tracked.add(socket); const id=++state.serial;
    state.socket=socket;
    if(socket.readyState===1) {state.connected=true;record('ATTACHED_OPEN',id);}
    socket.addEventListener('open',()=>{state.socket=socket;state.connected=true;state.opens++;record('OPEN',id);});
    socket.addEventListener('close',()=>{
      if(state.socket===socket) state.connected=false;
      state.closes++;record('CLOSE',id);
    });
  };
  const send=Native.prototype.send;
  Native.prototype.send=function(...args){observe(this);return Reflect.apply(send,this,args);};
  host.WebSocket=new Proxy(Native,{construct(target,args,newTarget){
    const socket=Reflect.construct(target,args,newTarget); observe(socket); return socket;
  }});
  const probe={
    snapshot:()=>({tab:state.tab,connected:state.connected,closes:state.closes,opens:state.opens,events:state.events.slice()}),
    disconnect:()=>{
      if(!state.socket || state.socket.readyState!==1) return false;
      state.socket.close(4001,'phase1-test'); return true;
    }
  };
  host.__phase1SocketProbe=probe;
  return probe;
}
