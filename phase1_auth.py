"""Fail-closed authentication boundary for a test-only, read-only prototype."""
from dataclasses import dataclass, field
from secrets import token_urlsafe
from urllib.parse import urlparse
from uuid import UUID
import httpx

from supabase import ClientOptions, create_client

ALLOWED_TEST_HOSTS = frozenset({"sicipmngqimzpwwvumyy.supabase.co"})


@dataclass(frozen=True)
class TestConfig:
    url: str
    publishable_key: str = field(repr=False)
    owner_id: str

    def validate(self):
        parsed = urlparse(self.url)
        if (parsed.scheme != "https" or not parsed.hostname or
                not parsed.hostname.endswith(".supabase.co") or
                parsed.username or parsed.password or parsed.port or
                parsed.path not in ("", "/") or parsed.query or parsed.fragment or
                parsed.hostname not in ALLOWED_TEST_HOSTS):
            raise ValueError("本番以外の検証用Supabase URLを設定してください。")
        if not self.publishable_key.startswith("sb_publishable_"):
            raise ValueError("検証用のpublishableキーだけを使用できます。")
        UUID(self.owner_id)


class AuthDenied(Exception):
    """Always contains a safe message, never an upstream error or credentials."""


class SessionGate:
    """One instance per Streamlit session. No shared client or token cache."""
    def __init__(self, config, factory=create_client):
        config.validate()
        self.config = config
        self.nonce = token_urlsafe(32)
        self._factory = factory
        self._client = None
        self._transport = None
        self._token = None
        self._last_sequence = -1
        self._last_payload = None

    def clear(self):
        if self._transport is not None:
            self._transport.close()
        self._transport = None
        self._client = None
        self._token = None

    def verify(self, message):
        # A previously verified session never authorizes a failed/new attempt.
        self.clear()
        if not isinstance(message, dict) or set(message) != {"nonce", "sequence", "status", "access_token"}:
            raise AuthDenied("認証の復元を待っています。")
        sequence = message["sequence"]
        if (message["nonce"] != self.nonce or type(sequence) is not int or sequence < 0 or
                sequence < self._last_sequence or
                (sequence == self._last_sequence and message != self._last_payload)):
            raise AuthDenied("認証情報を再確認してください。")
        self._last_sequence = sequence
        self._last_payload = dict(message)
        token = message["access_token"]
        if message["status"] != "ready" or not isinstance(token, str) or not 1 <= len(token) <= 16384:
            raise AuthDenied("未ログイン、または接続を確認中です。")
        try:
            self._transport = httpx.Client(timeout=10)
            client = self._factory(self.config.url, self.config.publishable_key,
                                   options=ClientOptions(auto_refresh_token=False, persist_session=False,
                                                         httpx_client=self._transport))
            response = client.auth.get_user(jwt=token)
            if response.user is None or str(response.user.id) != self.config.owner_id:
                raise ValueError("not owner")
            client.postgrest.auth(token)
        except Exception:
            self.clear()
            raise AuthDenied("本人確認ができませんでした。接続を確認して再ログインしてください。") from None
        self._client, self._token = client, token
        return self.config.owner_id

    def recheck(self):
        # Used before each protected operation; no stale-success fallback.
        if self._last_payload is None:
            self.clear()
            raise AuthDenied("認証が必要です。")
        return self.verify(self._last_payload)
