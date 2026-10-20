"""Password hashing, login sessions, and encryption of stored API keys."""

from __future__ import annotations

import base64
import hashlib
import hmac
import re
import secrets

from cryptography.fernet import Fernet, InvalidToken

USERNAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,30}$")
MIN_PASSWORD_LENGTH = 8
_SCRYPT = {"n": 2**14, "r": 8, "p": 1}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_hex, digest_hex = stored.split("$")
    except ValueError:
        return False
    if scheme != "scrypt":
        return False
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), **_SCRYPT)
    return hmac.compare_digest(digest.hex(), digest_hex)


# A fixed valid hash, so an unknown user name costs the same time as a wrong password.
DUMMY_HASH = hash_password(secrets.token_urlsafe(16))


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    """Sessions are stored by hash, so a leaked database cannot sign anyone in."""
    return hashlib.sha256(token.encode()).hexdigest()


class SecretBox:
    """Encrypts users' API keys at rest with a key derived from GATEWAY_SECRET_KEY."""

    def __init__(self, secret_key: str) -> None:
        derived = hashlib.sha256(b"dsh-gateway-api-keys:" + secret_key.encode()).digest()
        self._fernet = Fernet(base64.urlsafe_b64encode(derived))

    def encrypt(self, value: str) -> str:
        return self._fernet.encrypt(value.encode()).decode()

    def decrypt(self, value: str) -> str | None:
        """The plaintext, or None when GATEWAY_SECRET_KEY changed since it was stored."""
        try:
            return self._fernet.decrypt(value.encode()).decode()
        except InvalidToken:
            return None


def mask_key(key: str) -> str:
    return f"{key[:3]}…{key[-4:]}" if len(key) > 10 else "…"
