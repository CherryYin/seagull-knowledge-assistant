from __future__ import annotations

import base64
import binascii
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from pkg.config import settings


class CredentialsCryptoError(RuntimeError):
    """Raised when credential encryption or decryption fails."""


class CredentialsCryptoConfigError(CredentialsCryptoError):
    """Raised when credential crypto is not configured correctly."""


class CredentialsCryptoValueError(CredentialsCryptoError):
    """Raised when an input secret or ciphertext is invalid."""


def _normalized_plaintext(value: str) -> str:
    normalized = value.strip()
    if not normalized:
        raise CredentialsCryptoValueError("Secret must not be empty")
    return normalized


def _derive_fernet_key(raw_key: str) -> bytes:
    normalized = raw_key.strip()
    if not normalized:
        raise CredentialsCryptoConfigError("CREDENTIAL_ENCRYPTION_KEY is not configured")
    try:
        decoded = base64.urlsafe_b64decode(normalized.encode("utf-8"))
        if len(decoded) == 32:
            return normalized.encode("utf-8")
    except (binascii.Error, ValueError):
        pass
    digest = hashlib.sha256(normalized.encode("utf-8")).digest()
    return base64.urlsafe_b64encode(digest)


def _fernet() -> Fernet:
    return Fernet(_derive_fernet_key(settings.CREDENTIAL_ENCRYPTION_KEY))


def encrypt_secret(plaintext: str) -> str:
    normalized = _normalized_plaintext(plaintext)
    token = _fernet().encrypt(normalized.encode("utf-8"))
    return token.decode("utf-8")


def decrypt_secret(ciphertext: str) -> str:
    token = ciphertext.strip()
    if not token:
        raise CredentialsCryptoValueError("Ciphertext must not be empty")
    try:
        return _fernet().decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        raise CredentialsCryptoValueError("Credential ciphertext is invalid") from exc


def mask_secret(plaintext: str) -> str:
    normalized = _normalized_plaintext(plaintext)
    if len(normalized) <= 4:
        return "*" * len(normalized)
    visible = normalized[-4:]
    hidden = max(len(normalized) - 4, 4)
    return f"{'*' * hidden}{visible}"
