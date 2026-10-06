/* RN-compatible Argon2id, using its pinned, symbol-prefixed OpenSSL build. */
#include "quickcrypto_openssl_prefix.h"
#include "CMindwtrArgon2.h"
#include <openssl/core_names.h>
#include <openssl/crypto.h>
#include <openssl/err.h>
#include <openssl/kdf.h>
#include <openssl/params.h>
#include <openssl/provider.h>
#include <openssl/thread.h>

int mindwtr_argon2id(const uint8_t *pass, size_t pass_len,
                    const uint8_t *salt, size_t salt_len,
                    uint32_t m_kib, uint32_t passes, uint32_t lanes,
                    uint8_t *out, size_t out_len) {
    /* Bounds precede allocations. Never truncate or reinterpret bytes. */
    if (out == NULL || out_len < 4 || out_len > 64) {
        return MINDWTR_ARGON2_INVALID;
    }
    OPENSSL_cleanse(out, out_len);
    if ((pass == NULL && pass_len != 0) || pass_len > 65536 ||
        salt == NULL || salt_len < 8 || salt_len > 64 ||
        lanes < 1 || lanes > 8 || passes < 1 || passes > 16 ||
        m_kib < 8 * lanes || m_kib > 262144) {
        return MINDWTR_ARGON2_INVALID;
    }

    int status = MINDWTR_ARGON2_UNAVAILABLE;
    OSSL_LIB_CTX *library = NULL;
    OSSL_PROVIDER *provider = NULL;
    EVP_KDF *kdf = NULL;
    EVP_KDF_CTX *context = NULL;
    uint32_t version = 0x13;
    unsigned char empty = 0;

    ERR_clear_error();
    /* No external configuration/provider path is loaded here. */
    if (OPENSSL_init_crypto(OPENSSL_INIT_NO_LOAD_CONFIG, NULL) != 1) {
        goto done;
    }
    library = OSSL_LIB_CTX_new();
    if (library == NULL) { goto done; }
    provider = OSSL_PROVIDER_load(library, "default");
    if (provider == NULL) { goto done; }

    /* Matches RN ncrypto.cpp:2081-2083 and its explicit threads/lanes fields. */
    if (lanes > 1 && OSSL_set_max_threads(library, lanes) != 1) { goto done; }
    kdf = EVP_KDF_fetch(library, "ARGON2ID", "provider=default");
    if (kdf == NULL) { goto done; }
    context = EVP_KDF_CTX_new(kdf);
    if (context == NULL) { goto done; }

    OSSL_PARAM params[] = {
        OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_PASSWORD,
            (void *)(pass_len != 0 ? pass : &empty), pass_len),
        OSSL_PARAM_construct_octet_string(OSSL_KDF_PARAM_SALT,
            (void *)salt, salt_len),
        OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_THREADS, &lanes),
        OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_ARGON2_LANES, &lanes),
        OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_ARGON2_MEMCOST, &m_kib),
        OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_ITER, &passes),
        /* RN uses OpenSSL's v1.3 default; sync fixes it explicitly. */
        OSSL_PARAM_construct_uint32(OSSL_KDF_PARAM_ARGON2_VERSION, &version),
        OSSL_PARAM_construct_end()
    };
    if (EVP_KDF_derive(context, out, out_len, params) == 1) {
        status = MINDWTR_ARGON2_OK;
    }

done:
    EVP_KDF_CTX_free(context);
    EVP_KDF_free(kdf);
    if (provider != NULL) { OSSL_PROVIDER_unload(provider); }
    OSSL_LIB_CTX_free(library);
    ERR_clear_error();
    if (status != MINDWTR_ARGON2_OK) { OPENSSL_cleanse(out, out_len); }
    return status;
}
