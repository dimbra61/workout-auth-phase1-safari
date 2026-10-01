"""Run separately: streamlit run phase1_app.py. Never reads/writes workouts."""
from pathlib import Path
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

if st.session_state.get("phase1_config") != config:
    st.session_state["phase1_gate"] = SessionGate(config)
    st.session_state["phase1_config"] = config
gate = st.session_state["phase1_gate"]
component = components.declare_component("workout_auth_phase1", path=str(bundle))
message = component(url=config.url, publishable_key=config.publishable_key,
                    nonce=gate.nonce, key="phase1_auth", default=None)
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
    except AuthDenied as error:
        st.error(str(error))
