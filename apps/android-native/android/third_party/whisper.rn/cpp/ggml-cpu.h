#pragma once

#include "ggml.h"
#include "ggml-backend.h"

#ifdef  __cplusplus
extern "C" {
#endif

    // the compute plan that needs to be prepared for wsp_ggml_graph_compute()
    // since https://github.com/ggml-org/ggml/issues/287
    struct wsp_ggml_cplan {
        size_t    work_size; // size of work buffer, calculated by `wsp_ggml_graph_plan()`
        uint8_t * work_data; // work buffer, to be allocated by caller before calling to `wsp_ggml_graph_compute()`

        int n_threads;
        struct wsp_ggml_threadpool * threadpool;

        // abort wsp_ggml_graph_compute when true
        wsp_ggml_abort_callback abort_callback;
        void *              abort_callback_data;
    };

    // numa strategies
    enum wsp_ggml_numa_strategy {
        WSP_GGML_NUMA_STRATEGY_DISABLED   = 0,
        WSP_GGML_NUMA_STRATEGY_DISTRIBUTE = 1,
        WSP_GGML_NUMA_STRATEGY_ISOLATE    = 2,
        WSP_GGML_NUMA_STRATEGY_NUMACTL    = 3,
        WSP_GGML_NUMA_STRATEGY_MIRROR     = 4,
        WSP_GGML_NUMA_STRATEGY_COUNT
    };

    WSP_GGML_BACKEND_API void    wsp_ggml_numa_init(enum wsp_ggml_numa_strategy numa); // call once for better performance on NUMA systems
    WSP_GGML_BACKEND_API bool    wsp_ggml_is_numa(void); // true if init detected that system has >1 NUMA node

    WSP_GGML_BACKEND_API struct wsp_ggml_tensor * wsp_ggml_new_i32(struct wsp_ggml_context * ctx, int32_t value);
    WSP_GGML_BACKEND_API struct wsp_ggml_tensor * wsp_ggml_new_f32(struct wsp_ggml_context * ctx, float value);

    WSP_GGML_BACKEND_API struct wsp_ggml_tensor * wsp_ggml_set_i32 (struct wsp_ggml_tensor * tensor, int32_t value);
    WSP_GGML_BACKEND_API struct wsp_ggml_tensor * wsp_ggml_set_f32 (struct wsp_ggml_tensor * tensor, float value);

    WSP_GGML_BACKEND_API int32_t wsp_ggml_get_i32_1d(const struct wsp_ggml_tensor * tensor, int i);
    WSP_GGML_BACKEND_API void    wsp_ggml_set_i32_1d(const struct wsp_ggml_tensor * tensor, int i, int32_t value);

    WSP_GGML_BACKEND_API int32_t wsp_ggml_get_i32_nd(const struct wsp_ggml_tensor * tensor, int i0, int i1, int i2, int i3);
    WSP_GGML_BACKEND_API void    wsp_ggml_set_i32_nd(const struct wsp_ggml_tensor * tensor, int i0, int i1, int i2, int i3, int32_t value);

    WSP_GGML_BACKEND_API float   wsp_ggml_get_f32_1d(const struct wsp_ggml_tensor * tensor, int i);
    WSP_GGML_BACKEND_API void    wsp_ggml_set_f32_1d(const struct wsp_ggml_tensor * tensor, int i, float value);

    WSP_GGML_BACKEND_API float   wsp_ggml_get_f32_nd(const struct wsp_ggml_tensor * tensor, int i0, int i1, int i2, int i3);
    WSP_GGML_BACKEND_API void    wsp_ggml_set_f32_nd(const struct wsp_ggml_tensor * tensor, int i0, int i1, int i2, int i3, float value);

    WSP_GGML_BACKEND_API struct wsp_ggml_threadpool *      wsp_ggml_threadpool_new           (struct wsp_ggml_threadpool_params  * params);
    WSP_GGML_BACKEND_API void                          wsp_ggml_threadpool_free          (struct wsp_ggml_threadpool * threadpool);
    WSP_GGML_BACKEND_API int                           wsp_ggml_threadpool_get_n_threads (struct wsp_ggml_threadpool * threadpool);
    WSP_GGML_BACKEND_API void                          wsp_ggml_threadpool_pause         (struct wsp_ggml_threadpool * threadpool);
    WSP_GGML_BACKEND_API void                          wsp_ggml_threadpool_resume        (struct wsp_ggml_threadpool * threadpool);

    // wsp_ggml_graph_plan() has to be called before wsp_ggml_graph_compute()
    // when plan.work_size > 0, caller must allocate memory for plan.work_data
    WSP_GGML_BACKEND_API struct wsp_ggml_cplan wsp_ggml_graph_plan(
                  const struct wsp_ggml_cgraph * cgraph,
                                       int   n_threads, /* = WSP_GGML_DEFAULT_N_THREADS */
                    struct wsp_ggml_threadpool * threadpool /* = NULL */ );
    WSP_GGML_BACKEND_API enum wsp_ggml_status  wsp_ggml_graph_compute(struct wsp_ggml_cgraph * cgraph, struct wsp_ggml_cplan * cplan);

    // same as wsp_ggml_graph_compute() but the work data is allocated as a part of the context
    // note: the drawback of this API is that you must have ensured that the context has enough memory for the work data
    WSP_GGML_BACKEND_API enum wsp_ggml_status  wsp_ggml_graph_compute_with_ctx(struct wsp_ggml_context * ctx, struct wsp_ggml_cgraph * cgraph, int n_threads);

    //
    // system info
    //

    // x86
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_sse3       (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_ssse3      (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_avx        (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_avx_vnni   (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_avx2       (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_bmi2       (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_f16c       (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_fma        (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_avx512     (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_avx512_vbmi(void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_avx512_vnni(void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_avx512_bf16(void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_amx_int8   (void);
    // ARM
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_neon       (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_arm_fma    (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_fp16_va    (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_dotprod    (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_matmul_int8(void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_sve        (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_get_sve_cnt    (void);  // sve vector length in bytes
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_sme        (void);
    // other
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_riscv_v    (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_vsx        (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_vxe        (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_wasm_simd  (void);
    WSP_GGML_BACKEND_API int wsp_ggml_cpu_has_llamafile  (void);

    // Internal types and functions exposed for tests and benchmarks

    typedef void (*wsp_ggml_vec_dot_t)  (int n, float * WSP_GGML_RESTRICT s, size_t bs, const void * WSP_GGML_RESTRICT x, size_t bx,
                                       const void * WSP_GGML_RESTRICT y, size_t by, int nrc);

    struct wsp_ggml_type_traits_cpu {
        wsp_ggml_from_float_t        from_float;
        wsp_ggml_vec_dot_t           vec_dot;
        enum wsp_ggml_type           vec_dot_type;
        int64_t                  nrows; // number of rows to process simultaneously
    };

    WSP_GGML_BACKEND_API const struct wsp_ggml_type_traits_cpu * wsp_ggml_get_type_traits_cpu(enum wsp_ggml_type type);

    WSP_GGML_BACKEND_API void wsp_ggml_cpu_init(void);

    //
    // CPU backend
    //

    WSP_GGML_BACKEND_API wsp_ggml_backend_t wsp_ggml_backend_cpu_init(void);

    WSP_GGML_BACKEND_API bool wsp_ggml_backend_is_cpu                (wsp_ggml_backend_t backend);
    WSP_GGML_BACKEND_API void wsp_ggml_backend_cpu_set_n_threads     (wsp_ggml_backend_t backend_cpu, int n_threads);
    WSP_GGML_BACKEND_API void wsp_ggml_backend_cpu_set_threadpool    (wsp_ggml_backend_t backend_cpu, wsp_ggml_threadpool_t threadpool);
    WSP_GGML_BACKEND_API void wsp_ggml_backend_cpu_set_abort_callback(wsp_ggml_backend_t backend_cpu, wsp_ggml_abort_callback abort_callback, void * abort_callback_data);

    WSP_GGML_BACKEND_API wsp_ggml_backend_reg_t wsp_ggml_backend_cpu_reg(void);

    WSP_GGML_BACKEND_API void wsp_ggml_cpu_fp32_to_fp32(const float *,       float *, int64_t);
    WSP_GGML_BACKEND_API void wsp_ggml_cpu_fp32_to_i32 (const float *,     int32_t *, int64_t);
    WSP_GGML_BACKEND_API void wsp_ggml_cpu_fp32_to_fp16(const float *, wsp_ggml_fp16_t *, int64_t);
    WSP_GGML_BACKEND_API void wsp_ggml_cpu_fp16_to_fp32(const wsp_ggml_fp16_t *, float *, int64_t);
    WSP_GGML_BACKEND_API void wsp_ggml_cpu_fp32_to_bf16(const float *, wsp_ggml_bf16_t *, int64_t);
    WSP_GGML_BACKEND_API void wsp_ggml_cpu_bf16_to_fp32(const wsp_ggml_bf16_t *, float *, int64_t);

#ifdef __cplusplus
}
#endif
