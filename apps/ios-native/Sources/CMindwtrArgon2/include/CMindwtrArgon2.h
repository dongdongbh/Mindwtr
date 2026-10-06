#ifndef MINDWTR_ARGON2_H
#define MINDWTR_ARGON2_H

#include <stddef.h>
#include <stdint.h>

/* No OpenSSL declarations cross this byte-oriented boundary. */
enum {
    MINDWTR_ARGON2_INVALID = 0,
    MINDWTR_ARGON2_OK = 1,
    MINDWTR_ARGON2_UNAVAILABLE = -1
};

int mindwtr_argon2id(const uint8_t *pass, size_t pass_len,
                    const uint8_t *salt, size_t salt_len,
                    uint32_t m_kib, uint32_t passes, uint32_t lanes,
                    uint8_t *out, size_t out_len);

#endif
