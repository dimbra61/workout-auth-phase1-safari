// No SDK session object or refresh token is emitted across the iframe boundary.
export class AuthBridge {
  constructor({auth, emit, nonce, nextSequence, now=()=>Date.now(), online=()=>true, schedule=fn=>setTimeout(fn,0)}) {
    Object.assign(this,{auth,emit,nonce,nextSequence,now,online,schedule});
    this.epoch=0; this.pending=null; this.closed=false;
  }
  send(status, token=null) {
    this.emit({nonce:this.nonce,sequence:this.nextSequence(),status,access_token:token});
  }
  block() { this.epoch++; this.send('blocked'); }
  async restore() {
    if(this.closed) return;
    if(!this.online()) { this.block(); return; }
    if(this.pending) return this.pending;
    const epoch=this.epoch;
    const work=async()=>{
      try {
        let {data,error}=await this.auth.getSession();
        if(error) throw error;
        let session=data.session;
        if(session && session.expires_at*1000<=this.now()+5000) {
          const refreshed=await this.auth.refreshSession();
          if(refreshed.error) throw refreshed.error;
          session=refreshed.data.session;
        }
        if(this.closed || epoch!==this.epoch) return;
        if(!session || !Number.isFinite(session.expires_at) || session.expires_at*1000<=this.now()) { this.send('signed_out'); return; }
        this.send('ready', session.access_token);
      } catch (_) {
        if(!this.closed && epoch===this.epoch) this.send('blocked');
      }
    };
    this.pending=work();
    try { await this.pending; } finally { this.pending=null; }
  }
  onAuth(event) {
    if(event==='SIGNED_OUT') { this.block(); return; }
    // Never await SDK calls inside its auth-state callback (lock reentrancy).
    this.schedule(()=>this.restore());
  }
  async login(email,password) {
    this.block();
    const epoch=this.epoch;
    try {
      const result=await this.auth.signInWithPassword({email,password});
      if(result.error) throw result.error;
      if(epoch===this.epoch && !this.closed) await this.restore();
    } catch (_) { if(epoch===this.epoch) this.send('blocked'); throw new Error('ログインできませんでした。'); }
  }
  async logout() {
    this.closed=true; this.block();
    // Caller clears local SDK storage even if remote revocation is unavailable.
    try { const result=await this.auth.signOut({scope:'local'}); if(result.error) throw result.error; }
    catch (_) { throw new Error('サーバー側のログアウトを確認できませんでした。'); }
  }
}

export function clearProjectStorage(storage, prefix) {
  try {
    const keys=Object.keys(storage).filter(key=>key.startsWith(prefix));
    for(const key of keys) storage.removeItem(key);
    return keys.every(key=>storage.getItem(key)===null);
  } catch (_) { return false; }
}
