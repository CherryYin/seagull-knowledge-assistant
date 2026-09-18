"""Tests for pkg.services.cross_cutting.auth — pure crypto functions."""

import time

import pytest
from jose import jwt

from pkg.services.cross_cutting.auth import (
    create_access_token,
    decode_token,
    hash_password,
    verify_password,
)
from pkg.config import settings


# ---------------------------------------------------------------------------
# hash_password / verify_password
# ---------------------------------------------------------------------------
class TestPasswordHashing:
    def test_hash_and_verify(self):
        hashed = hash_password("secret123")
        assert hashed != "secret123"
        assert verify_password("secret123", hashed)

    def test_wrong_password_fails(self):
        hashed = hash_password("secret123")
        assert not verify_password("wrong", hashed)

    def test_different_salts(self):
        h1 = hash_password("same")
        h2 = hash_password("same")
        assert h1 != h2  # bcrypt uses random salt
        assert verify_password("same", h1)
        assert verify_password("same", h2)

    def test_empty_password(self):
        hashed = hash_password("")
        assert verify_password("", hashed)
        assert not verify_password("notempty", hashed)

    def test_unicode_password(self):
        hashed = hash_password("密码测试")
        assert verify_password("密码测试", hashed)
        assert not verify_password("wrong", hashed)


# ---------------------------------------------------------------------------
# JWT create / decode
# ---------------------------------------------------------------------------
class TestJWT:
    def test_create_and_decode(self):
        token = create_access_token("user-1", "admin")
        payload = decode_token(token)
        assert payload["sub"] == "user-1"
        assert payload["role"] == "admin"
        assert "exp" in payload

    def test_different_users(self):
        t1 = create_access_token("user-1", "user")
        t2 = create_access_token("user-2", "admin")
        p1 = decode_token(t1)
        p2 = decode_token(t2)
        assert p1["sub"] == "user-1"
        assert p2["sub"] == "user-2"
        assert p1["role"] == "user"
        assert p2["role"] == "admin"

    def test_invalid_token_raises(self):
        from jose import JWTError
        with pytest.raises(JWTError):
            decode_token("not.a.valid.token")

    def test_tampered_token_raises(self):
        from jose import JWTError
        token = create_access_token("user-1", "user")
        # Flip a character in the payload
        parts = token.split(".")
        parts[1] = parts[1][:-1] + ("A" if parts[1][-1] != "A" else "B")
        tampered = ".".join(parts)
        with pytest.raises(JWTError):
            decode_token(tampered)

    def test_token_contains_expiry(self):
        token = create_access_token("user-1", "user")
        payload = decode_token(token)
        # Expiry should be in the future
        assert payload["exp"] > time.time()
