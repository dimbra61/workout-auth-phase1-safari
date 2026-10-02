"""Run separately: streamlit run phase1_app.py. Never reads/writes workouts."""
from pathlib import Path
from uuid import uuid4
from datetime import datetime, timezone
import streamlit as st
import streamlit.components.v1 as components
from phase1_auth import AuthDenied, SessionGate, TestConfig

st.set_page_config(page_title="認証試作・検証専用", page_icon="🔐")
st.title("🔐 認証・復元の検証")
st.caption("検証環境専用です。トレーニング記録の読取り・保存は行いません。")

try:
    values = st.secrets["phase1"]
    config = TestConfig(values["url"], values["publishable_key"], values["owner_id"])
    config.validate()
except Exception:
    st.error("検証環境の設定が必要です。本番の接続設定は使用できません。")
    st.stop()

bundle = Path(__file__).parent / "phase1_component" / "dist"
if not (bundle / "bundle.js").is_file():
    st.error("認証コンポーネントのビルドが未完了です。検証手順に従って準備してください。")
    st.stop()

fault = st.toggle("Storage API失敗を模擬（検証用）", key="storage_fault")
st.caption("検証版 diagnostics-v1。表示する識別子は試験用で、認証情報ではありません。")
if "probe_session" not in st.session_state:
    st.session_state["probe_session"] = uuid4().hex[:8]
    st.session_state["probe_operations"] = 0
st.write("サーバー試験セッション：", st.session_state["probe_session"])
st.write("確認操作回数：", st.session_state["probe_operations"])
if (st.session_state.get("phase1_config") != config or
        st.session_state.get("previous_fault") != fault):
    if "phase1_gate" in st.session_state:
        st.session_state["phase1_gate"].clear()
    st.session_state["previous_fault"] = fault
    st.session_state["phase1_gate"] = SessionGate(config)
    st.session_state["phase1_config"] = config
gate = st.session_state["phase1_gate"]
component = components.declare_component("workout_auth_phase1", path=str(bundle))
message = component(url=config.url, publishable_key=config.publishable_key,
                    nonce=gate.nonce, storage_fault=fault, key="phase1_auth", default=None)
if fault:
    gate.clear()
    st.warning("Storage失敗試験中：サーバー側も未認証です。認証操作は停止しています。")
    st.stop()
try:
    gate.verify(message)
except AuthDenied as error:
    st.info(str(error))
    st.stop()
st.success("サーバー側で本人確認ができました。")
if st.button("サーバー側で再確認"):
    try:
        gate.recheck()
        st.success("本人確認が成功しました。DBへの操作はしていません。")
        st.write("確認時刻（UTC）：", datetime.now(timezone.utc).isoformat())
    except AuthDenied as error:
        st.error(str(error))

if st.button("確認操作を1回記録（DB操作なし）"):
    try:
        gate.recheck()
        st.session_state["probe_operations"] += 1
        st.rerun()
    except AuthDenied as error:
        st.error(str(error))
