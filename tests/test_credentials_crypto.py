from unittest.mock import patch

import pytest

from pkg.services.cross_cutting.credentials_crypto import (
    CredentialsCryptoConfigError,
    CredentialsCryptoValueError,
    decrypt_secret,
    encrypt_secret,
    mask_secret,
)


def test_encrypt_decrypt_round_trip():
    with patch("pkg.services.cross_cutting.credentials_crypto.settings.CREDENTIAL_ENCRYPTION_KEY", "test-master-key"):
        encrypted = encrypt_secret("secret-value")
        decrypted = decrypt_secret(encrypted)

    assert encrypted != "secret-value"
    assert decrypted == "secret-value"


def test_encrypt_secret_rejects_blank_values():
    with patch("pkg.services.cross_cutting.credentials_crypto.settings.CREDENTIAL_ENCRYPTION_KEY", "test-master-key"):
        with pytest.raises(CredentialsCryptoValueError, match="must not be empty"):
            encrypt_secret("   ")


def test_decrypt_secret_rejects_invalid_ciphertext():
    with patch("pkg.services.cross_cutting.credentials_crypto.settings.CREDENTIAL_ENCRYPTION_KEY", "test-master-key"):
        with pytest.raises(CredentialsCryptoValueError, match="invalid"):
            decrypt_secret("not-a-valid-token")


def test_encrypt_secret_requires_master_key():
    with patch("pkg.services.cross_cutting.credentials_crypto.settings.CREDENTIAL_ENCRYPTION_KEY", ""):
        with pytest.raises(CredentialsCryptoConfigError, match="not configured"):
            encrypt_secret("secret-value")


def test_mask_secret_reveals_only_suffix():
    assert mask_secret("abcdefgh1234") == "********1234"
    assert mask_secret("abcd") == "****"
