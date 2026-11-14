#define _CRT_SECURE_NO_DEPRECATE // Disables "unsafe" warnings on Windows
#define _USE_MATH_DEFINES // For M_PI on MSVC

#include "ggml-backend-impl.h"
#include "ggml-backend.h"
#include "traits.h"
#include "ggml-cpu-impl.h"
#include "ggml-cpu.h"
#include "ggml-impl.h"
#include "quants.h"
#include "ggml-threading.h"
#include "unary-ops.h"
#include "binary-ops.h"
#include "vec.h"
#include "ops.h"
#include "ggml.h"

#if defined(_MSC_VER) || defined(__MINGW32__)
#include <malloc.h> // using malloc.h with MSC/MINGW
#elif !defined(__FreeBSD__) && !defined(__NetBSD__) && !defined(__OpenBSD__)
#include <alloca.h>
#endif

#include <assert.h>
#include <errno.h>
#include <time.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <inttypes.h>
#include <stdio.h>
#include <float.h>
#include <limits.h>
#include <stdarg.h>
#include <signal.h>
#if defined(__gnu_linux__)
#include <syscall.h>
#endif

#ifdef WSP_GGML_USE_OPENMP
#include <omp.h>
#endif

#if defined(__ARM_FEATURE_SVE) || defined(__ARM_FEATURE_MATMUL_INT8)
#undef WSP_GGML_USE_LLAMAFILE
#endif

#ifdef WSP_GGML_USE_LLAMAFILE
#include "llamafile/sgemm.h"
#endif

// Note: once we move threading into a separate C++ file
// will use std::hardware_destructive_interference_size instead of hardcoding it here
// and we'll use C++ attribute syntax.
#define WSP_GGML_CACHE_LINE  64

#if defined(__clang__) || defined(__GNUC__)
#define WSP_GGML_CACHE_ALIGN __attribute__((aligned(WSP_GGML_CACHE_LINE)))
#endif

#if defined(__has_feature)
#if __has_feature(thread_sanitizer)
#define WSP_GGML_TSAN_ENABLED 1
#endif
#else  // __has_feature
#if defined(__SANITIZE_THREAD__)
#define WSP_GGML_TSAN_ENABLED 1
#endif
#endif // __has_feature

#define UNUSED WSP_GGML_UNUSED
#define SWAP(x, y, T) do { T SWAP = x; (x) = y; (y) = SWAP; } while (0)

// precomputed f32 table for f16 (256 KB) (simd-mappings.h)
float wsp_ggml_table_f32_f16[1 << 16];

#if defined(__ARM_ARCH)
struct wsp_ggml_arm_arch_features_type {
    int sve_cnt;
} wsp_ggml_arm_arch_features = { 0 };
#endif


#if defined(_WIN32)

#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
    #define NOMINMAX
#endif
#include <windows.h>

#if defined(_MSC_VER) && !defined(__clang__)
#define WSP_GGML_CACHE_ALIGN __declspec(align(WSP_GGML_CACHE_LINE))

typedef volatile LONG atomic_int;
typedef atomic_int atomic_bool;
typedef atomic_int atomic_flag;

#define ATOMIC_FLAG_INIT 0

typedef enum {
    memory_order_relaxed,
    memory_order_consume,
    memory_order_acquire,
    memory_order_release,
    memory_order_acq_rel,
    memory_order_seq_cst
} memory_order;

static void atomic_store(atomic_int * ptr, LONG val) {
    InterlockedExchange(ptr, val);
}
static void atomic_store_explicit(atomic_int * ptr, LONG val, memory_order mo) {
    // TODO: add support for explicit memory order
    InterlockedExchange(ptr, val);
}
static LONG atomic_load(atomic_int * ptr) {
    return InterlockedCompareExchange(ptr, 0, 0);
}
static LONG atomic_load_explicit(atomic_int * ptr, memory_order mo) {
    // TODO: add support for explicit memory order
    return InterlockedCompareExchange(ptr, 0, 0);
}
static LONG atomic_fetch_add(atomic_int * ptr, LONG inc) {
    return InterlockedExchangeAdd(ptr, inc);
}
static LONG atomic_fetch_add_explicit(atomic_int * ptr, LONG inc, memory_order mo) {
    // TODO: add support for explicit memory order
    return InterlockedExchangeAdd(ptr, inc);
}
static atomic_bool atomic_flag_test_and_set(atomic_flag * ptr) {
    return InterlockedExchange(ptr, 1);
}
static void atomic_flag_clear(atomic_flag * ptr) {
    InterlockedExchange(ptr, 0);
}
static void atomic_thread_fence(memory_order mo) {
    MemoryBarrier();
}
#else // clang
#include <stdatomic.h>
#endif

typedef HANDLE pthread_t;

typedef DWORD thread_ret_t;
static int pthread_create(pthread_t * out, void * unused, thread_ret_t(*func)(void *), void * arg) {
    (void) unused;
    HANDLE handle = CreateThread(NULL, 0, (LPTHREAD_START_ROUTINE) func, arg, 0, NULL);
    if (handle == NULL)
    {
        return EAGAIN;
    }

    *out = handle;
    return 0;
}

static int pthread_join(pthread_t thread, void * unused) {
    (void) unused;
    int ret = (int) WaitForSingleObject(thread, INFINITE);
    CloseHandle(thread);
    return ret;
}

static int sched_yield (void) {
    Sleep (0);
    return 0;
}
#else

#include <pthread.h>
#include <stdatomic.h>
#include <sched.h>
#if defined(__FreeBSD__)
#include <pthread_np.h>
#endif

typedef void * thread_ret_t;

#include <sys/types.h>
#include <sys/stat.h>
#include <unistd.h>

#endif

typedef pthread_t wsp_ggml_thread_t;

#if defined(__APPLE__)
#include <unistd.h>
#include <mach/mach.h>
#include <TargetConditionals.h>
#endif

static const struct wsp_ggml_type_traits_cpu type_traits_cpu[WSP_GGML_TYPE_COUNT] = {
    [WSP_GGML_TYPE_F32] = {
        .from_float               = (wsp_ggml_from_float_t) wsp_ggml_cpu_fp32_to_fp32,
        .vec_dot                  = (wsp_ggml_vec_dot_t) wsp_ggml_vec_dot_f32,
        .vec_dot_type             = WSP_GGML_TYPE_F32,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_F16] = {
        .from_float               = (wsp_ggml_from_float_t) wsp_ggml_cpu_fp32_to_fp16,
        .vec_dot                  = (wsp_ggml_vec_dot_t) wsp_ggml_vec_dot_f16,
        .vec_dot_type             = WSP_GGML_TYPE_F16,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_Q4_0] = {
        .from_float               = wsp_quantize_row_q4_0,
        .vec_dot                  = wsp_ggml_vec_dot_q4_0_q8_0,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_0,
#if defined (__ARM_FEATURE_MATMUL_INT8)
        .nrows                    = 2,
#else
        .nrows                    = 1,
#endif
    },
    [WSP_GGML_TYPE_Q4_1] = {
        .from_float               = wsp_quantize_row_q4_1,
        .vec_dot                  = wsp_ggml_vec_dot_q4_1_q8_1,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_1,
#if defined (__ARM_FEATURE_MATMUL_INT8)
        .nrows                    = 2,
#else
        .nrows                    = 1,
#endif
    },
    [WSP_GGML_TYPE_Q5_0] = {
        .from_float               = wsp_quantize_row_q5_0,
        .vec_dot                  = wsp_ggml_vec_dot_q5_0_q8_0,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_0,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_Q5_1] = {
        .from_float               = wsp_quantize_row_q5_1,
        .vec_dot                  = wsp_ggml_vec_dot_q5_1_q8_1,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_1,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_Q8_0] = {
        .from_float               = wsp_quantize_row_q8_0,
        .vec_dot                  = wsp_ggml_vec_dot_q8_0_q8_0,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_0,
#if defined (__ARM_FEATURE_MATMUL_INT8)
        .nrows                    = 2,
#else
        .nrows                    = 1,
#endif
    },
    [WSP_GGML_TYPE_Q8_1] = {
        .from_float               = wsp_quantize_row_q8_1,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_1,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_MXFP4] = {
        .from_float               = wsp_quantize_row_mxfp4,
        .vec_dot                  = wsp_ggml_vec_dot_mxfp4_q8_0,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_0,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_Q2_K] = {
        .from_float               = wsp_quantize_row_q2_K,
        .vec_dot                  = wsp_ggml_vec_dot_q2_K_q8_K,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_K,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_Q3_K] = {
        .from_float               = wsp_quantize_row_q3_K,
        .vec_dot                  = wsp_ggml_vec_dot_q3_K_q8_K,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_K,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_Q4_K] = {
        .from_float               = wsp_quantize_row_q4_K,
        .vec_dot                  = wsp_ggml_vec_dot_q4_K_q8_K,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_K,
#if defined (__ARM_FEATURE_MATMUL_INT8)
        .nrows                    = 2,
#else
        .nrows                    = 1,
#endif
    },
    [WSP_GGML_TYPE_Q5_K] = {
        .from_float               = wsp_quantize_row_q5_K,
        .vec_dot                  = wsp_ggml_vec_dot_q5_K_q8_K,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_K,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_Q6_K] = {
        .from_float               = wsp_quantize_row_q6_K,
        .vec_dot                  = wsp_ggml_vec_dot_q6_K_q8_K,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_K,
#if defined (__ARM_FEATURE_MATMUL_INT8)
        .nrows                    = 2,
#else
        .nrows                    = 1,
#endif
    },
    [WSP_GGML_TYPE_IQ2_XXS] = {
        .from_float               = NULL,
        .vec_dot                  = wsp_ggml_vec_dot_iq2_xxs_q8_K,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_K,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_IQ2_XS] = {
        .from_float               = NULL,
        .vec_dot                  = wsp_ggml_vec_dot_iq2_xs_q8_K,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_K,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_IQ3_XXS] = {
        // NOTE: from_float for iq3 and iq2_s was removed because these quants require initialization in wsp_ggml_wsp_quantize_init
        //.from_float               = wsp_quantize_row_iq3_xxs,
        .vec_dot                  = wsp_ggml_vec_dot_iq3_xxs_q8_K,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_K,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_IQ3_S] = {
        //.from_float               = wsp_quantize_row_iq3_s,
        .vec_dot                  = wsp_ggml_vec_dot_iq3_s_q8_K,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_K,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_IQ2_S] = {
        //.from_float               = wsp_quantize_row_iq2_s,
        .vec_dot                  = wsp_ggml_vec_dot_iq2_s_q8_K,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_K,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_IQ1_S] = {
        .from_float               = NULL,
        .vec_dot                  = wsp_ggml_vec_dot_iq1_s_q8_K,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_K,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_IQ1_M] = {
        .from_float               = NULL,
        .vec_dot                  = wsp_ggml_vec_dot_iq1_m_q8_K,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_K,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_IQ4_NL] = {
        .from_float               = wsp_quantize_row_iq4_nl,
        .vec_dot                  = wsp_ggml_vec_dot_iq4_nl_q8_0,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_0,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_IQ4_XS] = {
        .from_float               = wsp_quantize_row_iq4_xs,
        .vec_dot                  = wsp_ggml_vec_dot_iq4_xs_q8_K,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_K,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_Q8_K] = {
        .from_float               = wsp_quantize_row_q8_K,
    },
    [WSP_GGML_TYPE_BF16] = {
        .from_float               = (wsp_ggml_from_float_t) wsp_ggml_cpu_fp32_to_bf16,
        .vec_dot                  = (wsp_ggml_vec_dot_t) wsp_ggml_vec_dot_bf16,
        .vec_dot_type             = WSP_GGML_TYPE_BF16,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_TQ1_0] = {
        .from_float               = wsp_quantize_row_tq1_0,
        .vec_dot                  = wsp_ggml_vec_dot_tq1_0_q8_K,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_K,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_TQ2_0] = {
        .from_float               = wsp_quantize_row_tq2_0,
        .vec_dot                  = wsp_ggml_vec_dot_tq2_0_q8_K,
        .vec_dot_type             = WSP_GGML_TYPE_Q8_K,
        .nrows                    = 1,
    },
    [WSP_GGML_TYPE_I32] = {
        .from_float               = (wsp_ggml_from_float_t) wsp_ggml_cpu_fp32_to_i32,
    },
};

const struct wsp_ggml_type_traits_cpu * wsp_ggml_get_type_traits_cpu(enum wsp_ggml_type type) {
    return &type_traits_cpu[type];
}

//
// Threading defs
//

typedef pthread_t          wsp_ggml_thread_t;

#if defined(_WIN32)

typedef CONDITION_VARIABLE wsp_ggml_cond_t;
typedef SRWLOCK            wsp_ggml_mutex_t;

#define wsp_ggml_mutex_init(m)   InitializeSRWLock(m)
#define wsp_ggml_mutex_destroy(m)
#define wsp_ggml_mutex_lock(m)   AcquireSRWLockExclusive(m)
#define wsp_ggml_mutex_unlock(m) ReleaseSRWLockExclusive(m)
#define wsp_ggml_mutex_lock_shared(m)   AcquireSRWLockShared(m)
#define wsp_ggml_mutex_unlock_shared(m) ReleaseSRWLockShared(m)

#define wsp_ggml_cond_init(c)    InitializeConditionVariable(c)
#define wsp_ggml_cond_destroy(c)
#define wsp_ggml_cond_wait(c, m) SleepConditionVariableSRW(c, m, INFINITE, CONDITION_VARIABLE_LOCKMODE_SHARED)
#define wsp_ggml_cond_broadcast(c) WakeAllConditionVariable(c)

#define wsp_ggml_thread_create pthread_create
#define wsp_ggml_thread_join   pthread_join

#else

typedef pthread_cond_t     wsp_ggml_cond_t;
typedef pthread_mutex_t    wsp_ggml_mutex_t;

#define wsp_ggml_mutex_init(m)          pthread_mutex_init(m, NULL)
#define wsp_ggml_mutex_destroy(m)       pthread_mutex_destroy(m)
#define wsp_ggml_mutex_lock(m)          pthread_mutex_lock(m)
#define wsp_ggml_mutex_unlock(m)        pthread_mutex_unlock(m)
#define wsp_ggml_mutex_lock_shared(m)   pthread_mutex_lock(m)
#define wsp_ggml_mutex_unlock_shared(m) pthread_mutex_unlock(m)

#define wsp_ggml_lock_init(x)    UNUSED(x)
#define wsp_ggml_lock_destroy(x) UNUSED(x)
#if defined(__x86_64__) || (defined(_MSC_VER) && defined(_M_AMD64))
#define wsp_ggml_lock_lock(x)    _mm_pause()
#else
#define wsp_ggml_lock_lock(x)    UNUSED(x)
#endif
#define wsp_ggml_lock_unlock(x)  UNUSED(x)

#define WSP_GGML_LOCK_INITIALIZER 0
#define wsp_ggml_cond_init(c)      pthread_cond_init(c, NULL)
#define wsp_ggml_cond_destroy(c)   pthread_cond_destroy(c)
#define wsp_ggml_cond_wait(c, m)   pthread_cond_wait(c, m)
#define wsp_ggml_cond_broadcast(c) pthread_cond_broadcast(c)

#define wsp_ggml_thread_create pthread_create
#define wsp_ggml_thread_join   pthread_join

#endif

// Threadpool def
struct wsp_ggml_threadpool {
    wsp_ggml_mutex_t mutex;       // mutex for cond.var
    wsp_ggml_cond_t  cond;        // cond.var for waiting for new work

    struct wsp_ggml_cgraph * cgraph;
    struct wsp_ggml_cplan  * cplan;

    // synchronization primitives
    atomic_int n_graph;       // incremented when there is work to be done (i.e each graph)
    atomic_int WSP_GGML_CACHE_ALIGN n_barrier;
    atomic_int WSP_GGML_CACHE_ALIGN n_barrier_passed;
    atomic_int WSP_GGML_CACHE_ALIGN current_chunk; // currently processing chunk during Mat_Mul, shared between all the threads.

    // these are atomic as an annotation for thread-sanitizer
    atomic_bool stop;         // Used for stopping the threadpool altogether
    atomic_bool pause;        // Used for pausing the threadpool or individual threads
    atomic_int abort;         // Used for aborting processing of a graph

    struct wsp_ggml_compute_state * workers;   // per thread state
    int          n_threads_max; // number of threads in the pool
    atomic_int   n_threads_cur; // number of threads used in the current graph

    int32_t      prio;        // Scheduling priority
    uint32_t     poll;        // Polling level (0 - no polling)

    enum wsp_ggml_status ec;
};

// Per-thread state
struct wsp_ggml_compute_state {
#ifndef WSP_GGML_USE_OPENMP
    wsp_ggml_thread_t thrd;
    int  last_graph;
    bool pending;
#endif
    bool cpumask[WSP_GGML_MAX_N_THREADS];
    struct wsp_ggml_threadpool * threadpool;
    int ith;
};

// Helpers for polling loops
#if defined(__aarch64__) && ( defined(__clang__) || defined(__GNUC__) )
static inline void wsp_ggml_thread_cpu_relax(void) {
    __asm__ volatile("yield" ::: "memory");
}
#elif defined(__x86_64__)
static inline void wsp_ggml_thread_cpu_relax(void) {
    _mm_pause();
}
#else
static inline void wsp_ggml_thread_cpu_relax(void) {;}
#endif

