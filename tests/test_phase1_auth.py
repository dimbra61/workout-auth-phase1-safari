import json
from types import SimpleNamespace
from unittest.mock import Mock

import httpx
import pytest
from supabase import create_client
from phase1_auth import AuthDenied, SessionGate, TestConfig as Config

OWNER = '11111111-1111-4111-8111-111111111111'
OTHER = '22222222-2222-4222-8222-222222222222'


def cfg(**overrides):
    return Config(**dict(dict(url='https://sicipmngqimzpwwvumyy.supabase.co', publishable_key='sb_publishable_test', owner_id=OWNER), **overrides))


def message(gate, token='valid', seq=1, status='ready'):
    return dict(nonce=gate.nonce, sequence=seq, status=status, access_token=token)


def fake_factory(owner=OWNER):
    clients=[]
    def factory(url, key, options):
        assert options.persist_session is False and options.auto_refresh_token is False
        client=SimpleNamespace(auth=SimpleNamespace(get_user=Mock(return_value=SimpleNamespace(user=SimpleNamespace(id=owner)))),postgrest=SimpleNamespace(auth=Mock()))
        clients.append(client)
        return client
    return factory, clients


def test_isolated_clients_and_nonces():
    factory, clients=fake_factory()
    a,b=SessionGate(cfg(),factory),SessionGate(cfg(),factory)
    a.verify(message(a,'one')); b.verify(message(b,'two'))
    assert a.nonce != b.nonce and a._client is not b._client
    clients[0].auth.get_user.assert_called_once_with(jwt='one')
    clients[1].postgrest.auth.assert_called_once_with('two')
    assert a._client.auth.get_user.call_count==1


@pytest.mark.parametrize('change',[
    {'nonce':'wrong'}, {'sequence':-1}, {'sequence':True}, {'status':'blocked'},
    {'access_token':''}, {'refresh_token':'DO_NOT_ACCEPT'}, {'user_id':OWNER}, {'password':'never'},
])
def test_bad_bridge_messages_fail_closed(change):
    factory,_=fake_factory(); gate=SessionGate(cfg(),factory)
    gate.verify(message(gate))
    with pytest.raises(AuthDenied): gate.verify(dict(message(gate,seq=2), **change))
    assert gate._client is None and gate._token is None


def test_other_user_denied_even_if_browser_claims_ready():
    factory,_=fake_factory(OTHER); gate=SessionGate(cfg(),factory)
    with pytest.raises(AuthDenied): gate.verify(message(gate))
    assert gate._client is None


def test_stale_event_cannot_restore_after_logout():
    factory,_=fake_factory(); gate=SessionGate(cfg(),factory)
    ready=message(gate)
    gate.verify(ready)
    with pytest.raises(AuthDenied): gate.verify(message(gate,None,2,'blocked'))
    with pytest.raises(AuthDenied): gate.verify(ready)
    assert gate._client is None


@pytest.mark.parametrize('url',[
    'https://not-allowlisted.supabase.co', 'http://test.supabase.co',
    'https://evil.example', 'https://test.supabase.co/path', 'https://user@test.supabase.co',
])
def test_reject_production_and_unsafe_urls(url):
    with pytest.raises(ValueError): SessionGate(cfg(url=url))


def test_secret_key_rejected_before_client_created():
    with pytest.raises(ValueError): SessionGate(cfg(publishable_key='sb_secret_do_not_use'))


def test_real_python_sdk_verifies_remote_response_and_recovers():
    mode=['ok']; calls=[]
    def handler(request):
        calls.append(request)
        assert request.url.path=='/auth/v1/user'
        assert request.headers['authorization']=='Bearer access-only'
        if mode[0]=='offline': raise httpx.ConnectError('SECRET error details',request=request)
        if mode[0]=='expired': return httpx.Response(401,json={'message':'expired token','code':'bad_jwt'})
        return httpx.Response(200,json={'id':OWNER,'aud':'authenticated','role':'authenticated','created_at':'2026-01-01T00:00:00Z','app_metadata':{},'user_metadata':{}})
    def factory(url,key,options):
        options.httpx_client=httpx.Client(transport=httpx.MockTransport(handler))
        return create_client(url,key,options=options)
    gate=SessionGate(cfg(),factory)
    assert gate.verify(message(gate,'access-only'))==OWNER
    for failure in ['expired','offline']:
        mode[0]=failure
        with pytest.raises(AuthDenied) as error: gate.recheck()
        assert 'SECRET' not in str(error.value)
        assert gate._client is None
    mode[0]='ok'
    assert gate.verify(message(gate,'access-only',2))==OWNER
    assert len(calls)==4


def test_fresh_server_session_rejects_old_bridge_nonce():
    factory,_=fake_factory(); old=SessionGate(cfg(),factory); new=SessionGate(cfg(),factory)
    with pytest.raises(AuthDenied): new.verify(message(old))
    assert new.verify(message(new))==OWNER


def test_prototype_app_rejects_production_before_network():
    from streamlit.testing.v1 import AppTest
    from pathlib import Path
    at=AppTest.from_file(str(Path(__file__).parents[1]/'phase1_app.py'))
    at.secrets['phase1']={'url':'https://not-allowlisted.supabase.co','publishable_key':'sb_publishable_test','owner_id':OWNER}
    at.run()
    assert not at.exception
    assert any('本番の接続設定は使用できません' in e.value for e in at.error)


def test_storage_fault_forces_server_unauthenticated():
    from streamlit.testing.v1 import AppTest
    from pathlib import Path
    at=AppTest.from_file(str(Path(__file__).parents[1]/'phase1_app.py'))
    at.secrets['phase1']={'url':'https://sicipmngqimzpwwvumyy.supabase.co','publishable_key':'sb_publishable_test','owner_id':OWNER}
    at.run()
    at.toggle[0].set_value(True).run()
    assert not at.exception
    assert any('サーバー側も未認証' in w.value for w in at.warning)
    assert len(at.success)==0
    assert at.session_state['phase1_gate']._client is None
    assert at.session_state['probe_operations']==0
