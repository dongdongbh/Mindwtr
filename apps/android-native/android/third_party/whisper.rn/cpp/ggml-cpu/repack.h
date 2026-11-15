#pragma once

#define WSP_GGML_COMMON_DECL_CPP
#include "ggml-common.h"

#include "traits.h"
#include "ggml.h"

// GGML internal header

wsp_ggml_backend_buffer_type_t wsp_ggml_backend_cpu_repack_buffer_type(void);

template <int K> constexpr int QK_0() {
    if constexpr (K == 4) {
        return QK4_0;
    }
    if constexpr (K == 8) {
        return QK8_0;
    }
    return -1;
}

template <int K, int N> struct block {
    wsp_ggml_half d[N];                         // deltas for N qK_0 blocks
    int8_t    qs[(QK_0<K>() * N * K) / 8];  // quants for N qK_0 blocks
};

// control size
static_assert(sizeof(block<4, 4>) == 4 * sizeof(wsp_ggml_half) + QK8_0 * 2, "wrong block<4,4> size/padding");
static_assert(sizeof(block<4, 8>) == 8 * sizeof(wsp_ggml_half) + QK8_0 * 4, "wrong block<4,8> size/padding");
static_assert(sizeof(block<8, 4>) == 4 * sizeof(wsp_ggml_half) + QK8_0 * 4, "wrong block<8,4> size/padding");
static_assert(sizeof(block<8, 8>) == 8 * sizeof(wsp_ggml_half) + QK8_0 * 8, "wrong block<8,8> size/padding");

using block_q4_0x4 = block<4, 4>;
using block_q4_0x8 = block<4, 8>;
using block_q8_0x4 = block<8, 4>;
using block_q8_0x8 = block<8, 8>;

struct block_q4_Kx8 {
    wsp_ggml_half d[8];      // super-block scale for quantized scales
    wsp_ggml_half dmin[8];   // super-block scale for quantized mins
    uint8_t scales[96];  // scales and mins, quantized with 6 bits
    uint8_t qs[1024];    // 4--bit quants
};

static_assert(sizeof(block_q4_Kx8) == sizeof(wsp_ggml_half) * 16 + K_SCALE_SIZE * 8 + QK_K * 4, "wrong q4_K block size/padding");
struct block_q2_Kx8 {
    wsp_ggml_half d[8];      // super-block scale for quantized scales
    wsp_ggml_half dmin[8];   // super-block scale for quantized mins
    uint8_t scales[128];  // scales and mins, quantized with 4 bits
    uint8_t qs[512];    // 2--bit quants
};

static_assert(sizeof(block_q2_Kx8) == sizeof(wsp_ggml_half) * 16 + QK_K/2 + QK_K * 2, "wrong q2_K block size/padding");
struct block_q8_Kx4 {
    float d[4];              // delta
    int8_t qs[QK_K * 4];     // quants
    int16_t bsums[QK_K / 4]; // sum of quants in groups of 16
};

static_assert(sizeof(block_q8_Kx4) == sizeof(float) * 4 + QK_K * 4 + (QK_K / 4) * sizeof(int16_t), "wrong q8_K block size/padding");

struct block_iq4_nlx4 {
    wsp_ggml_half d[4];            // deltas for 4 iq4_nl blocks
    uint8_t   qs[QK4_NL * 2];  // nibbles / quants for 4 iq4_nl blocks
};

static_assert(sizeof(block_iq4_nlx4) == 4 * sizeof(wsp_ggml_half) + QK4_NL * 2, "wrong iq4_nlx4 block size/padding");

struct block_iq4_nlx8 {
    wsp_ggml_half d[8];            // deltas for 8 iq4_nl blocks
    uint8_t   qs[QK4_NL * 4];  // nibbles / quants for 8 iq4_nl blocks
};

static_assert(sizeof(block_iq4_nlx8) == 8 * sizeof(wsp_ggml_half) + QK4_NL * 4, "wrong iq4_nlx8 block size/padding");

#if defined(__cplusplus)
extern "C" {
#endif

void wsp_ggml_wsp_quantize_mat_q8_0_4x4(const float * WSP_GGML_RESTRICT x, void * WSP_GGML_RESTRICT vy, int64_t k);
void wsp_ggml_wsp_quantize_mat_q8_0_4x8(const float * WSP_GGML_RESTRICT x, void * WSP_GGML_RESTRICT vy, int64_t k);
void wsp_ggml_wsp_quantize_mat_q8_K_4x8(const float * WSP_GGML_RESTRICT x, void * WSP_GGML_RESTRICT vy, int64_t k);
void wsp_ggml_gemv_q4_0_4x4_q8_0(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemv_q4_0_4x8_q8_0(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemv_q4_0_8x8_q8_0(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemv_q4_K_8x8_q8_K(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemv_q2_K_8x8_q8_K(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemv_iq4_nl_4x4_q8_0(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemv_iq4_nl_8x8_q8_0(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemm_q4_0_4x4_q8_0(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemm_q4_0_4x8_q8_0(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemm_q4_0_8x8_q8_0(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemm_q4_K_8x8_q8_K(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemm_q2_K_8x8_q8_K(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemm_iq4_nl_4x4_q8_0(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemm_iq4_nl_8x8_q8_0(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);

// Native implementations
void wsp_ggml_wsp_quantize_mat_q8_0_4x4_generic(const float * WSP_GGML_RESTRICT x, void * WSP_GGML_RESTRICT vy, int64_t k);
void wsp_ggml_wsp_quantize_mat_q8_0_4x8_generic(const float * WSP_GGML_RESTRICT x, void * WSP_GGML_RESTRICT vy, int64_t k);
void wsp_ggml_wsp_quantize_mat_q8_K_4x8_generic(const float * WSP_GGML_RESTRICT x, void * WSP_GGML_RESTRICT vy, int64_t k);
void wsp_ggml_gemv_q4_0_4x4_q8_0_generic(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemv_q4_0_4x8_q8_0_generic(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemv_q4_0_8x8_q8_0_generic(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemv_q4_K_8x8_q8_K_generic(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemv_q2_K_8x8_q8_K_generic(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemv_iq4_nl_4x4_q8_0_generic(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemv_iq4_nl_8x8_q8_0_generic(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemm_q4_0_4x4_q8_0_generic(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemm_q4_0_4x8_q8_0_generic(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemm_q4_0_8x8_q8_0_generic(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemm_q4_K_8x8_q8_K_generic(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemm_q2_K_8x8_q8_K_generic(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemm_iq4_nl_4x4_q8_0_generic(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);
void wsp_ggml_gemm_iq4_nl_8x8_q8_0_generic(int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT vx, const void * WSP_GGML_RESTRICT vy, int nr, int nc);

#if defined(__cplusplus)
} // extern "C"
#endif