//
// NUMA support
//

#define WSP_GGML_NUMA_MAX_NODES 8
#define WSP_GGML_NUMA_MAX_CPUS 512

struct wsp_ggml_numa_node {
    uint32_t cpus[WSP_GGML_NUMA_MAX_CPUS]; // hardware threads on this node
    uint32_t n_cpus;
};

struct wsp_ggml_numa_nodes {
    enum wsp_ggml_numa_strategy numa_strategy;
    struct wsp_ggml_numa_node nodes[WSP_GGML_NUMA_MAX_NODES];
    uint32_t n_nodes;
    uint32_t total_cpus; // hardware threads on system
    uint32_t current_node; // node on which main process is execting
#if defined(__gnu_linux__)
    cpu_set_t cpuset; // cpuset from numactl
#else
    uint32_t cpuset; // no NUMA support outside of Linux at this time. Use a portable datatype
#endif
};

//
// ggml state
//

struct wsp_ggml_state {
    struct wsp_ggml_numa_nodes numa;
};

static struct wsp_ggml_state g_state = {0};

void wsp_ggml_barrier(struct wsp_ggml_threadpool * tp) {
    int n_threads = atomic_load_explicit(&tp->n_threads_cur, memory_order_relaxed);
    if (n_threads == 1) {
        return;
    }

#ifdef WSP_GGML_USE_OPENMP
    #pragma omp barrier
#else
    int n_passed = atomic_load_explicit(&tp->n_barrier_passed, memory_order_relaxed);

    // enter barrier (full seq-cst fence)
    int n_barrier = atomic_fetch_add_explicit(&tp->n_barrier, 1, memory_order_seq_cst);

    if (n_barrier == (n_threads - 1)) {
        // last thread
        atomic_store_explicit(&tp->n_barrier, 0, memory_order_relaxed);

        // exit barrier (fill seq-cst fence)
        atomic_fetch_add_explicit(&tp->n_barrier_passed, 1, memory_order_seq_cst);
        return;
    }

    // wait for other threads
    while (atomic_load_explicit(&tp->n_barrier_passed, memory_order_relaxed) == n_passed) {
        wsp_ggml_thread_cpu_relax();
    }

    // exit barrier (full seq-cst fence)
    // TSAN doesn't support standalone fence yet, we use a dummy read-modify-write instead
    #ifdef WSP_GGML_TSAN_ENABLED
    atomic_fetch_add_explicit(&tp->n_barrier_passed, 0, memory_order_seq_cst);
    #else
    atomic_thread_fence(memory_order_seq_cst);
    #endif
#endif
}

void wsp_ggml_threadpool_chunk_set(struct wsp_ggml_threadpool * tp, int value) {
    atomic_store_explicit(&tp->current_chunk, value, memory_order_relaxed);
}

int wsp_ggml_threadpool_chunk_add(struct wsp_ggml_threadpool * tp, int value) {
    return atomic_fetch_add_explicit(&tp->current_chunk, value, memory_order_relaxed);
}

#if defined(__gnu_linux__)
static cpu_set_t wsp_ggml_get_numa_affinity(void) {
    cpu_set_t cpuset;
    pthread_t thread;
    thread = pthread_self();
    CPU_ZERO(&cpuset);
    pthread_getaffinity_np(thread, sizeof(cpu_set_t), &cpuset);
    return cpuset;
}
#else
static uint32_t wsp_ggml_get_numa_affinity(void) {
    return 0; // no NUMA support
}
#endif

void wsp_ggml_numa_init(enum wsp_ggml_numa_strategy numa_flag) {
    if (g_state.numa.n_nodes > 0) {
        fprintf(stderr, "wsp_ggml_numa_init: NUMA already initialized\n");

        return;
    }

#if defined(__gnu_linux__)
    struct stat st;
    char path[256];
    int rv;

    // set numa scheme
    g_state.numa.numa_strategy = numa_flag;

    WSP_GGML_PRINT_DEBUG("numa strategy %u\n",g_state.numa.numa_strategy);

    g_state.numa.cpuset = wsp_ggml_get_numa_affinity();

    // enumerate nodes
    while (g_state.numa.n_nodes < WSP_GGML_NUMA_MAX_NODES) {
        rv = snprintf(path, sizeof(path), "/sys/devices/system/node/node%u", g_state.numa.n_nodes);
        WSP_GGML_ASSERT(rv > 0 && (unsigned)rv < sizeof(path));
        if (stat(path, &st) != 0) { break; }
        ++g_state.numa.n_nodes;
    }

    // enumerate CPUs
    while (g_state.numa.total_cpus < WSP_GGML_NUMA_MAX_CPUS) {
        rv = snprintf(path, sizeof(path), "/sys/devices/system/cpu/cpu%u", g_state.numa.total_cpus);
        WSP_GGML_ASSERT(rv > 0 && (unsigned)rv < sizeof(path));
        if (stat(path, &st) != 0) { break; }
        ++g_state.numa.total_cpus;
    }

    WSP_GGML_PRINT_DEBUG("found %u numa nodes, %u CPUs\n", g_state.numa.n_nodes, g_state.numa.total_cpus);

    // figure out which node we're on
    uint current_cpu;
    int getcpu_ret = 0;
#if __GLIBC__ > 2 || (__GLIBC__ == 2 && __GLIBC_MINOR__ > 33) || defined(__COSMOPOLITAN__)
    getcpu_ret = getcpu(&current_cpu, &g_state.numa.current_node);
#else
    // old glibc doesn't have a wrapper for this call. Fall back on direct syscall
#   if !defined(SYS_getcpu) && defined(SYS_get_cpu)
#       define SYS_getcpu SYS_get_cpu // some older glibc versions use this name
#   endif
    getcpu_ret = syscall(SYS_getcpu, &current_cpu, &g_state.numa.current_node);
#endif

    if (g_state.numa.n_nodes < 1 || g_state.numa.total_cpus < 1 || getcpu_ret != 0) {
        g_state.numa.n_nodes = 0;
        return;
    }

    WSP_GGML_PRINT_DEBUG("found our process on numa node %u, CPU %u\n", g_state.numa.current_node, current_cpu);

    for (uint32_t n = 0; n < g_state.numa.n_nodes; ++n) {
        struct wsp_ggml_numa_node * node = &g_state.numa.nodes[n];
        WSP_GGML_PRINT_DEBUG("CPUs on node %u:", n);
        node->n_cpus = 0;
        for (uint32_t c = 0; c < g_state.numa.total_cpus; ++c) {
            rv = snprintf(path, sizeof(path), "/sys/devices/system/node/node%u/cpu%u", n, c);
            WSP_GGML_ASSERT(rv > 0 && (unsigned)rv < sizeof(path));
            if (stat(path, &st) == 0) {
                node->cpus[node->n_cpus++] = c;
                WSP_GGML_PRINT_DEBUG(" %u", c);
            }
        }
        WSP_GGML_PRINT_DEBUG("\n");
    }

    if (wsp_ggml_is_numa()) {
        FILE *fptr = fopen("/proc/sys/kernel/numa_balancing", "r");
        if (fptr != NULL) {
            char buf[42];
            if (fgets(buf, sizeof(buf), fptr) && strncmp(buf, "0\n", sizeof(buf)) != 0) {
                WSP_GGML_LOG_WARN("/proc/sys/kernel/numa_balancing is enabled, this has been observed to impair performance\n");
            }
            fclose(fptr);
        }
    }
#else
    UNUSED(numa_flag);
    // TODO
#endif
}

bool wsp_ggml_is_numa(void) {
    return g_state.numa.n_nodes > 1;
}

#if defined(__ARM_ARCH)

#if defined(__linux__) && defined(__aarch64__)
#include <sys/auxv.h>
#endif

static void wsp_ggml_init_arm_arch_features(void) {
#if defined(__aarch64__) && defined(__ARM_FEATURE_SVE)
#if defined(__linux__)
    wsp_ggml_arm_arch_features.sve_cnt = PR_SVE_VL_LEN_MASK & prctl(PR_SVE_GET_VL);
#else
    // TODO: add support of SVE for non-linux systems
#error "TODO: SVE is not supported on this platform. To use SVE, sve_cnt needs to be initialized here."
#endif
#endif
}

#endif // __ARM_ARCH

struct wsp_ggml_tensor * wsp_ggml_new_i32(struct wsp_ggml_context * ctx, int32_t value) {
    WSP_GGML_ASSERT(!wsp_ggml_get_no_alloc(ctx));

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_1d(ctx, WSP_GGML_TYPE_I32, 1);

    wsp_ggml_set_i32(result, value);

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_new_f32(struct wsp_ggml_context * ctx, float value) {
    WSP_GGML_ASSERT(!wsp_ggml_get_no_alloc(ctx));

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_1d(ctx, WSP_GGML_TYPE_F32, 1);

    wsp_ggml_set_f32(result, value);

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_set_i32 (struct wsp_ggml_tensor * tensor, int32_t value) {
    const int n     = wsp_ggml_nrows(tensor);
    const int nc    = tensor->ne[0];
    const size_t n1 = tensor->nb[1];

    char * const data = tensor->data;

    switch (tensor->type) {
        case WSP_GGML_TYPE_I8:
            {
                assert(tensor->nb[0] == sizeof(int8_t));
                for (int i = 0; i < n; i++) {
                    wsp_ggml_vec_set_i8(nc, (int8_t *)(data + i*n1), value);
                }
            } break;
        case WSP_GGML_TYPE_I16:
            {
                assert(tensor->nb[0] == sizeof(int16_t));
                for (int i = 0; i < n; i++) {
                    wsp_ggml_vec_set_i16(nc, (int16_t *)(data + i*n1), value);
                }
            } break;
        case WSP_GGML_TYPE_I32:
            {
                assert(tensor->nb[0] == sizeof(int32_t));
                for (int i = 0; i < n; i++) {
                    wsp_ggml_vec_set_i32(nc, (int32_t *)(data + i*n1), value);
                }
            } break;
        case WSP_GGML_TYPE_F16:
            {
                assert(tensor->nb[0] == sizeof(wsp_ggml_fp16_t));
                for (int i = 0; i < n; i++) {
                    wsp_ggml_vec_set_f16(nc, (wsp_ggml_fp16_t *)(data + i*n1), WSP_GGML_CPU_FP32_TO_FP16(value));
                }
            } break;
        case WSP_GGML_TYPE_BF16:
            {
                assert(tensor->nb[0] == sizeof(wsp_ggml_fp16_t));
                for (int i = 0; i < n; i++) {
                    wsp_ggml_vec_set_bf16(nc, (wsp_ggml_bf16_t *)(data + i*n1), WSP_GGML_FP32_TO_BF16(value));
                }
            } break;
        case WSP_GGML_TYPE_F32:
            {
                assert(tensor->nb[0] == sizeof(float));
                for (int i = 0; i < n; i++) {
                    wsp_ggml_vec_set_f32(nc, (float *)(data + i*n1), value);
                }
            } break;
        default:
            {
                WSP_GGML_ABORT("fatal error");
            }
    }

    return tensor;
}

struct wsp_ggml_tensor * wsp_ggml_set_f32(struct wsp_ggml_tensor * tensor, float value) {
    const int n     = wsp_ggml_nrows(tensor);
    const int nc    = tensor->ne[0];
    const size_t n1 = tensor->nb[1];

    char * const data = tensor->data;

    switch (tensor->type) {
        case WSP_GGML_TYPE_I8:
            {
                assert(tensor->nb[0] == sizeof(int8_t));
                for (int i = 0; i < n; i++) {
                    wsp_ggml_vec_set_i8(nc, (int8_t *)(data + i*n1), value);
                }
            } break;
        case WSP_GGML_TYPE_I16:
            {
                assert(tensor->nb[0] == sizeof(int16_t));
                for (int i = 0; i < n; i++) {
                    wsp_ggml_vec_set_i16(nc, (int16_t *)(data + i*n1), value);
                }
            } break;
        case WSP_GGML_TYPE_I32:
            {
                assert(tensor->nb[0] == sizeof(int32_t));
                for (int i = 0; i < n; i++) {
                    wsp_ggml_vec_set_i32(nc, (int32_t *)(data + i*n1), value);
                }
            } break;
        case WSP_GGML_TYPE_F16:
            {
                assert(tensor->nb[0] == sizeof(wsp_ggml_fp16_t));
                for (int i = 0; i < n; i++) {
                    wsp_ggml_vec_set_f16(nc, (wsp_ggml_fp16_t *)(data + i*n1), WSP_GGML_CPU_FP32_TO_FP16(value));
                }
            } break;
        case WSP_GGML_TYPE_BF16:
            {
                assert(tensor->nb[0] == sizeof(wsp_ggml_bf16_t));
                for (int i = 0; i < n; i++) {
                    wsp_ggml_vec_set_bf16(nc, (wsp_ggml_bf16_t *)(data + i*n1), WSP_GGML_FP32_TO_BF16(value));
                }
            } break;
        case WSP_GGML_TYPE_F32:
            {
                assert(tensor->nb[0] == sizeof(float));
                for (int i = 0; i < n; i++) {
                    wsp_ggml_vec_set_f32(nc, (float *)(data + i*n1), value);
                }
            } break;
        default:
            {
                WSP_GGML_ABORT("fatal error");
            }
    }

    return tensor;
}

int32_t wsp_ggml_get_i32_1d(const struct wsp_ggml_tensor * tensor, int i) {
    if (!wsp_ggml_is_contiguous(tensor)) {
        int64_t id[4] = { 0, 0, 0, 0 };
        wsp_ggml_unravel_index(tensor, i, &id[0], &id[1], &id[2], &id[3]);
        return wsp_ggml_get_i32_nd(tensor, id[0], id[1], id[2], id[3]);
    }
    switch (tensor->type) {
        case WSP_GGML_TYPE_I8:
            {
                WSP_GGML_ASSERT(tensor->nb[0] == sizeof(int8_t));
                return ((int8_t *)(tensor->data))[i];
            }
        case WSP_GGML_TYPE_I16:
            {
                WSP_GGML_ASSERT(tensor->nb[0] == sizeof(int16_t));
                return ((int16_t *)(tensor->data))[i];
            }
        case WSP_GGML_TYPE_I32:
            {
                WSP_GGML_ASSERT(tensor->nb[0] == sizeof(int32_t));
                return ((int32_t *)(tensor->data))[i];
            }
        case WSP_GGML_TYPE_F16:
            {
                WSP_GGML_ASSERT(tensor->nb[0] == sizeof(wsp_ggml_fp16_t));
                return WSP_GGML_CPU_FP16_TO_FP32(((wsp_ggml_fp16_t *)(tensor->data))[i]);
            }
        case WSP_GGML_TYPE_BF16:
            {
                WSP_GGML_ASSERT(tensor->nb[0] == sizeof(wsp_ggml_bf16_t));
                return WSP_GGML_BF16_TO_FP32(((wsp_ggml_bf16_t *)(tensor->data))[i]);
            }
        case WSP_GGML_TYPE_F32:
            {
                WSP_GGML_ASSERT(tensor->nb[0] == sizeof(float));
                return ((float *)(tensor->data))[i];
            }
        default:
            {
                WSP_GGML_ABORT("fatal error");
            }
    }
}

void wsp_ggml_set_i32_1d(const struct wsp_ggml_tensor * tensor, int i, int32_t value) {
    if (!wsp_ggml_is_contiguous(tensor)) {
        int64_t id[4] = { 0, 0, 0, 0 };
        wsp_ggml_unravel_index(tensor, i, &id[0], &id[1], &id[2], &id[3]);
        wsp_ggml_set_i32_nd(tensor, id[0], id[1], id[2], id[3], value);
        return;
    }
    switch (tensor->type) {
        case WSP_GGML_TYPE_I8:
            {
                WSP_GGML_ASSERT(tensor->nb[0] == sizeof(int8_t));
                ((int8_t *)(tensor->data))[i] = value;
            } break;
        case WSP_GGML_TYPE_I16:
            {
                WSP_GGML_ASSERT(tensor->nb[0] == sizeof(int16_t));
                ((int16_t *)(tensor->data))[i] = value;
            } break;
        case WSP_GGML_TYPE_I32:
            {
                WSP_GGML_ASSERT(tensor->nb[0] == sizeof(int32_t));
                ((int32_t *)(tensor->data))[i] = value;
            } break;
        case WSP_GGML_TYPE_F16:
            {
                WSP_GGML_ASSERT(tensor->nb[0] == sizeof(wsp_ggml_fp16_t));
                ((wsp_ggml_fp16_t *)(tensor->data))[i] = WSP_GGML_CPU_FP32_TO_FP16(value);
            } break;
        case WSP_GGML_TYPE_BF16:
            {
                WSP_GGML_ASSERT(tensor->nb[0] == sizeof(wsp_ggml_bf16_t));
                ((wsp_ggml_bf16_t *)(tensor->data))[i] = WSP_GGML_FP32_TO_BF16(value);
            } break;
        case WSP_GGML_TYPE_F32:
            {
                WSP_GGML_ASSERT(tensor->nb[0] == sizeof(float));
                ((float *)(tensor->data))[i] = value;
            } break;
        default:
            {
                WSP_GGML_ABORT("fatal error");
            }
    }
}

int32_t wsp_ggml_get_i32_nd(const struct wsp_ggml_tensor * tensor, int i0, int i1, int i2, int i3) {
    void * data   = (char *) tensor->data + i0*tensor->nb[0] + i1*tensor->nb[1] + i2*tensor->nb[2] + i3*tensor->nb[3];
    switch (tensor->type) {
        case WSP_GGML_TYPE_I8:
            return ((int8_t *) data)[0];
        case WSP_GGML_TYPE_I16:
            return ((int16_t *) data)[0];
        case WSP_GGML_TYPE_I32:
            return ((int32_t *) data)[0];
        case WSP_GGML_TYPE_F16:
            return WSP_GGML_CPU_FP16_TO_FP32(((wsp_ggml_fp16_t *) data)[0]);
        case WSP_GGML_TYPE_BF16:
            return WSP_GGML_BF16_TO_FP32(((wsp_ggml_bf16_t *) data)[0]);
        case WSP_GGML_TYPE_F32:
            return ((float *) data)[0];
        default:
            WSP_GGML_ABORT("fatal error");
    }
}

void wsp_ggml_set_i32_nd(const struct wsp_ggml_tensor * tensor, int i0, int i1, int i2, int i3, int32_t value) {
    void * data   = (char *) tensor->data + i0*tensor->nb[0] + i1*tensor->nb[1] + i2*tensor->nb[2] + i3*tensor->nb[3];
    switch (tensor->type) {
        case WSP_GGML_TYPE_I8:
            {
                ((int8_t *)(data))[0] = value;
            } break;
        case WSP_GGML_TYPE_I16:
            {
                ((int16_t *)(data))[0] = value;
            } break;
        case WSP_GGML_TYPE_I32:
            {
                ((int32_t *)(data))[0] = value;
            } break;
        case WSP_GGML_TYPE_F16:
            {
                ((wsp_ggml_fp16_t *)(data))[0] = WSP_GGML_CPU_FP32_TO_FP16(value);
            } break;
        case WSP_GGML_TYPE_BF16:
            {
                ((wsp_ggml_bf16_t *)(data))[0] = WSP_GGML_FP32_TO_BF16(value);
            } break;
        case WSP_GGML_TYPE_F32:
            {
                ((float *)(data))[0] = value;
            } break;
        default:
            {
                WSP_GGML_ABORT("fatal error");
            }
    }
}

float wsp_ggml_get_f32_1d(const struct wsp_ggml_tensor * tensor, int i) {
    if (!wsp_ggml_is_contiguous(tensor)) {
        int64_t id[4] = { 0, 0, 0, 0 };
        wsp_ggml_unravel_index(tensor, i, &id[0], &id[1], &id[2], &id[3]);
        return wsp_ggml_get_f32_nd(tensor, id[0], id[1], id[2], id[3]);
    }
    switch (tensor->type) {
        case WSP_GGML_TYPE_I8:
            {
                return ((int8_t *)(tensor->data))[i];
            }
        case WSP_GGML_TYPE_I16:
            {
                return ((int16_t *)(tensor->data))[i];
            }
        case WSP_GGML_TYPE_I32:
            {
                return ((int32_t *)(tensor->data))[i];
            }
        case WSP_GGML_TYPE_F16:
            {
                return WSP_GGML_CPU_FP16_TO_FP32(((wsp_ggml_fp16_t *)(tensor->data))[i]);
            }
        case WSP_GGML_TYPE_BF16:
            {
                return WSP_GGML_BF16_TO_FP32(((wsp_ggml_bf16_t *)(tensor->data))[i]);
            }
        case WSP_GGML_TYPE_F32:
            {
                return ((float *)(tensor->data))[i];
            }
        default:
            {
                WSP_GGML_ABORT("fatal error");
            }
    }
}

void wsp_ggml_set_f32_1d(const struct wsp_ggml_tensor * tensor, int i, float value) {
    if (!wsp_ggml_is_contiguous(tensor)) {
        int64_t id[4] = { 0, 0, 0, 0 };
        wsp_ggml_unravel_index(tensor, i, &id[0], &id[1], &id[2], &id[3]);
        wsp_ggml_set_f32_nd(tensor, id[0], id[1], id[2], id[3], value);
        return;
    }
    switch (tensor->type) {
        case WSP_GGML_TYPE_I8:
            {
                ((int8_t *)(tensor->data))[i] = value;
            } break;
        case WSP_GGML_TYPE_I16:
            {
                ((int16_t *)(tensor->data))[i] = value;
            } break;
        case WSP_GGML_TYPE_I32:
            {
                ((int32_t *)(tensor->data))[i] = value;
            } break;
        case WSP_GGML_TYPE_F16:
            {
                ((wsp_ggml_fp16_t *)(tensor->data))[i] = WSP_GGML_CPU_FP32_TO_FP16(value);
            } break;
        case WSP_GGML_TYPE_BF16:
            {
                ((wsp_ggml_bf16_t *)(tensor->data))[i] = WSP_GGML_FP32_TO_BF16(value);
            } break;
        case WSP_GGML_TYPE_F32:
            {
                ((float *)(tensor->data))[i] = value;
            } break;
        default:
            {
                WSP_GGML_ABORT("fatal error");
            }
    }
}

float wsp_ggml_get_f32_nd(const struct wsp_ggml_tensor * tensor, int i0, int i1, int i2, int i3) {
    void * data   = (char *) tensor->data + i0*tensor->nb[0] + i1*tensor->nb[1] + i2*tensor->nb[2] + i3*tensor->nb[3];
    switch (tensor->type) {
        case WSP_GGML_TYPE_I8:
            return ((int8_t *) data)[0];
        case WSP_GGML_TYPE_I16:
            return ((int16_t *) data)[0];
        case WSP_GGML_TYPE_I32:
            return ((int32_t *) data)[0];
        case WSP_GGML_TYPE_F16:
            return WSP_GGML_CPU_FP16_TO_FP32(((wsp_ggml_fp16_t *) data)[0]);
        case WSP_GGML_TYPE_BF16:
            return WSP_GGML_BF16_TO_FP32(((wsp_ggml_bf16_t *) data)[0]);
        case WSP_GGML_TYPE_F32:
            return ((float *) data)[0];
        default:
            WSP_GGML_ABORT("fatal error");
    }
}

void wsp_ggml_set_f32_nd(const struct wsp_ggml_tensor * tensor, int i0, int i1, int i2, int i3, float value) {
    void * data   = (char *) tensor->data + i0*tensor->nb[0] + i1*tensor->nb[1] + i2*tensor->nb[2] + i3*tensor->nb[3];
    switch (tensor->type) {
        case WSP_GGML_TYPE_I8:
            {
                ((int8_t *)(data))[0] = value;
            } break;
        case WSP_GGML_TYPE_I16:
            {
                ((int16_t *)(data))[0] = value;
            } break;
        case WSP_GGML_TYPE_I32:
            {
                ((int32_t *)(data))[0] = value;
            } break;
        case WSP_GGML_TYPE_F16:
            {
                ((wsp_ggml_fp16_t *)(data))[0] = WSP_GGML_CPU_FP32_TO_FP16(value);
            } break;
        case WSP_GGML_TYPE_BF16:
            {
                ((wsp_ggml_bf16_t *)(data))[0] = WSP_GGML_FP32_TO_BF16(value);
            } break;
        case WSP_GGML_TYPE_F32:
            {
                ((float *)(data))[0] = value;
            } break;
        default:
            {
                WSP_GGML_ABORT("fatal error");
            }
    }
}

////////////////////////////////////////////////////////////////////////////////

// wsp_ggml_compute_forward_mul_mat

static void wsp_ggml_compute_forward_mul_mat_one_chunk(
    const struct wsp_ggml_compute_params * params,
    struct wsp_ggml_tensor * dst,
    const enum wsp_ggml_type type,
    const int64_t num_rows_per_vec_dot,
    const int64_t ir0_start,
    const int64_t ir0_end,
    const int64_t ir1_start,
    const int64_t ir1_end) {

    const struct wsp_ggml_tensor * src0 = dst->src[0];
    const struct wsp_ggml_tensor * src1 = dst->src[1];

    WSP_GGML_TENSOR_BINARY_OP_LOCALS

    const bool src1_cont = wsp_ggml_is_contiguous(src1);

    wsp_ggml_vec_dot_t const vec_dot      = type_traits_cpu[type].vec_dot;
    enum wsp_ggml_type const vec_dot_type = type_traits_cpu[type].vec_dot_type;

    // broadcast factors
    const int64_t r2 = ne12 / ne02;
    const int64_t r3 = ne13 / ne03;

    //printf("ir0_start = %6lld, ir0_end = %6lld, ir1_start = %6lld, ir1_end = %6lld\n", ir0_start, ir0_end, ir1_start, ir1_end);

    // threads with no work simply yield (not sure if it helps)
    if (ir0_start >= ir0_end || ir1_start >= ir1_end) {
        return;
    }

    const void * wdata = (src1->type == vec_dot_type) ? src1->data : params->wdata;
    const size_t row_size = wsp_ggml_row_size(vec_dot_type, ne10);

    assert(ne12 % ne02 == 0);
    assert(ne13 % ne03 == 0);

    // block-tiling attempt
    const int64_t blck_0 = 16;
    const int64_t blck_1 = 16;

    const size_t src1_col_stride = src1_cont || src1->type != vec_dot_type ? row_size : nb11;

    // attempt to reduce false-sharing (does not seem to make a difference)
    // 16 * 2, accounting for mmla kernels
    float tmp[32];

    for (int64_t iir1 = ir1_start; iir1 < ir1_end; iir1 += blck_1) {
        for (int64_t iir0 = ir0_start; iir0 < ir0_end; iir0 += blck_0) {
            for (int64_t ir1 = iir1; ir1 < iir1 + blck_1 && ir1 < ir1_end; ir1 += num_rows_per_vec_dot) {
                const int64_t i13 = (ir1 / (ne12 * ne1));
                const int64_t i12 = (ir1 - i13 * ne12 * ne1) / ne1;
                const int64_t i11 = (ir1 - i13 * ne12 * ne1 - i12 * ne1);

                // broadcast src0 into src1
                const int64_t i03 = i13 / r3;
                const int64_t i02 = i12 / r2;

                const int64_t i1 = i11;
                const int64_t i2 = i12;
                const int64_t i3 = i13;

                const char * src0_row = (const char*)src0->data + (0 + i02 * nb02 + i03 * nb03);

                // desc: when src1 is not a contiguous memory block we have to calculate the offset using the strides
                //       if it is, then we have either copied the data to params->wdata and made it contiguous or we are using
                //       the original src1 data pointer, so we should index using the indices directly
                // TODO: this is a bit of a hack, we should probably have a better way to handle this
                const char * src1_col = (const char*)wdata +
                    (src1_cont || src1->type != vec_dot_type
                        ? (i11 + i12 * ne11 + i13 * ne12 * ne11) * row_size
                        : (i11 * nb11 + i12 * nb12 + i13 * nb13));
                float * dst_col = (float*)((char*)dst->data + (i1 * nb1 + i2 * nb2 + i3 * nb3));

                //for (int64_t ir0 = iir0; ir0 < iir0 + blck_0 && ir0 < ir0_end; ++ir0) {
                //    vec_dot(ne00, &dst_col[ir0], src0_row + ir0*nb01, src1_col);
                //}

                for (int64_t ir0 = iir0; ir0 < iir0 + blck_0 && ir0 < ir0_end; ir0 += num_rows_per_vec_dot) {
                    vec_dot(ne00, &tmp[ir0 - iir0], (num_rows_per_vec_dot > 1 ? 16 : 0), src0_row + ir0 * nb01, (num_rows_per_vec_dot > 1 ? nb01 : 0), src1_col, (num_rows_per_vec_dot > 1 ? src1_col_stride : 0), num_rows_per_vec_dot);
                }

                for (int cn = 0; cn < num_rows_per_vec_dot; ++cn) {
                    memcpy(&dst_col[iir0 + cn * nb1 / nb0], tmp + (cn * 16), (MIN(iir0 + blck_0, ir0_end) - iir0) * sizeof(float));
                }
            }
        }
    }
}

void wsp_ggml_compute_forward_mul_mat(
        const struct wsp_ggml_compute_params * params,
              struct wsp_ggml_tensor * dst) {

    const struct wsp_ggml_tensor * src0 = dst->src[0];
    const struct wsp_ggml_tensor * src1 = dst->src[1];

    WSP_GGML_TENSOR_BINARY_OP_LOCALS

    const int ith = params->ith;
    const int nth = params->nth;

    enum wsp_ggml_type           const vec_dot_type         = type_traits_cpu[src0->type].vec_dot_type;
    wsp_ggml_from_float_t        const from_float           = type_traits_cpu[vec_dot_type].from_float;
    int64_t                  const vec_dot_num_rows     = type_traits_cpu[src0->type].nrows;

    WSP_GGML_ASSERT(ne0 == ne01);
    WSP_GGML_ASSERT(ne1 == ne11);
    WSP_GGML_ASSERT(ne2 == ne12);
    WSP_GGML_ASSERT(ne3 == ne13);

    // we don't support permuted src0 or src1
    WSP_GGML_ASSERT(nb00 == wsp_ggml_type_size(src0->type));
    WSP_GGML_ASSERT(nb10 == wsp_ggml_type_size(src1->type));

    // dst cannot be transposed or permuted
    WSP_GGML_ASSERT(nb0 == sizeof(float));
    WSP_GGML_ASSERT(nb0 <= nb1);
    WSP_GGML_ASSERT(nb1 <= nb2);
    WSP_GGML_ASSERT(nb2 <= nb3);

    // nb01 >= nb00 - src0 is not transposed
    //   compute by src0 rows

    // TODO: extract to "extra_op"
#if WSP_GGML_USE_LLAMAFILE
    // broadcast factors
    const int64_t r2 = ne12 / ne02;
    const int64_t r3 = ne13 / ne03;

    const bool src1_cont = wsp_ggml_is_contiguous(src1);

    if (src1_cont) {
        for (int64_t i13 = 0; i13 < ne13; i13++)
            for (int64_t i12 = 0; i12 < ne12; i12++)
                if (!llamafile_sgemm(params,
                                     ne01, ne11, ne00/wsp_ggml_blck_size(src0->type),
                                     (const char *)src0->data + i12/r2*nb02 + i13/r3*nb03,
                                     nb01/wsp_ggml_type_size(src0->type),
                                     (const char *)src1->data + i12*nb12 + i13*nb13,
                                     nb11/wsp_ggml_type_size(src1->type),
                                     (char *)dst->data + i12*nb2 + i13*nb3,
                                     nb1/wsp_ggml_type_size(dst->type),
                                     src0->type,
                                     src1->type,
                                     dst->type))
                    goto UseGgmlGemm1;
        return;
    }
UseGgmlGemm1:;
#endif

    if (src1->type != vec_dot_type) {
        char * wdata = params->wdata;

        const size_t nbw0 = wsp_ggml_type_size(vec_dot_type);
        const size_t nbw1 = wsp_ggml_row_size(vec_dot_type, ne10);
        const size_t nbw2 = nbw1*ne11;
        const size_t nbw3 = nbw2*ne12;

        assert(params->wsize >= ne13*nbw3);
        WSP_GGML_ASSERT(src1->type == WSP_GGML_TYPE_F32);

    #if 0
        for (int64_t i13 = 0; i13 < ne13; ++i13) {
            for (int64_t i12 = 0; i12 < ne12; ++i12) {
                for (int64_t i11 = ith; i11 < ne11; i11 += nth) {
                    from_float((float *)((char *) src1->data + i13*nb13 + i12*nb12 + i11*nb11),
                               (void *)               (wdata + i13*nbw3 + i12*nbw2 + i11*nbw1),
                                ne10);
                }
            }
        }
    #else
        for (int64_t i13 = 0; i13 < ne13; ++i13) {
            for (int64_t i12 = 0; i12 < ne12; ++i12) {
                for (int64_t i11 = 0; i11 < ne11; ++i11) {
                    size_t bs = wsp_ggml_blck_size(vec_dot_type);
                    int64_t ne10_block_start = (ith * ne10/bs) / nth;
                    int64_t ne10_block_end   = ((ith + 1) * ne10/bs) / nth;
                    from_float((float *)((char *) src1->data + i13*nb13 + i12*nb12 + i11*nb11 + ne10_block_start*bs*nb10),
                               (void *)               (wdata + i13*nbw3 + i12*nbw2 + i11*nbw1 + ne10_block_start*nbw0),
                               (ne10_block_end - ne10_block_start) * bs);
                }
            }
        }
    #endif
    }

    if (ith == 0) {
        // Every thread starts at ith, so the first unprocessed chunk is nth.  This save a bit of coordination right at the start.
        atomic_store_explicit(&params->threadpool->current_chunk, nth, memory_order_relaxed);
    }

    wsp_ggml_barrier(params->threadpool);

#if WSP_GGML_USE_LLAMAFILE
    if (src1->type != vec_dot_type) {
        const void* wdata = (src1->type == vec_dot_type) ? src1->data : params->wdata;
        const size_t row_size = wsp_ggml_row_size(vec_dot_type, ne10);

        for (int64_t i13 = 0; i13 < ne13; i13++)
            for (int64_t i12 = 0; i12 < ne12; i12++)
                if (!llamafile_sgemm(params,
                                     ne01, ne11, ne00/wsp_ggml_blck_size(src0->type),
                                     (const char *)src0->data + i12/r2*nb02 + i13/r3*nb03,
                                     nb01/wsp_ggml_type_size(src0->type),
                                     (const char *)wdata + (i12*ne11 + i13*ne12*ne11)*row_size,
                                     row_size/wsp_ggml_type_size(vec_dot_type),
                                     (char *)dst->data + i12*nb2 + i13*nb3,
                                     nb1/wsp_ggml_type_size(dst->type),
                                     src0->type,
                                     vec_dot_type,
                                     dst->type))
                    goto UseGgmlGemm2;
        return;
    }
UseGgmlGemm2:;
#endif

    // This is the size of the first dimension of the result, so we can iterate that way. (see the ASSERT above, these are the same numbers)
    const int64_t nr0 = ne0;

    // This is the size of the rest of the dimensions of the result
    const int64_t nr1 = ne1 * ne2 * ne3;

    // Now select a reasonable chunk size.
    int chunk_size = 16;

    // We need to step up the size if it's small
    if (nr0 == 1 || nr1 == 1) {
        chunk_size = 64;
    }

    // distribute the work across the inner or outer loop based on which one is larger
    // The number of chunks in the 0/1 dim.
    // CEIL(nr0/chunk_size)
    int64_t nchunk0 = (nr0 + chunk_size - 1) / chunk_size;
    int64_t nchunk1 = (nr1 + chunk_size - 1) / chunk_size;

    // If the chunking is poor for the number of threads on this setup, scrap the whole plan.  Re-chunk it by thread.
    //   Also, chunking by thread was measured to have perform better on NUMA systems.  See https://github.com/ggml-org/llama.cpp/pull/6915
    //   In theory, chunking should be just as useful on NUMA and non NUMA systems, but testing disagreed with that.
    if (nchunk0 * nchunk1 < nth * 4 || wsp_ggml_is_numa()) {
        // distribute the thread work across the inner or outer loop based on which one is larger
        nchunk0 = nr0 > nr1 ? nth : 1; // parallelize by src0 rows
        nchunk1 = nr0 > nr1 ? 1 : nth; // parallelize by src1 rows
    }

    // The number of elements in each chunk
    const int64_t dr0 = (nr0 + nchunk0 - 1) / nchunk0;
    const int64_t dr1 = (nr1 + nchunk1 - 1) / nchunk1;

    // The first chunk comes from our thread_id, the rest will get auto-assigned.
    int current_chunk = ith;

    while (current_chunk < nchunk0 * nchunk1) {
        const int64_t ith0 = current_chunk % nchunk0;
        const int64_t ith1 = current_chunk / nchunk0;

        const int64_t ir0_start = dr0 * ith0;
        const int64_t ir0_end = MIN(ir0_start + dr0, nr0);

        const int64_t ir1_start = dr1 * ith1;
        const int64_t ir1_end = MIN(ir1_start + dr1, nr1);

        // dot kernels can handle 1 row and col at a time, but mmla kernels can process 2 rows and cols
        int64_t num_rows_per_vec_dot = vec_dot_num_rows;

        // these checks are needed to avoid crossing dim1 boundaries
        // can be optimized, but the logic would become more complicated, so keeping it like this for simplicity
        if ((nr0 % 2 != 0) || (ne11 % 2 != 0) || ((ir0_end - ir0_start) % 2 != 0) || ((ir1_end - ir1_start) % 2 != 0)) {
            num_rows_per_vec_dot = 1;
        }
        wsp_ggml_compute_forward_mul_mat_one_chunk(params, dst, src0->type, num_rows_per_vec_dot, ir0_start, ir0_end, ir1_start, ir1_end);

        if (nth >= nchunk0 * nchunk1) {
            break;
        }

        current_chunk = atomic_fetch_add_explicit(&params->threadpool->current_chunk, 1, memory_order_relaxed);
    }
}

// wsp_ggml_compute_forward_mul_mat_id

#define MMID_MATRIX_ROW(row_id, i1) matrix_rows[(row_id)*ids->ne[0]*ids->ne[1] + (i1)]

struct mmid_row_mapping {
    int32_t i1;
    int32_t i2;
};

static void wsp_ggml_compute_forward_mul_mat_id_one_chunk(
    struct wsp_ggml_tensor * dst,
    const struct wsp_ggml_tensor * src0,
    const struct wsp_ggml_tensor * src1,
    const struct wsp_ggml_tensor * ids,
    const int64_t cur_a,
    const int64_t ir0_start,
    const int64_t ir0_end,
    const int64_t ir1_start,
    const int64_t ir1_end,
    const char * src0_cur,
    const struct mmid_row_mapping * matrix_rows,
    const size_t row_size,
    const bool src1_cont,
    const void * wdata) {

    WSP_GGML_TENSOR_BINARY_OP_LOCALS

    const enum wsp_ggml_type type = src0->type;

    wsp_ggml_vec_dot_t    const vec_dot      = type_traits_cpu[type].vec_dot;
    enum wsp_ggml_type    const vec_dot_type = type_traits_cpu[type].vec_dot_type;

    const int64_t blck_0 = 16;
    const int64_t blck_1 = 16;

    float tmp[16];

    for (int64_t iir1 = ir1_start; iir1 < ir1_end; iir1 += blck_1) {
        for (int64_t iir0 = ir0_start; iir0 < ir0_end; iir0 += blck_0) {
            for (int64_t ir1 = iir1; ir1 < iir1 + blck_1 && ir1 < ir1_end; ++ir1) {
                const int64_t _i12 = ir1; // logical row index for this expert

                struct mmid_row_mapping row_mapping = MMID_MATRIX_ROW(cur_a, _i12);
                const int id       = row_mapping.i1; // selected expert index

                const int64_t  i11 = id % ne11;
                const int64_t  i12 = row_mapping.i2; // row index in src1

                const int64_t  i1 = id;  // selected expert index
                const int64_t  i2 = i12; // row

                // desc: when src1 is not a contiguous memory block we have to calculate the offset using the strides
                //       if it is, then we have either copied the data to params->wdata and made it contiguous or we are using
                //       the original src1 data pointer, so we should index using the indices directly
                // TODO: this is a bit of a hack, we should probably have a better way to handle this
                const char * src1_col = (const char *) wdata +
                    (src1_cont || src1->type != vec_dot_type
                    ? (i11      + i12*ne11)*row_size
                    : (i11*nb11 + i12*nb12));

                float * dst_col = (float *) ((char *) dst->data + (i1*nb1 + i2*nb2));

                for (int64_t ir0 = iir0; ir0 < iir0 + blck_0 && ir0 < ir0_end; ++ir0) {
                    vec_dot(ne00, &tmp[ir0 - iir0], 0, src0_cur + ir0*nb01, 0, src1_col, 0, 1);
                }

                memcpy(&dst_col[iir0], tmp, (MIN(iir0 + blck_0, ir0_end) - iir0)*sizeof(float));
            }
        }
    }
}

static void * incr_ptr_aligned(void ** p, size_t size, size_t align) {

    void * ptr = *p;
    ptr = (void *) WSP_GGML_PAD((uintptr_t) ptr, align);
    *p = (void *) ((char *) ptr + size);
    return ptr;
}

static void wsp_ggml_compute_forward_mul_mat_id(
        const struct wsp_ggml_compute_params * params,
              struct wsp_ggml_tensor * dst) {

    const struct wsp_ggml_tensor * src0 = dst->src[0];
    const struct wsp_ggml_tensor * src1 = dst->src[1];
    const struct wsp_ggml_tensor * ids = dst->src[2];

    WSP_GGML_TENSOR_BINARY_OP_LOCALS

    const int ith = params->ith;
    const int nth = params->nth;

    const enum wsp_ggml_type type = src0->type;

    const bool src1_cont = wsp_ggml_is_contiguous(src1);

    enum wsp_ggml_type    const vec_dot_type    = type_traits_cpu[type].vec_dot_type;
    wsp_ggml_from_float_t const from_float      = type_traits_cpu[vec_dot_type].from_float;

    // we don't support permuted src0 or src1
    WSP_GGML_ASSERT(nb00 == wsp_ggml_type_size(type));
    WSP_GGML_ASSERT(nb10 == wsp_ggml_type_size(src1->type));

    // dst cannot be transposed or permuted
    WSP_GGML_ASSERT(nb0 == sizeof(float));
    WSP_GGML_ASSERT(nb0 <= nb1);
    WSP_GGML_ASSERT(nb1 <= nb2);
    WSP_GGML_ASSERT(nb2 <= nb3);

    // row groups
    const int n_ids = ids->ne[0]; // n_expert_used
    const int n_as  = ne02;       // n_expert

    void * wdata_cur = params->wdata;

    if (src1->type != vec_dot_type) {
        incr_ptr_aligned(&wdata_cur, wsp_ggml_row_size(vec_dot_type, wsp_ggml_nelements(src1)), sizeof(int64_t));
    }

    int64_t * matrix_row_counts = // [n_as]
        incr_ptr_aligned(&wdata_cur, n_as*sizeof(int64_t), sizeof(int64_t));

    struct mmid_row_mapping * matrix_rows = // [n_as][ids->ne[0]*ids->ne[1]]
        incr_ptr_aligned(&wdata_cur, n_as*ids->ne[0]*ids->ne[1]*sizeof(struct mmid_row_mapping), sizeof(int64_t));

    char (*atomic_current_chunk)[CACHE_LINE_SIZE] = // [n_as]
        incr_ptr_aligned(&wdata_cur, CACHE_LINE_SIZE * n_as, CACHE_LINE_SIZE);

    WSP_GGML_ASSERT(params->wsize >= (size_t)((char *) wdata_cur - (char *) params->wdata));

    if (src1->type != vec_dot_type) {
        char * wdata = params->wdata;

        const size_t nbw0 = wsp_ggml_type_size(vec_dot_type);
        const size_t nbw1 = wsp_ggml_row_size(vec_dot_type, ne10);
        const size_t nbw2 = nbw1*ne11;
        const size_t nbw3 = nbw2*ne12;

        assert(params->wsize >= ne13*nbw3);
        WSP_GGML_ASSERT(src1->type == WSP_GGML_TYPE_F32);

#if 0
        for (int64_t i13 = 0; i13 < ne13; ++i13) {
            for (int64_t i12 = ith; i12 < ne12; i12 += nth) {
                for (int64_t i11 = 0; i11 < ne11; ++i11) {
                    from_float((float *)((char *) src1->data + i13*nb13 + i12*nb12 + i11*nb11),
                               (void *)               (wdata + i13*nbw3 + i12*nbw2 + i11*nbw1),
                               ne10);
                }
            }
        }
#else
        for (int64_t i13 = 0; i13 < ne13; ++i13) {
            for (int64_t i12 = 0; i12 < ne12; ++i12) {
                for (int64_t i11 = 0; i11 < ne11; ++i11) {
                    size_t bs = wsp_ggml_blck_size(vec_dot_type);
                    int64_t ne10_block_start = (ith * ne10/bs) / nth;
                    int64_t ne10_block_end   = ((ith + 1) * ne10/bs) / nth;
                    from_float((float *)((char *) src1->data + i13*nb13 + i12*nb12 + i11*nb11 + ne10_block_start*bs*nb10),
                               (void *)               (wdata + i13*nbw3 + i12*nbw2 + i11*nbw1 + ne10_block_start*nbw0),
                               (ne10_block_end - ne10_block_start) * bs);
                }
            }
        }
#endif
    }

    if (ith == 0) {
        // initialize matrix_row_counts
        memset(matrix_row_counts, 0, n_as*sizeof(int64_t));

        // group rows by src0 matrix
        for (int64_t iid1 = 0; iid1 < ids->ne[1]; ++iid1) {
            for (int id = 0; id < n_ids; ++id) {
                const int32_t i02 = *(const int32_t *) ((const char *) ids->data + iid1*ids->nb[1] + id*ids->nb[0]);

                assert(i02 >= 0 && i02 < n_as);

                MMID_MATRIX_ROW(i02, matrix_row_counts[i02]) = (struct mmid_row_mapping) {id, iid1};
                matrix_row_counts[i02] += 1;
            }
        }
    }

    // reset current_chunk
    for (int cur_a = ith; cur_a < n_as; cur_a += nth) {
        atomic_int * current_chunk_ctr = (atomic_int *)(atomic_current_chunk + cur_a);
        *current_chunk_ctr = nth;
    }

    wsp_ggml_barrier(params->threadpool);

    for (int cur_a = 0; cur_a < n_as; ++cur_a) {
        const int64_t cne1 = matrix_row_counts[cur_a];

        if (cne1 == 0) {
            continue;
        }

        const char * src0_cur = (const char *) src0->data + cur_a * nb02;
        const void * wdata = (src1->type == vec_dot_type) ? src1->data : params->wdata;
        const size_t row_size = wsp_ggml_row_size(vec_dot_type, ne10);

        const int64_t nr0 = ne01;
        const int64_t nr1 = cne1;

        int chunk_size = 16;
        if (nr0 == 1 || nr1 == 1) {
            chunk_size = 64;
        }

        // disable for NUMA
        const bool disable_chunking = wsp_ggml_is_numa();

        int64_t nchunk0 = (nr0 + chunk_size - 1) / chunk_size;
        int64_t nchunk1 = (nr1 + chunk_size - 1) / chunk_size;

        if (nchunk0 * nchunk1 < nth * 4 || disable_chunking) {
            nchunk0 = nr0 > nr1 ? nth : 1;
            nchunk1 = nr0 > nr1 ? 1 : nth;
        }

        const int64_t dr0 = (nr0 + nchunk0 - 1) / nchunk0;
        const int64_t dr1 = (nr1 + nchunk1 - 1) / nchunk1;

        int current_chunk = ith;

        atomic_int * current_chunk_ctr = (atomic_int *)(atomic_current_chunk + cur_a);

        while (current_chunk < nchunk0 * nchunk1) {
            const int64_t ith0 = current_chunk % nchunk0;
            const int64_t ith1 = current_chunk / nchunk0;

            const int64_t ir0_start = dr0 * ith0;
            const int64_t ir0_end = MIN(ir0_start + dr0, nr0);

            const int64_t ir1_start = dr1 * ith1;
            const int64_t ir1_end = MIN(ir1_start + dr1, nr1);

            wsp_ggml_compute_forward_mul_mat_id_one_chunk(
                dst, src0, src1, ids, cur_a,
                ir0_start, ir0_end, ir1_start, ir1_end,
                src0_cur, matrix_rows, row_size, src1_cont, wdata
            );

            if (nth >= nchunk0 * nchunk1) {
                break;
            }

            current_chunk = atomic_fetch_add_explicit(current_chunk_ctr, 1, memory_order_relaxed);
        }
    }
}

/////////////////////////////////

static void wsp_ggml_compute_forward(struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * tensor) {
    WSP_GGML_ASSERT(params);

    if (tensor->op == WSP_GGML_OP_NONE || wsp_ggml_is_empty(tensor)) {
        return;
    }

    // extra_buffer op?
    if (wsp_ggml_cpu_extra_compute_forward(params, tensor)) {
        return;
    }

    switch (tensor->op) {
        case WSP_GGML_OP_DUP:
            {
                wsp_ggml_compute_forward_dup(params, tensor);
            } break;
        case WSP_GGML_OP_ADD:
            {
                wsp_ggml_compute_forward_add(params, tensor);
            } break;
        case WSP_GGML_OP_ADD_ID:
            {
                wsp_ggml_compute_forward_add_id(params, tensor);
            } break;
        case WSP_GGML_OP_ADD1:
            {
                wsp_ggml_compute_forward_add1(params, tensor);
            } break;
        case WSP_GGML_OP_ACC:
            {
                wsp_ggml_compute_forward_acc(params, tensor);
            } break;
        case WSP_GGML_OP_SUB:
            {
                wsp_ggml_compute_forward_sub(params, tensor);
            } break;
        case WSP_GGML_OP_MUL:
            {
                wsp_ggml_compute_forward_mul(params, tensor);
            } break;
        case WSP_GGML_OP_DIV:
            {
                wsp_ggml_compute_forward_div(params, tensor);
            } break;
        case WSP_GGML_OP_SQR:
            {
                wsp_ggml_compute_forward_sqr(params, tensor);
            } break;
        case WSP_GGML_OP_SQRT:
            {
                wsp_ggml_compute_forward_sqrt(params, tensor);
            } break;
        case WSP_GGML_OP_LOG:
            {
                wsp_ggml_compute_forward_log(params, tensor);
            } break;
        case WSP_GGML_OP_SIN:
            {
                wsp_ggml_compute_forward_sin(params, tensor);
            } break;
        case WSP_GGML_OP_COS:
            {
                wsp_ggml_compute_forward_cos(params, tensor);
            } break;
        case WSP_GGML_OP_SUM:
            {
                wsp_ggml_compute_forward_sum(params, tensor);
            } break;
        case WSP_GGML_OP_SUM_ROWS:
            {
                wsp_ggml_compute_forward_sum_rows(params, tensor);
            } break;
        case WSP_GGML_OP_CUMSUM:
            {
                wsp_ggml_compute_forward_cumsum(params, tensor);
            } break;
        case WSP_GGML_OP_MEAN:
            {
                wsp_ggml_compute_forward_mean(params, tensor);
            } break;
        case WSP_GGML_OP_ARGMAX:
            {
                wsp_ggml_compute_forward_argmax(params, tensor);
            } break;
        case WSP_GGML_OP_COUNT_EQUAL:
            {
                wsp_ggml_compute_forward_count_equal(params, tensor);
            } break;
        case WSP_GGML_OP_REPEAT:
            {
                wsp_ggml_compute_forward_repeat(params, tensor);
            } break;
        case WSP_GGML_OP_REPEAT_BACK:
            {
                wsp_ggml_compute_forward_repeat_back(params, tensor);
            } break;
        case WSP_GGML_OP_CONCAT:
            {
                wsp_ggml_compute_forward_concat(params, tensor);
            } break;
        case WSP_GGML_OP_SILU_BACK:
            {
                wsp_ggml_compute_forward_silu_back(params, tensor);
            } break;
        case WSP_GGML_OP_NORM:
            {
                wsp_ggml_compute_forward_norm(params, tensor);
            } break;
        case WSP_GGML_OP_RMS_NORM:
            {
                wsp_ggml_compute_forward_rms_norm(params, tensor);
            } break;
        case WSP_GGML_OP_RMS_NORM_BACK:
            {
                wsp_ggml_compute_forward_rms_norm_back(params, tensor);
            } break;
        case WSP_GGML_OP_GROUP_NORM:
            {
                wsp_ggml_compute_forward_group_norm(params, tensor);
            } break;
        case WSP_GGML_OP_L2_NORM:
            {
                wsp_ggml_compute_forward_l2_norm(params, tensor);
            } break;
        case WSP_GGML_OP_MUL_MAT:
            {
                wsp_ggml_compute_forward_mul_mat(params, tensor);
            } break;
        case WSP_GGML_OP_MUL_MAT_ID:
            {
                wsp_ggml_compute_forward_mul_mat_id(params, tensor);
            } break;
        case WSP_GGML_OP_OUT_PROD:
            {
                wsp_ggml_compute_forward_out_prod(params, tensor);
            } break;
        case WSP_GGML_OP_SCALE:
            {
                wsp_ggml_compute_forward_scale(params, tensor);
            } break;
        case WSP_GGML_OP_SET:
            {
                wsp_ggml_compute_forward_set(params, tensor);
            } break;
        case WSP_GGML_OP_CPY:
            {
                wsp_ggml_compute_forward_cpy(params, tensor);
            } break;
        case WSP_GGML_OP_CONT:
            {
                wsp_ggml_compute_forward_cont(params, tensor);
            } break;
        case WSP_GGML_OP_GET_ROWS:
            {
                wsp_ggml_compute_forward_get_rows(params, tensor);
            } break;
        case WSP_GGML_OP_GET_ROWS_BACK:
            {
                wsp_ggml_compute_forward_get_rows_back(params, tensor);
            } break;
        case WSP_GGML_OP_SET_ROWS:
            {
                wsp_ggml_compute_forward_set_rows(params, tensor);
            } break;
        case WSP_GGML_OP_DIAG:
            {
                wsp_ggml_compute_forward_diag(params, tensor);
            } break;
        case WSP_GGML_OP_DIAG_MASK_INF:
            {
                wsp_ggml_compute_forward_diag_mask_inf(params, tensor);
            } break;
        case WSP_GGML_OP_DIAG_MASK_ZERO:
            {
                wsp_ggml_compute_forward_diag_mask_zero(params, tensor);
            } break;
        case WSP_GGML_OP_SOFT_MAX:
            {
                wsp_ggml_compute_forward_soft_max(params, tensor);
            } break;
        case WSP_GGML_OP_SOFT_MAX_BACK:
            {
                wsp_ggml_compute_forward_soft_max_ext_back(params, tensor);
            } break;
        case WSP_GGML_OP_ROPE:
            {
                wsp_ggml_compute_forward_rope(params, tensor);
            } break;
        case WSP_GGML_OP_ROPE_BACK:
            {
                wsp_ggml_compute_forward_rope_back(params, tensor);
            } break;
        case WSP_GGML_OP_CLAMP:
            {
                wsp_ggml_compute_forward_clamp(params, tensor);
            } break;
        case WSP_GGML_OP_CONV_TRANSPOSE_1D:
            {
                wsp_ggml_compute_forward_conv_transpose_1d(params, tensor);
            } break;
        case WSP_GGML_OP_IM2COL:
            {
                wsp_ggml_compute_forward_im2col(params, tensor);
            } break;
        case WSP_GGML_OP_IM2COL_BACK:
            {
                wsp_ggml_compute_forward_im2col_back_f32(params, tensor);
            } break;
        case WSP_GGML_OP_IM2COL_3D:
            {
                wsp_ggml_compute_forward_im2col_3d(params, tensor);
            } break;
        case WSP_GGML_OP_CONV_2D:
            {
                wsp_ggml_compute_forward_conv_2d(params, tensor);
            } break;
        case WSP_GGML_OP_CONV_3D:
            {
                wsp_ggml_compute_forward_conv_3d(params, tensor);
            } break;
        case WSP_GGML_OP_CONV_2D_DW:
            {
                wsp_ggml_compute_forward_conv_2d_dw(params, tensor);
            } break;
        case WSP_GGML_OP_CONV_TRANSPOSE_2D:
            {
                wsp_ggml_compute_forward_conv_transpose_2d(params, tensor);
            } break;
        case WSP_GGML_OP_POOL_1D:
            {
                wsp_ggml_compute_forward_pool_1d(params, tensor);
            } break;
        case WSP_GGML_OP_POOL_2D:
            {
                wsp_ggml_compute_forward_pool_2d(params, tensor);
            } break;
        case WSP_GGML_OP_POOL_2D_BACK:
            {
                wsp_ggml_compute_forward_pool_2d_back(params, tensor);
            } break;
        case WSP_GGML_OP_UPSCALE:
            {
                wsp_ggml_compute_forward_upscale(params, tensor);
            } break;
        case WSP_GGML_OP_PAD:
            {
                wsp_ggml_compute_forward_pad(params, tensor);
            } break;
        case WSP_GGML_OP_PAD_REFLECT_1D:
            {
                wsp_ggml_compute_forward_pad_reflect_1d(params, tensor);
            } break;
        case WSP_GGML_OP_ROLL:
            {
                wsp_ggml_compute_forward_roll(params, tensor);
            } break;
        case WSP_GGML_OP_ARANGE:
            {
                wsp_ggml_compute_forward_arange(params, tensor);
            } break;
        case WSP_GGML_OP_TIMESTEP_EMBEDDING:
            {
                wsp_ggml_compute_forward_timestep_embedding(params, tensor);
            } break;
        case WSP_GGML_OP_ARGSORT:
            {
                wsp_ggml_compute_forward_argsort(params, tensor);
            } break;
        case WSP_GGML_OP_LEAKY_RELU:
            {
                wsp_ggml_compute_forward_leaky_relu(params, tensor);
            } break;
        case WSP_GGML_OP_TRI:
            {
                wsp_ggml_compute_forward_tri(params, tensor);
            } break;
        case WSP_GGML_OP_FILL:
            {
                wsp_ggml_compute_forward_fill(params, tensor);
            } break;
        case WSP_GGML_OP_FLASH_ATTN_EXT:
            {
                wsp_ggml_compute_forward_flash_attn_ext(params, tensor);
            } break;
        case WSP_GGML_OP_FLASH_ATTN_BACK:
            {
                int32_t t = wsp_ggml_get_op_params_i32(tensor, 0);
                WSP_GGML_ASSERT(t == 0 || t == 1);
                bool masked = t != 0;
                wsp_ggml_compute_forward_flash_attn_back(params, masked, tensor);
            } break;
        case WSP_GGML_OP_SSM_CONV:
            {
                wsp_ggml_compute_forward_ssm_conv(params, tensor);
            } break;
        case WSP_GGML_OP_SSM_SCAN:
            {
                wsp_ggml_compute_forward_ssm_scan(params, tensor);
            } break;
        case WSP_GGML_OP_WIN_PART:
            {
                wsp_ggml_compute_forward_win_part(params, tensor);
            } break;
        case WSP_GGML_OP_WIN_UNPART:
            {
                wsp_ggml_compute_forward_win_unpart(params, tensor);
            } break;
        case WSP_GGML_OP_UNARY:
            {
                wsp_ggml_compute_forward_unary(params, tensor);
            } break;
        case WSP_GGML_OP_GLU:
            {
                wsp_ggml_compute_forward_glu(params, tensor);
            } break;
        case WSP_GGML_OP_GET_REL_POS:
            {
                wsp_ggml_compute_forward_get_rel_pos(params, tensor);
            } break;
        case WSP_GGML_OP_ADD_REL_POS:
            {
                wsp_ggml_compute_forward_add_rel_pos(params, tensor);
            } break;
        case WSP_GGML_OP_RWKV_WKV6:
            {
                wsp_ggml_compute_forward_rwkv_wkv6(params, tensor);
            } break;
        case WSP_GGML_OP_GATED_LINEAR_ATTN:
            {
                wsp_ggml_compute_forward_gla(params, tensor);
            } break;
        case WSP_GGML_OP_RWKV_WKV7:
            {
                wsp_ggml_compute_forward_rwkv_wkv7(params, tensor);
            } break;
        case WSP_GGML_OP_SOLVE_TRI:
            {
                wsp_ggml_compute_forward_solve_tri(params, tensor);
            } break;
        case WSP_GGML_OP_MAP_CUSTOM1:
            {
                wsp_ggml_compute_forward_map_custom1(params, tensor);
            }
            break;
        case WSP_GGML_OP_MAP_CUSTOM2:
            {
                wsp_ggml_compute_forward_map_custom2(params, tensor);
            }
            break;
        case WSP_GGML_OP_MAP_CUSTOM3:
            {
                wsp_ggml_compute_forward_map_custom3(params, tensor);
            }
            break;
        case WSP_GGML_OP_CUSTOM:
            {
                wsp_ggml_compute_forward_custom(params, tensor);
            }
            break;
        case WSP_GGML_OP_CROSS_ENTROPY_LOSS:
            {
                wsp_ggml_compute_forward_cross_entropy_loss(params, tensor);
            }
            break;
        case WSP_GGML_OP_CROSS_ENTROPY_LOSS_BACK:
            {
                wsp_ggml_compute_forward_cross_entropy_loss_back(params, tensor);
            }
            break;
        case WSP_GGML_OP_OPT_STEP_ADAMW:
            {
                wsp_ggml_compute_forward_opt_step_adamw(params, tensor);
            }
            break;
        case WSP_GGML_OP_OPT_STEP_SGD:
            {
                wsp_ggml_compute_forward_opt_step_sgd(params, tensor);
            }
            break;
        case WSP_GGML_OP_NONE:
            {
                // nop
            } break;
        case WSP_GGML_OP_RESHAPE:
            {
                // nop
            } break;
        case WSP_GGML_OP_PERMUTE:
            {
                // nop
            } break;
        case WSP_GGML_OP_VIEW:
            {
                // nop
            } break;
        case WSP_GGML_OP_TRANSPOSE:
            {
                // nop
            } break;
        case WSP_GGML_OP_COUNT:
            {
                WSP_GGML_ABORT("fatal error");
            }
    }
}

// Android's libc implementation "bionic" does not support setting affinity
#if defined(__gnu_linux__)
static void set_numa_thread_affinity(int thread_n) {
    if (!wsp_ggml_is_numa()) {
        return;
    }

    int node_num;
    int rv;
    size_t setsize = CPU_ALLOC_SIZE(g_state.numa.total_cpus);

    switch(g_state.numa.numa_strategy) {
        case WSP_GGML_NUMA_STRATEGY_DISTRIBUTE:
            // run thread on node_num thread_n / (threads per node)
            node_num = thread_n % g_state.numa.n_nodes;
            break;
        case WSP_GGML_NUMA_STRATEGY_ISOLATE:
            // run thread on current_node
            node_num = g_state.numa.current_node;
            break;
        case WSP_GGML_NUMA_STRATEGY_NUMACTL:
            // use the cpuset that numactl gave us
            rv = pthread_setaffinity_np(pthread_self(), setsize, &g_state.numa.cpuset);
            if (rv) {
                fprintf(stderr, "warning: pthread_setaffinity_np() failed: %s\n",strerror(rv));
            }
            return;
        default:
            return;
    }

    struct wsp_ggml_numa_node * node = &g_state.numa.nodes[node_num];

    cpu_set_t * cpus = CPU_ALLOC(g_state.numa.total_cpus);
    CPU_ZERO_S(setsize, cpus);
    for (size_t i = 0; i < node->n_cpus; ++i) {
        CPU_SET_S(node->cpus[i], setsize, cpus);
    }

    rv = pthread_setaffinity_np(pthread_self(), setsize, cpus);
    if (rv) {
            fprintf(stderr, "warning: pthread_setaffinity_np() failed: %s\n", strerror(rv));
    }

    CPU_FREE(cpus);
}

static void clear_numa_thread_affinity(void) {
    if (!wsp_ggml_is_numa()) {
        return;
    }

    size_t setsize = CPU_ALLOC_SIZE(g_state.numa.total_cpus);

    cpu_set_t * cpus = CPU_ALLOC(g_state.numa.total_cpus);
    CPU_ZERO_S(setsize, cpus);
    for (unsigned i = 0; i < g_state.numa.total_cpus; ++i) {
        CPU_SET_S(i, setsize, cpus);
    }

    int rv = pthread_setaffinity_np(pthread_self(), setsize, cpus);
    if (rv) {
        fprintf(stderr, "warning: pthread_setaffinity_np() failed: %s\n", strerror(rv));
    }

    CPU_FREE(cpus);
}
#else
// TODO: Windows etc.
// (the linux implementation may also work on BSD, someone should test)
static void set_numa_thread_affinity(int thread_n) { UNUSED(thread_n);  }
static void clear_numa_thread_affinity(void) {}
#endif

static int wsp_ggml_get_n_tasks(struct wsp_ggml_tensor * node, int n_threads) {
    int n_tasks = 0;

    if (wsp_ggml_is_empty(node)) {
        // no need to multi-thread a no-op
        n_tasks = 1;
        return n_tasks;
    }

    switch (node->op) {
        case WSP_GGML_OP_CPY:
        case WSP_GGML_OP_DUP:
        case WSP_GGML_OP_CONT:
        case WSP_GGML_OP_ADD:
        case WSP_GGML_OP_ADD_ID:
        case WSP_GGML_OP_ADD1:
        case WSP_GGML_OP_ACC:
        case WSP_GGML_OP_CUMSUM:
        case WSP_GGML_OP_TRI:
        case WSP_GGML_OP_FILL:
            {
                n_tasks = n_threads;
            } break;
        case WSP_GGML_OP_SUB:
        case WSP_GGML_OP_SQR:
        case WSP_GGML_OP_SQRT:
        case WSP_GGML_OP_LOG:
        case WSP_GGML_OP_SIN:
        case WSP_GGML_OP_COS:
        case WSP_GGML_OP_SUM:
        case WSP_GGML_OP_SUM_ROWS:
        case WSP_GGML_OP_MEAN:
        case WSP_GGML_OP_ARGMAX:
            {
                n_tasks = 1;
            } break;
        case WSP_GGML_OP_COUNT_EQUAL:
        case WSP_GGML_OP_SOLVE_TRI:
            {
                n_tasks = n_threads;
            } break;
        case WSP_GGML_OP_REPEAT:
        case WSP_GGML_OP_REPEAT_BACK:
        case WSP_GGML_OP_LEAKY_RELU:
            {
                n_tasks = 1;
            } break;
        case WSP_GGML_OP_UNARY:
            switch (wsp_ggml_get_unary_op(node)) {
                case WSP_GGML_UNARY_OP_ABS:
                case WSP_GGML_UNARY_OP_SGN:
                case WSP_GGML_UNARY_OP_NEG:
                case WSP_GGML_UNARY_OP_STEP:
                case WSP_GGML_UNARY_OP_TANH:
                case WSP_GGML_UNARY_OP_ELU:
                case WSP_GGML_UNARY_OP_RELU:
                case WSP_GGML_UNARY_OP_SIGMOID:
                case WSP_GGML_UNARY_OP_HARDSWISH:
                case WSP_GGML_UNARY_OP_HARDSIGMOID:
                case WSP_GGML_UNARY_OP_EXP:
                case WSP_GGML_UNARY_OP_SOFTPLUS:
                case WSP_GGML_UNARY_OP_EXPM1:
                case WSP_GGML_UNARY_OP_FLOOR:
                case WSP_GGML_UNARY_OP_CEIL:
                case WSP_GGML_UNARY_OP_ROUND:
                case WSP_GGML_UNARY_OP_TRUNC:
                    {
                        n_tasks = 1;
                    } break;

                case WSP_GGML_UNARY_OP_GELU:
                case WSP_GGML_UNARY_OP_GELU_ERF:
                case WSP_GGML_UNARY_OP_GELU_QUICK:
                case WSP_GGML_UNARY_OP_SILU:
                case WSP_GGML_UNARY_OP_XIELU:
                    {
                        n_tasks = n_threads;
                    } break;
                default:
                    WSP_GGML_ABORT("fatal error");
            }
            break;
        case WSP_GGML_OP_GLU:
            switch (wsp_ggml_get_glu_op(node)) {
                case WSP_GGML_GLU_OP_REGLU:
                case WSP_GGML_GLU_OP_GEGLU:
                case WSP_GGML_GLU_OP_SWIGLU:
                case WSP_GGML_GLU_OP_SWIGLU_OAI:
                case WSP_GGML_GLU_OP_GEGLU_ERF:
                case WSP_GGML_GLU_OP_GEGLU_QUICK:
                    {
                        n_tasks = n_threads;
                    } break;
                default:
                    WSP_GGML_ABORT("fatal error");
            }
            break;
        case WSP_GGML_OP_SILU_BACK:
        case WSP_GGML_OP_MUL:
        case WSP_GGML_OP_DIV:
        case WSP_GGML_OP_NORM:
        case WSP_GGML_OP_RMS_NORM:
        case WSP_GGML_OP_RMS_NORM_BACK:
        case WSP_GGML_OP_L2_NORM:
        case WSP_GGML_OP_GROUP_NORM:
        case WSP_GGML_OP_CONCAT:
        case WSP_GGML_OP_MUL_MAT:
        case WSP_GGML_OP_MUL_MAT_ID:
        case WSP_GGML_OP_OUT_PROD:
            {
                n_tasks = n_threads;
            } break;
        case WSP_GGML_OP_GET_ROWS:
        case WSP_GGML_OP_SET_ROWS:
            {
                // FIXME: get_rows can use additional threads, but the cost of launching additional threads
                // decreases performance with GPU offloading
                //n_tasks = n_threads;
                n_tasks = 1;
            } break;
        case WSP_GGML_OP_SCALE:
        case WSP_GGML_OP_SET:
        case WSP_GGML_OP_RESHAPE:
        case WSP_GGML_OP_VIEW:
        case WSP_GGML_OP_PERMUTE:
        case WSP_GGML_OP_TRANSPOSE:
        case WSP_GGML_OP_GET_ROWS_BACK:
        case WSP_GGML_OP_DIAG:
            {
                n_tasks = 1;
            } break;
        case WSP_GGML_OP_DIAG_MASK_ZERO:
        case WSP_GGML_OP_DIAG_MASK_INF:
        case WSP_GGML_OP_SOFT_MAX_BACK:
        case WSP_GGML_OP_ROPE:
        case WSP_GGML_OP_ROPE_BACK:
        case WSP_GGML_OP_ADD_REL_POS:
            {
                n_tasks = n_threads;
            } break;
        case WSP_GGML_OP_CLAMP:
            {
                n_tasks = 1; //TODO
            } break;
        case WSP_GGML_OP_SOFT_MAX:
            {
                n_tasks = MIN(n_threads, wsp_ggml_nrows(node->src[0]));
            } break;
        case WSP_GGML_OP_IM2COL:
        case WSP_GGML_OP_IM2COL_BACK:
        case WSP_GGML_OP_IM2COL_3D:
        case WSP_GGML_OP_CONV_2D:
        case WSP_GGML_OP_CONV_3D:
        case WSP_GGML_OP_CONV_2D_DW:
        case WSP_GGML_OP_CONV_TRANSPOSE_1D:
        case WSP_GGML_OP_CONV_TRANSPOSE_2D:
            {
                n_tasks = n_threads;
            } break;
        case WSP_GGML_OP_POOL_1D:
        case WSP_GGML_OP_POOL_2D:
        case WSP_GGML_OP_POOL_2D_BACK:
            {
                n_tasks = 1;
            } break;
        case WSP_GGML_OP_UPSCALE:
        case WSP_GGML_OP_PAD:
        case WSP_GGML_OP_PAD_REFLECT_1D:
        case WSP_GGML_OP_ROLL:
        case WSP_GGML_OP_ARANGE:
        case WSP_GGML_OP_TIMESTEP_EMBEDDING:
        case WSP_GGML_OP_ARGSORT:
        case WSP_GGML_OP_FLASH_ATTN_EXT:
        case WSP_GGML_OP_FLASH_ATTN_BACK:
        case WSP_GGML_OP_SSM_CONV:
        case WSP_GGML_OP_SSM_SCAN:
        case WSP_GGML_OP_RWKV_WKV6:
        case WSP_GGML_OP_GATED_LINEAR_ATTN:
        case WSP_GGML_OP_RWKV_WKV7:
            {
                n_tasks = n_threads;
            } break;
        case WSP_GGML_OP_WIN_PART:
        case WSP_GGML_OP_WIN_UNPART:
        case WSP_GGML_OP_GET_REL_POS:
            {
                n_tasks = 1;
            } break;
        case WSP_GGML_OP_MAP_CUSTOM1:
            {
                struct wsp_ggml_map_custom1_op_params p;
                memcpy(&p, node->op_params, sizeof(p));
                if (p.n_tasks == WSP_GGML_N_TASKS_MAX) {
                    n_tasks = n_threads;
                } else {
                    n_tasks = MIN(p.n_tasks, n_threads);
                }
            } break;
        case WSP_GGML_OP_MAP_CUSTOM2:
            {
                struct wsp_ggml_map_custom2_op_params p;
                memcpy(&p, node->op_params, sizeof(p));
                if (p.n_tasks == WSP_GGML_N_TASKS_MAX) {
                    n_tasks = n_threads;
                } else {
                    n_tasks = MIN(p.n_tasks, n_threads);
                }
            } break;
        case WSP_GGML_OP_MAP_CUSTOM3:
            {
                struct wsp_ggml_map_custom3_op_params p;
                memcpy(&p, node->op_params, sizeof(p));
                if (p.n_tasks == WSP_GGML_N_TASKS_MAX) {
                    n_tasks = n_threads;
                } else {
                    n_tasks = MIN(p.n_tasks, n_threads);
                }
            } break;
        case WSP_GGML_OP_CUSTOM:
            {
                struct wsp_ggml_custom_op_params p;
                memcpy(&p, node->op_params, sizeof(p));
                if (p.n_tasks == WSP_GGML_N_TASKS_MAX) {
                    n_tasks = n_threads;
                } else {
                    n_tasks = MIN(p.n_tasks, n_threads);
                }
            } break;
        case WSP_GGML_OP_CROSS_ENTROPY_LOSS:
        case WSP_GGML_OP_CROSS_ENTROPY_LOSS_BACK:
        case WSP_GGML_OP_OPT_STEP_ADAMW:
        case WSP_GGML_OP_OPT_STEP_SGD:
            {
                n_tasks = n_threads;
            } break;
        case WSP_GGML_OP_NONE:
            {
                n_tasks = 1;
            } break;
        case WSP_GGML_OP_COUNT:
            {
                WSP_GGML_ABORT("fatal error");
            }
        default:
            {
                fprintf(stderr, "%s: op not implemented: ", __func__);
                if (node->op < WSP_GGML_OP_COUNT) {
                    fprintf(stderr, "%s\n", wsp_ggml_op_name(node->op));
                } else {
                    fprintf(stderr, "%d\n", node->op);
                }
                WSP_GGML_ABORT("fatal error");
            }
    }

    assert(n_tasks > 0);

    return n_tasks;
}

static thread_ret_t wsp_ggml_graph_compute_secondary_thread(void* data);

#if defined(_WIN32)
#include "windows.h"

// TODO: support > 64 CPUs
static bool wsp_ggml_thread_apply_affinity(bool * mask) {
    HANDLE    h = GetCurrentThread();
    uint64_t  bitmask = 0ULL;

    assert(WSP_GGML_MAX_N_THREADS >= 64);

    for (int32_t i = 0; i < 8; i++) {
        int32_t idx = i * 8;
        uint8_t val = 0;
        val |= mask[idx + 0] << 0;
        val |= mask[idx + 1] << 1;
        val |= mask[idx + 2] << 2;
        val |= mask[idx + 3] << 3;
        val |= mask[idx + 4] << 4;
        val |= mask[idx + 5] << 5;
        val |= mask[idx + 6] << 6;
        val |= mask[idx + 7] << 7;
        bitmask |= (uint64_t)val << idx;
    }

    for (int32_t i = 64; i < WSP_GGML_MAX_N_THREADS; i++) {
        if (mask[i]) {
            fprintf(stderr, "warn: setting thread-affinity for > 64 CPUs isn't supported on windows!\n");
            break;
        }
    }

    DWORD_PTR m = (DWORD_PTR)bitmask;

    m = SetThreadAffinityMask(h, m);

    return m != 0;
}

static bool wsp_ggml_thread_apply_priority(int32_t prio) {
    // Note that on Windows the Process Priority Class must be updated in order to set Thread priority.
    // This is up to the applications.
    DWORD p = THREAD_PRIORITY_NORMAL;
    switch (prio) {
        case WSP_GGML_SCHED_PRIO_LOW:      p = THREAD_PRIORITY_BELOW_NORMAL;  break;
        case WSP_GGML_SCHED_PRIO_NORMAL:   p = THREAD_PRIORITY_NORMAL;        break;
        case WSP_GGML_SCHED_PRIO_MEDIUM:   p = THREAD_PRIORITY_ABOVE_NORMAL;  break;
        case WSP_GGML_SCHED_PRIO_HIGH:     p = THREAD_PRIORITY_HIGHEST;       break;
        case WSP_GGML_SCHED_PRIO_REALTIME: p = THREAD_PRIORITY_TIME_CRITICAL; break;
    }

    if (prio != WSP_GGML_SCHED_PRIO_LOW) {
        // Tell Windows that this thread should not be throttled (needs its own CPU core).
        // Newer Windows 11 versions aggresively park (offline) CPU cores and often place
        // all our threads onto the first 4 cores which results in terrible performance with
        // n_threads > 4
        #if _WIN32_WINNT >= 0x0602
        THREAD_POWER_THROTTLING_STATE t;
        ZeroMemory(&t, sizeof(t));
        t.Version     = THREAD_POWER_THROTTLING_CURRENT_VERSION;
        t.ControlMask = THREAD_POWER_THROTTLING_EXECUTION_SPEED;
        t.StateMask   = 0;

        if (!SetThreadInformation(GetCurrentThread(), ThreadPowerThrottling, &t, sizeof(t))) {
            WSP_GGML_LOG_DEBUG("failed to disable thread power throttling %d : (%d)\n", prio, (int) GetLastError());
            return false;
        }
        #endif
    }

    if (prio == WSP_GGML_SCHED_PRIO_NORMAL) {
        // Keep inherited policy/priority
        return true;
    }

    if (!SetThreadPriority(GetCurrentThread(), p)) {
        fprintf(stderr, "warn: failed to set thread priority %d : (%d)\n", prio, (int) GetLastError());
        return false;
    }

    return true;
}

#elif defined(__APPLE__)
#include <sys/types.h>
#include <sys/resource.h>

static bool wsp_ggml_thread_apply_affinity(const bool * mask) {
    // Not supported on Apple platforms
    UNUSED(mask);
    return true;
}

static bool wsp_ggml_thread_apply_priority(int32_t prio) {
    struct sched_param p;
    int32_t policy = SCHED_OTHER;
    switch (prio) {
        // TODO: there seems to be no way to set lower prio on Apple platforms
        case WSP_GGML_SCHED_PRIO_LOW:      policy = SCHED_OTHER; p.sched_priority = 0;  break;
        case WSP_GGML_SCHED_PRIO_NORMAL:   policy = SCHED_OTHER; p.sched_priority = 0;  break;
        case WSP_GGML_SCHED_PRIO_MEDIUM:   policy = SCHED_FIFO;  p.sched_priority = 40; break;
        case WSP_GGML_SCHED_PRIO_HIGH:     policy = SCHED_FIFO;  p.sched_priority = 80; break;
        case WSP_GGML_SCHED_PRIO_REALTIME: policy = SCHED_FIFO;  p.sched_priority = 90; break;
    }

    if (prio == WSP_GGML_SCHED_PRIO_NORMAL) {
        // Keep inherited policy/priority
        return true;
    }

    int32_t err = pthread_setschedparam(pthread_self(), policy, &p);
    if (err != 0) {
        fprintf(stderr, "warn: failed to set thread priority %d : %s (%d)\n", prio, strerror(err), err);
        return false;
    }

    return true;
}

#elif defined(__gnu_linux__)
// TODO: this may not work on BSD, to be verified

static bool wsp_ggml_thread_apply_affinity(const bool * mask) {
    cpu_set_t cpuset;
    int err;

    CPU_ZERO(&cpuset);

    for (uint32_t i = 0; i < WSP_GGML_MAX_N_THREADS; i++) {
        if (mask[i]) {
            WSP_GGML_PRINT_DEBUG("Thread %lx: adding %d to cpuset\n", pthread_self(), i);
            CPU_SET(i, &cpuset);
        }
    }

#ifdef __ANDROID__
    err = sched_setaffinity(0, sizeof(cpuset), &cpuset);
    if (err < 0) {
        err = errno;
    }
#else
    err = pthread_setaffinity_np(pthread_self(), sizeof(cpuset), &cpuset);
#endif
    if (err != 0) {
        fprintf(stderr, "warn: failed to set affinity mask 0x%llx : %s (%d)\n", (unsigned long long)mask, strerror(err), err);
        return false;
    }

    return true;
}

static bool wsp_ggml_thread_apply_priority(int32_t prio) {
    struct sched_param p;
    int32_t policy = SCHED_OTHER;
    switch (prio) {
        case WSP_GGML_SCHED_PRIO_LOW:      policy = SCHED_BATCH; p.sched_priority = 0;  break;
        case WSP_GGML_SCHED_PRIO_NORMAL:   policy = SCHED_OTHER; p.sched_priority = 0;  break;
        case WSP_GGML_SCHED_PRIO_MEDIUM:   policy = SCHED_FIFO;  p.sched_priority = 40; break;
        case WSP_GGML_SCHED_PRIO_HIGH:     policy = SCHED_FIFO;  p.sched_priority = 80; break;
        case WSP_GGML_SCHED_PRIO_REALTIME: policy = SCHED_FIFO;  p.sched_priority = 90; break;
    }

    if (prio == WSP_GGML_SCHED_PRIO_NORMAL) {
        // Keep inherited policy/priority
        return true;
    }

    int32_t err = pthread_setschedparam(pthread_self(), policy, &p);
    if (err != 0) {
        fprintf(stderr, "warn: failed to set thread priority %d : %s (%d)\n", prio, strerror(err), err);
        return false;
    }

    return true;
}

#else // unsupported platforms

static bool wsp_ggml_thread_apply_affinity(const bool * mask) {
    UNUSED(mask);
    return true;
}

static bool wsp_ggml_thread_apply_priority(int32_t prio) {
    UNUSED(prio);
    return true;
}

#endif

static bool wsp_ggml_thread_cpumask_is_valid(const bool * mask) {
    for (int i = 0; i < WSP_GGML_MAX_N_THREADS; i++) {
        if (mask[i]) { return true; }
    }
    return false;
}

static void wsp_ggml_thread_cpumask_next(const bool * global_mask, bool * local_mask, bool strict, int32_t* iter) {
    if (!strict) {
        memcpy(local_mask, global_mask, WSP_GGML_MAX_N_THREADS);
        return;
    } else {
        memset(local_mask, 0, WSP_GGML_MAX_N_THREADS);
        int32_t base_idx = *iter;
        for (int32_t i = 0; i < WSP_GGML_MAX_N_THREADS; i++) {
            int32_t idx = base_idx + i;
            if (idx >= WSP_GGML_MAX_N_THREADS) {
                // Just a cheaper modulo
                idx -= WSP_GGML_MAX_N_THREADS;
            }
            if (global_mask[idx]) {
                local_mask[idx] = 1;
                *iter = idx + 1;
                return;
            }
        }
    }
}

void wsp_ggml_threadpool_free(struct wsp_ggml_threadpool* threadpool) {
    if (!threadpool) return;

    const int n_threads = threadpool->n_threads_max;

#ifndef WSP_GGML_USE_OPENMP
    struct wsp_ggml_compute_state* workers = threadpool->workers;

    wsp_ggml_mutex_lock(&threadpool->mutex);

    threadpool->stop = true;
    threadpool->pause = false;

    wsp_ggml_cond_broadcast(&threadpool->cond);
    wsp_ggml_mutex_unlock(&threadpool->mutex);

    for (int j = 1; j < n_threads; j++) {
        int32_t rc = wsp_ggml_thread_join(workers[j].thrd, NULL);
        WSP_GGML_ASSERT(rc == WSP_GGML_EXIT_SUCCESS || rc == WSP_GGML_EXIT_ABORTED);
        UNUSED(rc);
    }

    wsp_ggml_mutex_destroy(&threadpool->mutex);
    wsp_ggml_cond_destroy(&threadpool->cond);
#endif // WSP_GGML_USE_OPENMP

    const size_t workers_size = sizeof(struct wsp_ggml_compute_state) * n_threads;
    wsp_ggml_aligned_free(threadpool->workers, workers_size);
    wsp_ggml_aligned_free(threadpool, sizeof(struct wsp_ggml_threadpool));
}

#ifndef WSP_GGML_USE_OPENMP
// pause/resume must be called under mutex
static void wsp_ggml_threadpool_pause_locked(struct wsp_ggml_threadpool * threadpool) {
    WSP_GGML_PRINT_DEBUG("Pausing threadpool\n");
    threadpool->pause = true;
    wsp_ggml_cond_broadcast(&threadpool->cond);
}

static void wsp_ggml_threadpool_resume_locked(struct wsp_ggml_threadpool * threadpool) {
    WSP_GGML_PRINT_DEBUG("Resuming threadpool\n");
    threadpool->pause = false;
    wsp_ggml_cond_broadcast(&threadpool->cond);
}
#endif

void wsp_ggml_threadpool_pause(struct wsp_ggml_threadpool * threadpool) {
#ifndef WSP_GGML_USE_OPENMP
    wsp_ggml_mutex_lock(&threadpool->mutex);
    if (!threadpool->pause) {
       wsp_ggml_threadpool_pause_locked(threadpool);
    }
    wsp_ggml_mutex_unlock(&threadpool->mutex);
#else
    UNUSED(threadpool);
#endif
}

void wsp_ggml_threadpool_resume(struct wsp_ggml_threadpool * threadpool) {
#ifndef WSP_GGML_USE_OPENMP
    wsp_ggml_mutex_lock(&threadpool->mutex);
    if (threadpool->pause) {
       wsp_ggml_threadpool_resume_locked(threadpool);
    }
    wsp_ggml_mutex_unlock(&threadpool->mutex);
#else
    UNUSED(threadpool);
#endif
}

struct wsp_ggml_cplan wsp_ggml_graph_plan(
          const struct wsp_ggml_cgraph * cgraph,
                               int   n_threads,
            struct wsp_ggml_threadpool * threadpool) {

    if (threadpool == NULL) {
        //WSP_GGML_PRINT_DEBUG("Threadpool is not specified. Will create a disposable threadpool : n_threads %d\n", n_threads);
    }
    if (n_threads <= 0) {
        n_threads = threadpool ? threadpool->n_threads_max : WSP_GGML_DEFAULT_N_THREADS;
    }

    size_t work_size = 0;

    struct wsp_ggml_cplan cplan;
    memset(&cplan, 0, sizeof(struct wsp_ggml_cplan));

    int max_tasks = 1;

    // thread scheduling for the different operations + work buffer size estimation
    for (int i = 0; i < cgraph->n_nodes; i++) {
        struct wsp_ggml_tensor * node = cgraph->nodes[i];

        const int n_tasks = wsp_ggml_get_n_tasks(node, n_threads);

        max_tasks = MAX(max_tasks, n_tasks);

        size_t cur = 0;

        if (!wsp_ggml_cpu_extra_work_size(n_threads, node, &cur)) {
            switch (node->op) {
                case WSP_GGML_OP_CPY:
                case WSP_GGML_OP_DUP:
                    {
                        if (wsp_ggml_is_quantized(node->type) ||
                            // F16 -> BF16 and BF16 -> F16 copies go through intermediate F32
                            (node->src[0]->type == WSP_GGML_TYPE_F16  && node->src[1] && node->src[1]->type == WSP_GGML_TYPE_BF16) ||
                            (node->src[0]->type == WSP_GGML_TYPE_BF16 && node->src[1] && node->src[1]->type == WSP_GGML_TYPE_F16) ||
                            // conversion between F32 and I32
                            (node->src[0]->type == WSP_GGML_TYPE_F32 && node->src[1] && node->src[1]->type == WSP_GGML_TYPE_I32) ||
                            (node->src[0]->type == WSP_GGML_TYPE_I32 && node->src[1] && node->src[1]->type == WSP_GGML_TYPE_F32)) {
                            cur = wsp_ggml_type_size(WSP_GGML_TYPE_F32) * node->ne[0] * n_tasks;
                        }
                    } break;
                case WSP_GGML_OP_ADD:
                case WSP_GGML_OP_ADD_ID:
                case WSP_GGML_OP_ADD1:
                    {
                        if (wsp_ggml_is_quantized(node->src[0]->type)) {
                            cur = wsp_ggml_type_size(WSP_GGML_TYPE_F32) * node->src[0]->ne[0] * n_tasks;
                        }
                    } break;
                case WSP_GGML_OP_ACC:
                    {
                        if (wsp_ggml_is_quantized(node->src[0]->type)) {
                            cur = wsp_ggml_type_size(WSP_GGML_TYPE_F32) * node->src[1]->ne[0] * n_tasks;
                        }
                    } break;
                case WSP_GGML_OP_COUNT_EQUAL:
                    {
                        cur = wsp_ggml_type_size(node->type)*n_tasks;
                    } break;
                case WSP_GGML_OP_MUL_MAT:
                    {
                        const enum wsp_ggml_type vec_dot_type = type_traits_cpu[node->src[0]->type].vec_dot_type;

                        if (node->src[1]->type != vec_dot_type) {
                            cur = wsp_ggml_row_size(vec_dot_type, wsp_ggml_nelements(node->src[1]));
                        }
                    } break;
                case WSP_GGML_OP_MUL_MAT_ID:
                    {
                        cur = 0;
                        const struct wsp_ggml_tensor * src0 = node->src[0];
                        const struct wsp_ggml_tensor * src1 = node->src[1];
                        const struct wsp_ggml_tensor * ids = node->src[2];
                        const enum wsp_ggml_type vec_dot_type = type_traits_cpu[src0->type].vec_dot_type;
                        const int n_as = src0->ne[2];
                        // src1
                        if (src1->type != vec_dot_type) {
                            cur += wsp_ggml_row_size(vec_dot_type, wsp_ggml_nelements(src1)) + sizeof(int64_t);
                        }
                        // matrix_row_counts
                        cur += n_as * sizeof(int64_t) + sizeof(int64_t);
                        // matrix_rows
                        cur += n_as*ids->ne[0]*ids->ne[1]*sizeof(struct mmid_row_mapping) + sizeof(int64_t);
                        // atomic_current_chunk
                        cur += CACHE_LINE_SIZE*n_as + CACHE_LINE_SIZE;
                    } break;
                case WSP_GGML_OP_OUT_PROD:
                    {
                        if (wsp_ggml_is_quantized(node->src[0]->type)) {
                            cur = wsp_ggml_type_size(WSP_GGML_TYPE_F32) * node->src[0]->ne[0] * n_tasks;
                        }
                    } break;
                case WSP_GGML_OP_SOFT_MAX:
                case WSP_GGML_OP_ROPE:
                case WSP_GGML_OP_ROPE_BACK:
                    {
                        cur = wsp_ggml_type_size(WSP_GGML_TYPE_F32) * node->ne[0] * n_tasks;
                    } break;
                case WSP_GGML_OP_CONV_TRANSPOSE_1D:
                    {
                        WSP_GGML_ASSERT(node->src[0]->ne[3] == 1);
                        WSP_GGML_ASSERT(node->src[1]->ne[2] == 1);
                        WSP_GGML_ASSERT(node->src[1]->ne[3] == 1);

                        const int64_t ne00 = node->src[0]->ne[0];  // K
                        const int64_t ne01 = node->src[0]->ne[1];  // Cout
                        const int64_t ne02 = node->src[0]->ne[2];  // Cin
                        const int64_t ne10 = node->src[1]->ne[0];  // L
                        const int64_t ne11 = node->src[1]->ne[1];  // Cin

                        if ((node->src[0]->type == WSP_GGML_TYPE_F16 ||
                             node->src[0]->type == WSP_GGML_TYPE_BF16) &&
                            node->src[1]->type == WSP_GGML_TYPE_F32) {
                            cur += sizeof(wsp_ggml_fp16_t)*ne00*ne01*ne02;
                            cur += sizeof(wsp_ggml_fp16_t)*ne10*ne11;
                        } else if (node->src[0]->type == WSP_GGML_TYPE_F32 &&
                                   node->src[1]->type == WSP_GGML_TYPE_F32) {
                            cur += sizeof(float)*ne00*ne01*ne02;
                            cur += sizeof(float)*ne10*ne11;
                        } else {
                            WSP_GGML_ABORT("fatal error");
                        }
                    } break;
                case WSP_GGML_OP_CONV_2D:
                case WSP_GGML_OP_CONV_3D:
                    {
                        cur = WSP_GGML_IM2COL_WORK_SIZE;
                    } break;
                case WSP_GGML_OP_CONV_TRANSPOSE_2D:
                    {
                        const int64_t ne00 = node->src[0]->ne[0]; // W
                        const int64_t ne01 = node->src[0]->ne[1]; // H
                        const int64_t ne02 = node->src[0]->ne[2]; // Channels Out
                        const int64_t ne03 = node->src[0]->ne[3]; // Channels In

                        const int64_t ne10 = node->src[1]->ne[0]; // W
                        const int64_t ne11 = node->src[1]->ne[1]; // H
                        const int64_t ne12 = node->src[1]->ne[2]; // Channels In

                        cur += sizeof(wsp_ggml_fp16_t)*ne00*ne01*ne02*ne03;
                        cur += sizeof(wsp_ggml_fp16_t)*ne10*ne11*ne12;
                    } break;
                case WSP_GGML_OP_FLASH_ATTN_EXT:
                    {
                        const int64_t ne10 = node->src[1]->ne[0]; // DK
                        const int64_t ne20 = node->src[2]->ne[0]; // DV

                        cur = sizeof(float)*(1*ne10 + 2*ne20)*n_tasks; // 1x head size K + 2x head size V (per thread)
                    } break;
                case WSP_GGML_OP_FLASH_ATTN_BACK:
                    {
                        const int64_t    D = node->src[0]->ne[0];
                        const int64_t ne11 = wsp_ggml_up(node->src[1]->ne[1], WSP_GGML_SOFT_MAX_UNROLL);
                        const int64_t mxDn = MAX(D, ne11) * 2; // *2 because of S and SM in wsp_ggml_compute_forward_flash_attn_back
                        if (node->src[1]->type == WSP_GGML_TYPE_F32) {
                            cur  = sizeof(float)*mxDn*n_tasks; // TODO: this can become (n_tasks-1)
                            cur += sizeof(float)*mxDn*n_tasks; // this is overestimated by x2
                        } else if (node->src[1]->type == WSP_GGML_TYPE_F16) {
                            cur  = sizeof(float)*mxDn*n_tasks; // TODO: this can become (n_tasks-1)
                            cur += sizeof(float)*mxDn*n_tasks; // this is overestimated by x2
                        } else if (node->src[1]->type == WSP_GGML_TYPE_BF16) {
                            cur  = sizeof(float)*mxDn*n_tasks; // TODO: this can become (n_tasks-1)
                            cur += sizeof(float)*mxDn*n_tasks; // this is overestimated by x2
                        }
                    } break;

                case WSP_GGML_OP_CROSS_ENTROPY_LOSS:
                    {
                        cur = wsp_ggml_type_size(node->type)*(n_tasks + node->src[0]->ne[0]*n_tasks);
                    } break;
                case WSP_GGML_OP_COUNT:
                    {
                        WSP_GGML_ABORT("fatal error");
                    }
                default:
                    break;
            }
        }

        work_size = MAX(work_size, cur);
    }

    if (work_size > 0) {
        work_size += CACHE_LINE_SIZE*(n_threads);
    }

    cplan.threadpool = threadpool;
    cplan.n_threads  = MIN(max_tasks, n_threads);
    cplan.work_size  = work_size;
    cplan.work_data  = NULL;

    return cplan;
}

static thread_ret_t wsp_ggml_graph_compute_thread(void * data) {
    struct wsp_ggml_compute_state * state = (struct wsp_ggml_compute_state *) data;
    struct wsp_ggml_threadpool    * tp    = state->threadpool;

    const struct wsp_ggml_cgraph * cgraph = tp->cgraph;
    const struct wsp_ggml_cplan  * cplan  = tp->cplan;

    set_numa_thread_affinity(state->ith);

    struct wsp_ggml_compute_params params = {
        /*.ith       =*/ state->ith,
        /*.nth       =*/ atomic_load_explicit(&tp->n_threads_cur, memory_order_relaxed),
        /*.wsize     =*/ cplan->work_size,
        /*.wdata     =*/ cplan->work_data,
        /*.threadpool=*/ tp,
    };

    for (int node_n = 0; node_n < cgraph->n_nodes && atomic_load_explicit(&tp->abort, memory_order_relaxed) != node_n; node_n++) {
        struct wsp_ggml_tensor * node = cgraph->nodes[node_n];

        if (wsp_ggml_op_is_empty(node->op)) {
            // skip NOPs
            continue;
        }

        wsp_ggml_compute_forward(&params, node);

        if (state->ith == 0 && cplan->abort_callback &&
                cplan->abort_callback(cplan->abort_callback_data)) {
            atomic_store_explicit(&tp->abort, node_n + 1, memory_order_relaxed);
            tp->ec    = WSP_GGML_STATUS_ABORTED;
        }

        if (node_n + 1 < cgraph->n_nodes) {
            wsp_ggml_barrier(state->threadpool);
        }
    }

    wsp_ggml_barrier(state->threadpool);

    return 0;
}

#ifndef WSP_GGML_USE_OPENMP

// check if thread is active
static inline bool wsp_ggml_graph_compute_thread_active(struct wsp_ggml_compute_state * state) {
    struct wsp_ggml_threadpool * threadpool = state->threadpool;
    int n_threads = atomic_load_explicit(&threadpool->n_threads_cur, memory_order_relaxed);
    return (state->ith < n_threads);
}

// check if thread is ready to proceed (exit from polling or sleeping)
static inline bool wsp_ggml_graph_compute_thread_ready(struct wsp_ggml_compute_state * state) {
    struct wsp_ggml_threadpool * threadpool = state->threadpool;

    if (state->pending || threadpool->stop || threadpool->pause) { return true; }

    // check for new graph/work
    int new_graph = atomic_load_explicit(&threadpool->n_graph, memory_order_relaxed);
    if (new_graph != state->last_graph) {
        state->pending    = wsp_ggml_graph_compute_thread_active(state);
        state->last_graph = new_graph;
    }

    return state->pending;
}

// sync thread state after polling
static inline void wsp_ggml_graph_compute_thread_sync(struct wsp_ggml_compute_state * state) {
    // TSAN doesn't support standalone fence yet, we use a dummy read-modify-write instead
    #ifdef WSP_GGML_TSAN_ENABLED
    atomic_fetch_add_explicit(&state->threadpool->n_graph, 0, memory_order_seq_cst);
    #else
    atomic_thread_fence(memory_order_seq_cst);
    #endif
    UNUSED(state);
}

static inline bool wsp_ggml_graph_compute_poll_for_work(struct wsp_ggml_compute_state * state) {
    struct wsp_ggml_threadpool * threadpool = state->threadpool;

    // Skip polling for unused threads
    if (!wsp_ggml_graph_compute_thread_active(state)) {
        return state->pending;
    }

    // This seems to make 0 ... 100 a decent range for polling level across modern processors.
    // Perhaps, we can adjust it dynamically based on load and things.
    const uint64_t n_rounds = 1024UL * 128 * threadpool->poll;

    for (uint64_t i=0; !wsp_ggml_graph_compute_thread_ready(state) && i < n_rounds; i++) {
        // No new work. Keep polling.
        wsp_ggml_thread_cpu_relax();
    }

    return state->pending;
}

static inline bool wsp_ggml_graph_compute_check_for_work(struct wsp_ggml_compute_state * state) {
    struct wsp_ggml_threadpool * threadpool = state->threadpool;

    if (wsp_ggml_graph_compute_poll_for_work(state)) {
        wsp_ggml_graph_compute_thread_sync(state);
        return state->pending;
    }

    wsp_ggml_mutex_lock_shared(&threadpool->mutex);
    while (!wsp_ggml_graph_compute_thread_ready(state)) {
        // No new work. Wait for the signal.
        WSP_GGML_PRINT_DEBUG("thread #%d waiting for work (sleeping)\n", state->ith);
        wsp_ggml_cond_wait(&threadpool->cond, &threadpool->mutex);
    }
    wsp_ggml_mutex_unlock_shared(&threadpool->mutex);

    return state->pending;
}

static thread_ret_t wsp_ggml_graph_compute_secondary_thread(void* data) {
    struct wsp_ggml_compute_state * state = (struct wsp_ggml_compute_state *) data;
    struct wsp_ggml_threadpool * threadpool = state->threadpool;

    wsp_ggml_thread_apply_priority(threadpool->prio);
    if (wsp_ggml_thread_cpumask_is_valid(state->cpumask)) {
        wsp_ggml_thread_apply_affinity(state->cpumask);
    }

    while (true) {
        // Check if we need to sleep
        while (threadpool->pause) {
            WSP_GGML_PRINT_DEBUG("thread #%d inside pause loop\n", state->ith);
            wsp_ggml_mutex_lock_shared(&threadpool->mutex);
            if (threadpool->pause) {
                wsp_ggml_cond_wait(&threadpool->cond, &threadpool->mutex);
            }
            WSP_GGML_PRINT_DEBUG("thread #%d resuming after wait\n", state->ith);
            wsp_ggml_mutex_unlock_shared(&threadpool->mutex);
        }

        // This needs to be checked for after the cond_wait
        if (threadpool->stop) break;

        // Check if there is new work
        // The main thread is the only one that can dispatch new work

        wsp_ggml_graph_compute_check_for_work(state);
        if (state->pending) {
            state->pending = false;

            wsp_ggml_graph_compute_thread(state);
        }
    }

    return (thread_ret_t) 0;
}

// Start processing new graph
static void wsp_ggml_graph_compute_kickoff(struct wsp_ggml_threadpool * threadpool, int n_threads)
{
    // Always take the mutex here because the worker threads are doing hybrid poll/wait

    wsp_ggml_mutex_lock(&threadpool->mutex);

    WSP_GGML_PRINT_DEBUG("threadpool: n_threads_cur %d n_threads %d\n", threadpool->n_threads_cur, n_threads);

    // Update the number of active threads
    atomic_store_explicit(&threadpool->n_threads_cur, n_threads, memory_order_relaxed);

    // Indicate the graph is ready to be processed
    // We need the full seq-cst fence here because of the polling threads (used in thread_sync)
    atomic_fetch_add_explicit(&threadpool->n_graph, 1, memory_order_seq_cst);

    if (threadpool->pause) {
       // Update main thread prio and affinity to match the threadpool settings
       wsp_ggml_thread_apply_priority(threadpool->prio);
       if (wsp_ggml_thread_cpumask_is_valid(threadpool->workers[0].cpumask)) {
           wsp_ggml_thread_apply_affinity(threadpool->workers[0].cpumask);
       }

       // resume does cond broadcast
       wsp_ggml_threadpool_resume_locked(threadpool);
    } else {
       wsp_ggml_cond_broadcast(&threadpool->cond);
    }

    wsp_ggml_mutex_unlock(&threadpool->mutex);
}

#endif // WSP_GGML_USE_OPENMP

static struct wsp_ggml_threadpool * wsp_ggml_threadpool_new_impl(
    struct wsp_ggml_threadpool_params * tpp,
               struct wsp_ggml_cgraph * cgraph,
                struct wsp_ggml_cplan * cplan) {

    struct wsp_ggml_threadpool * threadpool =
        wsp_ggml_aligned_malloc(sizeof(struct wsp_ggml_threadpool));
    {
        threadpool->cgraph           = cgraph;
        threadpool->cplan            = cplan;
        threadpool->n_graph          = 0;
        threadpool->n_barrier        = 0;
        threadpool->n_barrier_passed = 0;
        threadpool->current_chunk    = 0;
        threadpool->stop             = false;
        threadpool->pause            = tpp->paused;
        threadpool->abort            = -1;
        threadpool->workers          = NULL;
        threadpool->n_threads_max    = tpp->n_threads;
        threadpool->n_threads_cur    = tpp->n_threads;
        threadpool->poll             = tpp->poll;
        threadpool->prio             = tpp->prio;
        threadpool->ec               = WSP_GGML_STATUS_SUCCESS;
    }

    // Allocate and init workers state
    const size_t workers_size = sizeof(struct wsp_ggml_compute_state) * tpp->n_threads;
    struct wsp_ggml_compute_state * workers = wsp_ggml_aligned_malloc(workers_size);

    memset(workers, 0, workers_size);
    for (int j = 0; j < tpp->n_threads; j++) {
        workers[j].threadpool = threadpool;
        workers[j].ith        = j;
    }

    threadpool->workers = workers;

#ifdef WSP_GGML_USE_OPENMP
    int32_t cpumask_iter = 0;

    // Compute CPU masks for each thread
    for (int j = 0; j < tpp->n_threads; j++) {
        wsp_ggml_thread_cpumask_next(tpp->cpumask, workers[j].cpumask, tpp->strict_cpu, &cpumask_iter);
    }
#else // WSP_GGML_USE_OPENMP
    wsp_ggml_mutex_init(&threadpool->mutex);
    wsp_ggml_cond_init(&threadpool->cond);

    // Spin the threads for all workers, and update CPU placements.
    // Place the main thread last (towards the higher numbered CPU cores).

    int32_t cpumask_iter = 0;

    for (int j = 1; j < tpp->n_threads; j++) {
        wsp_ggml_thread_cpumask_next(tpp->cpumask, workers[j].cpumask, tpp->strict_cpu, &cpumask_iter);

        int32_t rc = wsp_ggml_thread_create(&workers[j].thrd, NULL, wsp_ggml_graph_compute_secondary_thread, &workers[j]);
        WSP_GGML_ASSERT(rc == 0);
    }

    wsp_ggml_thread_cpumask_next(tpp->cpumask, workers[0].cpumask, tpp->strict_cpu, &cpumask_iter);

    if (!threadpool->pause) {
        // Update main thread prio and affinity at the start, otherwise we'll do it in resume
        wsp_ggml_thread_apply_priority(threadpool->prio);
        if (wsp_ggml_thread_cpumask_is_valid(threadpool->workers[0].cpumask)) {
            wsp_ggml_thread_apply_affinity(threadpool->workers[0].cpumask);
        }
    }
#endif // WSP_GGML_USE_OPENMP

    return threadpool;
}

struct wsp_ggml_threadpool * wsp_ggml_threadpool_new(struct wsp_ggml_threadpool_params * tpp) {
    return wsp_ggml_threadpool_new_impl(tpp, NULL, NULL);
}

enum wsp_ggml_status wsp_ggml_graph_compute(struct wsp_ggml_cgraph * cgraph, struct wsp_ggml_cplan * cplan) {
    wsp_ggml_cpu_init();

    WSP_GGML_ASSERT(cplan);
    WSP_GGML_ASSERT(cplan->n_threads > 0);
    WSP_GGML_ASSERT(cplan->work_size == 0 || cplan->work_data != NULL);

    int n_threads                               = cplan->n_threads;
    struct wsp_ggml_threadpool * threadpool = cplan->threadpool;

    bool disposable_threadpool = false;

    if (threadpool == NULL) {
        //WSP_GGML_PRINT_DEBUG("Threadpool is not specified. Will create a disposable threadpool : n_threads %d\n", n_threads);
        disposable_threadpool = true;

        struct wsp_ggml_threadpool_params ttp = wsp_ggml_threadpool_params_default(n_threads);
        threadpool = wsp_ggml_threadpool_new_impl(&ttp, cgraph, cplan);
    } else {
        // Reset some of the parameters that need resetting
        // No worker threads should be accessing the parameters below at this stage
        threadpool->cgraph           = cgraph;
        threadpool->cplan            = cplan;
        threadpool->current_chunk    = 0;
        threadpool->abort            = -1;
        threadpool->ec               = WSP_GGML_STATUS_SUCCESS;
    }

#ifdef WSP_GGML_USE_OPENMP
    if (n_threads > 1) {
        #pragma omp parallel num_threads(n_threads)
        {
            #pragma omp single
            {
                // update the number of threads from the actual number of threads that we got from OpenMP
                n_threads = omp_get_num_threads();
                atomic_store_explicit(&threadpool->n_threads_cur, n_threads, memory_order_relaxed);
            }

            // Apply thread CPU mask and priority
            int ith = omp_get_thread_num();

            wsp_ggml_thread_apply_priority(threadpool->prio);
            if (wsp_ggml_thread_cpumask_is_valid(threadpool->workers[ith].cpumask)) {
                wsp_ggml_thread_apply_affinity(threadpool->workers[ith].cpumask);
            }
            wsp_ggml_graph_compute_thread(&threadpool->workers[ith]);
        }
    } else {
        atomic_store_explicit(&threadpool->n_threads_cur, 1, memory_order_relaxed);
        wsp_ggml_graph_compute_thread(&threadpool->workers[0]);
    }
#else
    if (n_threads > threadpool->n_threads_max) {
        WSP_GGML_LOG_WARN("cplan requested more threads (%d) than available (%d)\n", n_threads, threadpool->n_threads_max);
        n_threads = threadpool->n_threads_max;
    }

    // Kick all threads to start the new graph
    wsp_ggml_graph_compute_kickoff(threadpool, n_threads);

    // This is a work thread too
    wsp_ggml_graph_compute_thread(&threadpool->workers[0]);
#endif

    // don't leave affinity set on the main thread
    clear_numa_thread_affinity();

    enum wsp_ggml_status ret = threadpool->ec;

    if (disposable_threadpool) {
        wsp_ggml_threadpool_free(threadpool);
    }

    return ret;
}

enum wsp_ggml_status wsp_ggml_graph_compute_with_ctx(struct wsp_ggml_context * ctx, struct wsp_ggml_cgraph * cgraph, int n_threads) {
    struct wsp_ggml_cplan cplan = wsp_ggml_graph_plan(cgraph, n_threads, NULL);

    cplan.work_data = (uint8_t *)wsp_ggml_new_buffer(ctx, cplan.work_size);

    return wsp_ggml_graph_compute(cgraph, &cplan);
}

void wsp_ggml_cpu_fp32_to_fp32(const float * x, float * y, int64_t n) {
    memcpy(y, x, n * sizeof(float));
}

void wsp_ggml_cpu_fp32_to_fp16(const float * x, wsp_ggml_fp16_t * y, int64_t n) {
    int64_t i = 0;
#if defined(__F16C__)
#if defined(__AVX512F__)
    for (; i + 15 < n; i += 16) {
        __m512 x_vec = _mm512_loadu_ps(x + i);
        __m256i y_vec = _mm512_cvtps_ph(x_vec, _MM_FROUND_TO_NEAREST_INT);
        _mm256_storeu_si256((__m256i *)(y + i), y_vec);
    }
#endif
    for (; i + 7 < n; i += 8) {
        __m256 x_vec = _mm256_loadu_ps(x + i);
        __m128i y_vec = _mm256_cvtps_ph(x_vec, _MM_FROUND_TO_NEAREST_INT);
        _mm_storeu_si128((__m128i *)(y + i), y_vec);
    }
    for (; i + 3 < n; i += 4) {
        __m128 x_vec = _mm_loadu_ps(x + i);
        __m128i y_vec = _mm_cvtps_ph(x_vec, _MM_FROUND_TO_NEAREST_INT);
        _mm_storel_epi64((__m128i *)(y + i), y_vec);
    }
#elif defined(__riscv_zvfh)
    for (int vl; i < n; i += vl) {
        vl = __riscv_vsetvl_e32m2(n - i);
        vfloat32m2_t vx = __riscv_vle32_v_f32m2(&x[i], vl);
        vfloat16m1_t vy = __riscv_vfncvt_f_f_w_f16m1(vx, vl);
        __riscv_vse16_v_f16m1((_Float16 *)&y[i], vy, vl);
    }
#endif
    for (; i < n; ++i) {
        y[i] = WSP_GGML_CPU_FP32_TO_FP16(x[i]);
    }
}

void wsp_ggml_cpu_fp16_to_fp32(const wsp_ggml_fp16_t * x, float * y, int64_t n) {
    int64_t i = 0;
#if defined(__F16C__)
#if defined(__AVX512F__)
    for (; i + 15 < n; i += 16) {
        __m256i x_vec = _mm256_loadu_si256((const __m256i *)(x + i));
        __m512 y_vec = _mm512_cvtph_ps(x_vec);
        _mm512_storeu_ps(y + i, y_vec);
    }
#endif
    for (; i + 7 < n; i += 8) {
        __m128i x_vec = _mm_loadu_si128((const __m128i *)(x + i));
        __m256 y_vec = _mm256_cvtph_ps(x_vec);
        _mm256_storeu_ps(y + i, y_vec);
    }
    for (; i + 3 < n; i += 4) {
        __m128i x_vec = _mm_loadl_epi64((const __m128i *)(x + i));
        __m128 y_vec = _mm_cvtph_ps(x_vec);
        _mm_storeu_ps(y + i, y_vec);
    }
#elif defined(__riscv_zvfh)
    for (int vl; i < n; i += vl) {
        vl = __riscv_vsetvl_e16m1(n - i);
        vfloat16m1_t vx = __riscv_vle16_v_f16m1((_Float16 *)&x[i], vl);
        vfloat32m2_t vy = __riscv_vfwcvt_f_f_v_f32m2(vx, vl);
        __riscv_vse32_v_f32m2(&y[i], vy, vl);
    }
#endif

    for (; i < n; ++i) {
        y[i] = WSP_GGML_CPU_FP16_TO_FP32(x[i]);
    }
}

void wsp_ggml_cpu_fp32_to_bf16(const float * x, wsp_ggml_bf16_t * y, int64_t n) {
    int64_t i = 0;
    for (; i < n; ++i) {
        y[i] = WSP_GGML_FP32_TO_BF16(x[i]);
    }
}

void wsp_ggml_cpu_fp32_to_i32(const float * x, int32_t * y, int64_t n) {
    int64_t i = 0;
    for (; i < n; ++i) {
        y[i] = x[i];
    }
}

void wsp_ggml_cpu_bf16_to_fp32(const wsp_ggml_bf16_t * x, float * y, int64_t n) {
    int64_t i = 0;
#if defined(__AVX2__)
#if defined(__AVX512F__)
    for (; i + 15 < n; i += 16) {
        _mm512_storeu_ps(y + i,
                        _mm512_castsi512_ps(
                            _mm512_slli_epi32(
                                _mm512_cvtepu16_epi32(
                                    _mm256_loadu_si256(
                                        (const __m256i *)(x + i))),
                                16)));
    }
#endif
    for (; i + 7 < n; i += 8) {
        _mm256_storeu_ps(y + i,
                        _mm256_castsi256_ps(
                            _mm256_slli_epi32(
                                _mm256_cvtepu16_epi32(
                                    _mm_loadu_si128(
                                        (const __m128i *)(x + i))),
                                16)));
    }
#endif
    for (; i < n; i++) {
        y[i] = WSP_GGML_BF16_TO_FP32(x[i]);
    }
}

int wsp_ggml_cpu_has_avx(void) {
#if defined(__AVX__)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_avx_vnni(void) {
#if defined(__AVXVNNI__)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_avx2(void) {
#if defined(__AVX2__)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_avx512(void) {
#if defined(__AVX512F__)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_avx512_vbmi(void) {
#if defined(__AVX512VBMI__)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_avx512_vnni(void) {
#if defined(__AVX512VNNI__)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_avx512_bf16(void) {
#if defined(__AVX512BF16__)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_amx_int8(void) {
#if defined(__AMX_INT8__)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_bmi2(void) {
#if defined(__BMI2__)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_fma(void) {
#if defined(__FMA__)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_arm_fma(void) {
#if defined(__ARM_FEATURE_FMA)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_riscv_v(void) {
#if defined(__riscv_v_intrinsic)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_f16c(void) {
#if defined(__F16C__)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_fp16_va(void) {
#if defined(__ARM_FEATURE_FP16_VECTOR_ARITHMETIC)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_wasm_simd(void) {
#if defined(__wasm_simd128__)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_llamafile(void) {
#if defined(WSP_GGML_USE_LLAMAFILE)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_sse3(void) {
#if defined(__SSE3__)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_ssse3(void) {
#if defined(__SSSE3__)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_vsx(void) {
#if defined(__POWER9_VECTOR__)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_vxe(void) {
#if defined(__VXE__) || defined(__VXE2__)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_neon(void) {
#if defined(__ARM_ARCH) && defined(__ARM_NEON)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_dotprod(void) {
#if defined(__ARM_ARCH) && defined(__ARM_FEATURE_DOTPROD)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_sve(void) {
#if defined(__ARM_ARCH) && defined(__ARM_FEATURE_SVE)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_matmul_int8(void) {
#if defined(__ARM_ARCH) && defined(__ARM_FEATURE_MATMUL_INT8)
    return 1;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_get_sve_cnt(void) {
#if defined(__ARM_ARCH) && defined(__ARM_FEATURE_SVE)
    return wsp_ggml_arm_arch_features.sve_cnt;
#else
    return 0;
#endif
}

int wsp_ggml_cpu_has_sme(void) {
#if defined(__ARM_ARCH) && defined(__ARM_FEATURE_SME)
    return 1;
#else
    return 0;
#endif
}

void wsp_ggml_cpu_init(void) {
    // needed to initialize wsp_ggml_time
    {
        struct wsp_ggml_init_params params = { 0, NULL, false };
        struct wsp_ggml_context * ctx = wsp_ggml_init(params);
        wsp_ggml_free(ctx);
    }

    wsp_ggml_critical_section_start();

    static bool is_first_call = true;

    if (is_first_call) {
        // initialize GELU, Quick GELU, SILU and EXP F32 tables
        {
            const uint64_t t_start = wsp_ggml_time_us(); UNUSED(t_start);

            for (int i = 0; i < (1 << 16); ++i) {
                union {
                    uint16_t u16;
                    wsp_ggml_fp16_t fp16;
                } u = {i};
                float f = WSP_GGML_COMPUTE_FP16_TO_FP32(u.fp16);
                wsp_ggml_table_f32_f16[i] = f;
                wsp_ggml_table_gelu_f16[i] = WSP_GGML_CPU_FP32_TO_FP16(wsp_ggml_gelu_f32(f));
                wsp_ggml_table_gelu_quick_f16[i] = WSP_GGML_CPU_FP32_TO_FP16(wsp_ggml_gelu_quick_f32(f));
            }

            const uint64_t t_end = wsp_ggml_time_us(); UNUSED(t_end);

            WSP_GGML_PRINT_DEBUG("%s: GELU, Quick GELU, SILU and EXP tables initialized in %f ms\n", __func__, (t_end - t_start)/1000.0);

#ifdef WSP_GGML_USE_OPENMP
            //if (!getenv("OMP_WAIT_POLICY")) {
            //    // set the wait policy to active, so that OpenMP threads don't sleep
            //    setenv("OMP_WAIT_POLICY", "active", 0)
            //}

            if (!getenv("KMP_BLOCKTIME")) {
                // set the time to wait before sleeping a thread
                // this is less aggressive than setting the wait policy to active, but should achieve similar results in most cases
#ifdef _WIN32
                _putenv_s("KMP_BLOCKTIME", "200"); // 200ms
#else
                setenv("KMP_BLOCKTIME", "200", 0); // 200ms
#endif
            }
#endif
        }

#if defined(__ARM_ARCH)
        wsp_ggml_init_arm_arch_features();
#endif

        is_first_call = false;
    }

    wsp_ggml_critical_section_end();
}
