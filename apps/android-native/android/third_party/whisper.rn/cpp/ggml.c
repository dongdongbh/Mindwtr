#define _CRT_SECURE_NO_DEPRECATE // Disables "unsafe" warnings on Windows
#define _USE_MATH_DEFINES // For M_PI on MSVC

// GGML build info
#ifndef WSP_GGML_VERSION
#define WSP_GGML_VERSION "unknown"
#endif
#ifndef WSP_GGML_COMMIT
#define WSP_GGML_COMMIT "unknown"
#endif

#include "ggml-backend.h"
#include "ggml-impl.h"
#include "ggml-threading.h"
#include "ggml-cpu.h"
#include "ggml.h"

// FIXME: required here for quantization functions
#include "ggml-quants.h"

#ifdef WSP_GGML_USE_CPU_HBM
#include <hbwmalloc.h>
#endif

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

#if defined(__APPLE__)
#include <unistd.h>
#include <mach/mach.h>
#include <TargetConditionals.h>
#endif

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
    #define NOMINMAX
#endif
#include <windows.h>
#endif

#define UNUSED WSP_GGML_UNUSED

#if defined(_MSC_VER)
#define m512bh(p) p
#define m512i(p) p
#else
#define m512bh(p) (__m512bh)(p)
#define m512i(p) (__m512i)(p)
#endif

#if defined(__linux__) || \
    defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__) || \
    (defined(__APPLE__) && !TARGET_OS_TV && !TARGET_OS_WATCH)

#include <unistd.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#if defined(__linux__)
#include <sys/prctl.h>
#endif

#if defined(__ANDROID__)
#include <unwind.h>
#include <dlfcn.h>
#include <stdio.h>

struct backtrace_state {
    void ** current;
    void ** end;
};

static _Unwind_Reason_Code unwind_callback(struct _Unwind_Context* context, void* arg) {
    struct backtrace_state * state = (struct backtrace_state *)arg;
    uintptr_t pc = _Unwind_GetIP(context);
    if (pc) {
        if (state->current == state->end) {
            return _URC_END_OF_STACK;
        } else {
            *state->current++ = (void*)pc;
        }
    }
    return _URC_NO_REASON;
}

static void wsp_ggml_print_backtrace_symbols(void) {
    const int max = 100;
    void* buffer[max];

    struct backtrace_state state = {buffer, buffer + max};
    _Unwind_Backtrace(unwind_callback, &state);

    int count = state.current - buffer;

    for (int idx = 0; idx < count; ++idx) {
        const void * addr = buffer[idx];
        const char * symbol = "";

        Dl_info info;
        if (dladdr(addr, &info) && info.dli_sname) {
            symbol = info.dli_sname;
        }

        fprintf(stderr, "%d: %p %s\n", idx, addr, symbol);
    }
}
#elif defined(__linux__) && defined(__GLIBC__)
#include <execinfo.h>
static void wsp_ggml_print_backtrace_symbols(void) {
    void * trace[100];
    int nptrs = backtrace(trace, sizeof(trace)/sizeof(trace[0]));
    backtrace_symbols_fd(trace, nptrs, STDERR_FILENO);
}
#else
static void wsp_ggml_print_backtrace_symbols(void) {
    // platform not supported
}
#endif

void wsp_ggml_print_backtrace(void) {
    const char * WSP_GGML_NO_BACKTRACE = getenv("WSP_GGML_NO_BACKTRACE");
    if (WSP_GGML_NO_BACKTRACE) {
        return;
    }
#if defined(__linux__)
    FILE * f = fopen("/proc/self/status", "r");
    size_t size = 0;
    char * line = NULL;
    ssize_t length = 0;
    while ((length = getline(&line, &size, f)) > 0) {
        if (!strncmp(line, "TracerPid:", sizeof("TracerPid:") - 1) &&
            (length != sizeof("TracerPid:\t0\n") - 1 || line[length - 2] != '0')) {
            // Already being debugged, and the breakpoint is the later abort()
            free(line);
            fclose(f);
            return;
        }
    }
    free(line);
    fclose(f);
    int lock[2] = { -1, -1 };
    (void) !pipe(lock); // Don't start gdb until after PR_SET_PTRACER
#endif
    const int parent_pid = getpid();
    const int child_pid = fork();
    if (child_pid < 0) { // error
#if defined(__linux__)
        close(lock[1]);
        close(lock[0]);
#endif
        return;
    } else if (child_pid == 0) { // child
        char attach[32];
        snprintf(attach, sizeof(attach), "attach %d", parent_pid);
#if defined(__linux__)
        close(lock[1]);
        (void) !read(lock[0], lock, 1);
        close(lock[0]);
#endif
        // try gdb
        execlp("gdb", "gdb", "--batch",
            "-ex", "set style enabled on",
            "-ex", attach,
            "-ex", "bt -frame-info source-and-location",
            "-ex", "detach",
            "-ex", "quit",
            (char *) NULL);
        // try lldb
        execlp("lldb", "lldb", "--batch",
            "-o", "bt",
            "-o", "quit",
            "-p", &attach[sizeof("attach ") - 1],
            (char *) NULL);
        // gdb failed, fallback to backtrace_symbols
        wsp_ggml_print_backtrace_symbols();
        _Exit(0);
    } else { // parent
#if defined(__linux__)
        prctl(PR_SET_PTRACER, child_pid);
        close(lock[1]);
        close(lock[0]);
#endif
        waitpid(child_pid, NULL, 0);
    }
}
#else
void wsp_ggml_print_backtrace(void) {
    // platform not supported
}
#endif

static wsp_ggml_abort_callback_t g_abort_callback = NULL;

// Set the abort callback (passing null will restore original abort functionality: printing a message to stdout)
WSP_GGML_API wsp_ggml_abort_callback_t wsp_ggml_set_abort_callback(wsp_ggml_abort_callback_t callback) {
    wsp_ggml_abort_callback_t ret_val = g_abort_callback;
    g_abort_callback = callback;
    return ret_val;
}

void wsp_ggml_abort(const char * file, int line, const char * fmt, ...) {
    fflush(stdout);

    char message[2048];
    int offset = snprintf(message, sizeof(message), "%s:%d: ", file, line);

    va_list args;
    va_start(args, fmt);
    vsnprintf(message + offset, sizeof(message) - offset, fmt, args);
    va_end(args);

    if (g_abort_callback) {
        g_abort_callback(message);
    } else {
        // default: print error and backtrace to stderr
        fprintf(stderr, "%s\n", message);
        wsp_ggml_print_backtrace();
    }

    abort();
}

// wsp_ggml_print_backtrace is registered with std::set_terminate by ggml.cpp

//
// logging
//

struct wsp_ggml_logger_state {
    wsp_ggml_log_callback log_callback;
    void * log_callback_user_data;
};
static struct wsp_ggml_logger_state g_logger_state = {wsp_ggml_log_callback_default, NULL};

static void wsp_ggml_log_internal_v(enum wsp_ggml_log_level level, const char * format, va_list args) {
    if (format == NULL) {
        return;
    }
    va_list args_copy;
    va_copy(args_copy, args);
    char buffer[128];
    int len = vsnprintf(buffer, 128, format, args);
    if (len < 128) {
        g_logger_state.log_callback(level, buffer, g_logger_state.log_callback_user_data);
    } else {
        char * buffer2 = (char *) calloc(len + 1, sizeof(char));
        vsnprintf(buffer2, len + 1, format, args_copy);
        buffer2[len] = 0;
        g_logger_state.log_callback(level, buffer2, g_logger_state.log_callback_user_data);
        free(buffer2);
    }
    va_end(args_copy);
}

void wsp_ggml_log_internal(enum wsp_ggml_log_level level, const char * format, ...) {
    va_list args;
    va_start(args, format);
    wsp_ggml_log_internal_v(level, format, args);
    va_end(args);
}

void wsp_ggml_log_callback_default(enum wsp_ggml_log_level level, const char * text, void * user_data) {
    (void) level;
    (void) user_data;
    fputs(text, stderr);
    fflush(stderr);
}

//
// end of logging block
//

#ifdef WSP_GGML_USE_ACCELERATE
// uncomment to use vDSP for soft max computation
// note: not sure if it is actually faster
//#define WSP_GGML_SOFT_MAX_ACCELERATE
#endif


void * wsp_ggml_aligned_malloc(size_t size) {
#if defined(__s390x__)
    const int alignment = 256;
#else
    const int alignment = 64;
#endif

#if defined(_MSC_VER) || defined(__MINGW32__)
    return _aligned_malloc(size, alignment);
#else
    if (size == 0) {
        WSP_GGML_LOG_WARN("Behavior may be unexpected when allocating 0 bytes for wsp_ggml_aligned_malloc!\n");
        return NULL;
    }
    void * aligned_memory = NULL;
  #ifdef WSP_GGML_USE_CPU_HBM
    int result = hbw_posix_memalign(&aligned_memory, alignment, size);
  #elif TARGET_OS_OSX
    WSP_GGML_UNUSED(alignment);
    kern_return_t alloc_status = vm_allocate((vm_map_t) mach_task_self(), (vm_address_t *) &aligned_memory, size, VM_FLAGS_ANYWHERE);
    int result = EFAULT;
    switch (alloc_status) {
        case KERN_SUCCESS:
            result = 0;
            break;
        case KERN_INVALID_ADDRESS:
            result = EINVAL;
            break;
        case KERN_NO_SPACE:
            result = ENOMEM;
            break;
        default:
            result = EFAULT;
            break;
    }
  #else
    int result = posix_memalign(&aligned_memory, alignment, size);
  #endif
    if (result != 0) {
        // Handle allocation failure
        const char *error_desc = "unknown allocation error";
        switch (result) {
            case EINVAL:
                error_desc = "invalid alignment value";
                break;
            case ENOMEM:
                error_desc = "insufficient memory";
                break;
        }
        WSP_GGML_LOG_ERROR("%s: %s (attempted to allocate %6.2f MB)\n", __func__, error_desc, size/(1024.0*1024.0));
        return NULL;
    }
    return aligned_memory;
#endif
}

void wsp_ggml_aligned_free(void * ptr, size_t size) {
    WSP_GGML_UNUSED(size);
#if defined(_MSC_VER) || defined(__MINGW32__)
    _aligned_free(ptr);
#elif WSP_GGML_USE_CPU_HBM
    if (ptr != NULL) {
        hbw_free(ptr);
    }
#elif TARGET_OS_OSX
    if (ptr != NULL) {
        vm_deallocate((vm_map_t)mach_task_self(), (vm_address_t)ptr, size);
    }
#else
    free(ptr);
#endif
}


inline static void * wsp_ggml_malloc(size_t size) {
    if (size == 0) {
        WSP_GGML_LOG_WARN("Behavior may be unexpected when allocating 0 bytes for wsp_ggml_malloc!\n");
        return NULL;
    }
    void * result = malloc(size);
    if (result == NULL) {
        WSP_GGML_LOG_ERROR("%s: failed to allocate %6.2f MB\n", __func__, size/(1024.0*1024.0));
        WSP_GGML_ABORT("fatal error");
    }
    return result;
}

// calloc
inline static void * wsp_ggml_calloc(size_t num, size_t size) {
    if (num == 0 || size == 0) {
        WSP_GGML_LOG_WARN("Behavior may be unexpected when allocating 0 bytes for wsp_ggml_calloc!\n");
        return NULL;
    }
    void * result = calloc(num, size);
    if (result == NULL) {
        WSP_GGML_LOG_ERROR("%s: failed to allocate %6.2f MB\n", __func__, size/(1024.0*1024.0));
        WSP_GGML_ABORT("fatal error");
    }
    return result;
}

#define WSP_GGML_MALLOC(size)      wsp_ggml_malloc(size)
#define WSP_GGML_CALLOC(num, size) wsp_ggml_calloc(num, size)

#define WSP_GGML_FREE(ptr) free(ptr)

const char * wsp_ggml_status_to_string(enum wsp_ggml_status status) {
    switch (status) {
        case WSP_GGML_STATUS_ALLOC_FAILED: return "GGML status: error (failed to allocate memory)";
        case WSP_GGML_STATUS_FAILED:       return "GGML status: error (operation failed)";
        case WSP_GGML_STATUS_SUCCESS:      return "GGML status: success";
        case WSP_GGML_STATUS_ABORTED:      return "GGML status: warning (operation aborted)";
    }

    return "GGML status: unknown";
}

float wsp_ggml_fp16_to_fp32(wsp_ggml_fp16_t x) {
#define wsp_ggml_fp16_to_fp32 do_not_use__wsp_ggml_fp16_to_fp32__in_ggml
    return WSP_GGML_FP16_TO_FP32(x);
}

wsp_ggml_fp16_t wsp_ggml_fp32_to_fp16(float x) {
#define wsp_ggml_fp32_to_fp16 do_not_use__wsp_ggml_fp32_to_fp16__in_ggml
    return WSP_GGML_FP32_TO_FP16(x);
}

float wsp_ggml_bf16_to_fp32(wsp_ggml_bf16_t x) {
#define wsp_ggml_bf16_to_fp32 do_not_use__wsp_ggml_bf16_to_fp32__in_ggml
    return WSP_GGML_BF16_TO_FP32(x);  // it just left shifts
}

wsp_ggml_bf16_t wsp_ggml_fp32_to_bf16(float x) {
#define wsp_ggml_fp32_to_bf16 do_not_use__wsp_ggml_fp32_to_bf16__in_ggml
    return WSP_GGML_FP32_TO_BF16(x);
}

void wsp_ggml_fp16_to_fp32_row(const wsp_ggml_fp16_t * x, float * y, int64_t n) {
    for (int64_t i = 0; i < n; i++) {
        y[i] = WSP_GGML_FP16_TO_FP32(x[i]);
    }
}

void wsp_ggml_fp32_to_fp16_row(const float * x, wsp_ggml_fp16_t * y, int64_t n) {
    int i = 0;
    for (; i < n; ++i) {
        y[i] = WSP_GGML_FP32_TO_FP16(x[i]);
    }
}

void wsp_ggml_bf16_to_fp32_row(const wsp_ggml_bf16_t * x, float * y, int64_t n) {
    int i = 0;
    for (; i < n; ++i) {
        y[i] = WSP_GGML_BF16_TO_FP32(x[i]);
    }
}

void wsp_ggml_fp32_to_bf16_row_ref(const float * x, wsp_ggml_bf16_t * y, int64_t n) {
    for (int i = 0; i < n; i++) {
        y[i] = wsp_ggml_compute_fp32_to_bf16(x[i]);
    }
}

void wsp_ggml_fp32_to_bf16_row(const float * x, wsp_ggml_bf16_t * y, int64_t n) {
  int i = 0;
#if defined(__AVX512BF16__)
  // subnormals are flushed to zero on this platform
  for (; i + 32 <= n; i += 32) {
        _mm512_storeu_si512(
            (__m512i *)(y + i),
            m512i(_mm512_cvtne2ps_pbh(_mm512_loadu_ps(x + i + 16),
                                _mm512_loadu_ps(x + i))));
  }
#endif
    for (; i < n; i++) {
        y[i] = WSP_GGML_FP32_TO_BF16(x[i]);
    }
}

bool wsp_ggml_guid_matches(wsp_ggml_guid_t guid_a, wsp_ggml_guid_t guid_b) {
    return memcmp(guid_a, guid_b, sizeof(wsp_ggml_guid)) == 0;
}

const char * wsp_ggml_version(void) {
    return WSP_GGML_VERSION;
}

const char * wsp_ggml_commit(void) {
    return WSP_GGML_COMMIT;
}

//
// timing
//

#if defined(_MSC_VER) || defined(__MINGW32__)
static int64_t timer_freq, timer_start;
void wsp_ggml_time_init(void) {
    LARGE_INTEGER t;
    QueryPerformanceFrequency(&t);
    timer_freq = t.QuadPart;

    // The multiplication by 1000 or 1000000 below can cause an overflow if timer_freq
    // and the uptime is high enough.
    // We subtract the program start time to reduce the likelihood of that happening.
    QueryPerformanceCounter(&t);
    timer_start = t.QuadPart;
}
int64_t wsp_ggml_time_ms(void) {
    LARGE_INTEGER t;
    QueryPerformanceCounter(&t);
    return ((t.QuadPart-timer_start) * 1000) / timer_freq;
}
int64_t wsp_ggml_time_us(void) {
    LARGE_INTEGER t;
    QueryPerformanceCounter(&t);
    return ((t.QuadPart-timer_start) * 1000000) / timer_freq;
}
#else
void wsp_ggml_time_init(void) {}
int64_t wsp_ggml_time_ms(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec*1000 + (int64_t)ts.tv_nsec/1000000;
}

int64_t wsp_ggml_time_us(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec*1000000 + (int64_t)ts.tv_nsec/1000;
}
#endif

int64_t wsp_ggml_cycles(void) {
    return clock();
}

int64_t wsp_ggml_cycles_per_ms(void) {
    return CLOCKS_PER_SEC/1000;
}

//
// cross-platform UTF-8 file paths
//

#ifdef _WIN32
static wchar_t * wsp_ggml_mbstowcs(const char * mbs) {
    int wlen = MultiByteToWideChar(CP_UTF8, 0, mbs, -1, NULL, 0);
    if (!wlen) {
        errno = EINVAL;
        return NULL;
    }

    wchar_t * wbuf = WSP_GGML_MALLOC(wlen * sizeof(wchar_t));
    wlen = MultiByteToWideChar(CP_UTF8, 0, mbs, -1, wbuf, wlen);
    if (!wlen) {
        WSP_GGML_FREE(wbuf);
        errno = EINVAL;
        return NULL;
    }

    return wbuf;
}
#endif

FILE * wsp_ggml_fopen(const char * fname, const char * mode) {
#ifdef _WIN32
    FILE * file = NULL;

    // convert fname (UTF-8)
    wchar_t * wfname = wsp_ggml_mbstowcs(fname);
    if (wfname) {
        // convert mode (ANSI)
        wchar_t * wmode = WSP_GGML_MALLOC((strlen(mode) + 1) * sizeof(wchar_t));
        wchar_t * wmode_p = wmode;
        do {
            *wmode_p++ = (wchar_t)*mode;
        } while (*mode++);

        // open file
        file = _wfopen(wfname, wmode);

        WSP_GGML_FREE(wfname);
        WSP_GGML_FREE(wmode);
    }

    return file;
#else
    return fopen(fname, mode);
#endif

}

static const struct wsp_ggml_type_traits type_traits[WSP_GGML_TYPE_COUNT] = {
    [WSP_GGML_TYPE_I8] = {
        .type_name                = "i8",
        .blck_size                = 1,
        .type_size                = sizeof(int8_t),
        .is_quantized             = false,
    },
    [WSP_GGML_TYPE_I16] = {
        .type_name                = "i16",
        .blck_size                = 1,
        .type_size                = sizeof(int16_t),
        .is_quantized             = false,
    },
    [WSP_GGML_TYPE_I32] = {
        .type_name                = "i32",
        .blck_size                = 1,
        .type_size                = sizeof(int32_t),
        .is_quantized             = false,
    },
    [WSP_GGML_TYPE_I64] = {
        .type_name                = "i64",
        .blck_size                = 1,
        .type_size                = sizeof(int64_t),
        .is_quantized             = false,
    },
    [WSP_GGML_TYPE_F64] = {
        .type_name                = "f64",
        .blck_size                = 1,
        .type_size                = sizeof(double),
        .is_quantized             = false,
    },
    [WSP_GGML_TYPE_F32] = {
        .type_name                = "f32",
        .blck_size                = 1,
        .type_size                = sizeof(float),
        .is_quantized             = false,
    },
    [WSP_GGML_TYPE_F16] = {
        .type_name                = "f16",
        .blck_size                = 1,
        .type_size                = sizeof(wsp_ggml_fp16_t),
        .is_quantized             = false,
        .to_float                 = (wsp_ggml_to_float_t) wsp_ggml_fp16_to_fp32_row,
        .from_float_ref           = (wsp_ggml_from_float_t) wsp_ggml_fp32_to_fp16_row,
    },
    [WSP_GGML_TYPE_Q4_0] = {
        .type_name                = "q4_0",
        .blck_size                = QK4_0,
        .type_size                = sizeof(block_q4_0),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_q4_0,
        .from_float_ref           = (wsp_ggml_from_float_t) wsp_quantize_row_q4_0_ref,
    },
    [WSP_GGML_TYPE_Q4_1] = {
        .type_name                = "q4_1",
        .blck_size                = QK4_1,
        .type_size                = sizeof(block_q4_1),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_q4_1,
        .from_float_ref           = (wsp_ggml_from_float_t) wsp_quantize_row_q4_1_ref,
    },
    [4] = { // WSP_GGML_TYPE_Q4_2
        .type_name                = "DEPRECATED",
        .blck_size                = 0,
        .type_size                = 0,
        .is_quantized             = false,
    },
    [5] = { // WSP_GGML_TYPE_Q4_3
        .type_name                = "DEPRECATED",
        .blck_size                = 0,
        .type_size                = 0,
        .is_quantized             = false,
    },
    [WSP_GGML_TYPE_Q5_0] = {
        .type_name                = "q5_0",
        .blck_size                = QK5_0,
        .type_size                = sizeof(block_q5_0),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_q5_0,
        .from_float_ref           = (wsp_ggml_from_float_t) wsp_quantize_row_q5_0_ref,
    },
    [WSP_GGML_TYPE_Q5_1] = {
        .type_name                = "q5_1",
        .blck_size                = QK5_1,
        .type_size                = sizeof(block_q5_1),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_q5_1,
        .from_float_ref           = (wsp_ggml_from_float_t) wsp_quantize_row_q5_1_ref,
    },
    [WSP_GGML_TYPE_Q8_0] = {
        .type_name                = "q8_0",
        .blck_size                = QK8_0,
        .type_size                = sizeof(block_q8_0),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_q8_0,
        .from_float_ref           = (wsp_ggml_from_float_t) wsp_quantize_row_q8_0_ref,
    },
    [WSP_GGML_TYPE_Q8_1] = {
        .type_name                = "q8_1",
        .blck_size                = QK8_1,
        .type_size                = sizeof(block_q8_1),
        .is_quantized             = true,
        .from_float_ref           = (wsp_ggml_from_float_t) wsp_quantize_row_q8_1_ref,
    },
    [WSP_GGML_TYPE_MXFP4] = {
        .type_name                = "mxfp4",
        .blck_size                = QK_MXFP4,
        .type_size                = sizeof(block_mxfp4),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_mxfp4,
        .from_float_ref           = (wsp_ggml_from_float_t)wsp_quantize_row_mxfp4_ref,
    },
    [WSP_GGML_TYPE_Q2_K] = {
        .type_name                = "q2_K",
        .blck_size                = QK_K,
        .type_size                = sizeof(block_q2_K),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_q2_K,
        .from_float_ref           = (wsp_ggml_from_float_t) wsp_quantize_row_q2_K_ref,
    },
    [WSP_GGML_TYPE_Q3_K] = {
        .type_name                = "q3_K",
        .blck_size                = QK_K,
        .type_size                = sizeof(block_q3_K),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_q3_K,
        .from_float_ref           = (wsp_ggml_from_float_t) wsp_quantize_row_q3_K_ref,
    },
    [WSP_GGML_TYPE_Q4_K] = {
        .type_name                = "q4_K",
        .blck_size                = QK_K,
        .type_size                = sizeof(block_q4_K),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_q4_K,
        .from_float_ref           = (wsp_ggml_from_float_t) wsp_quantize_row_q4_K_ref,
    },
    [WSP_GGML_TYPE_Q5_K] = {
        .type_name                = "q5_K",
        .blck_size                = QK_K,
        .type_size                = sizeof(block_q5_K),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_q5_K,
        .from_float_ref           = (wsp_ggml_from_float_t) wsp_quantize_row_q5_K_ref,
    },
    [WSP_GGML_TYPE_Q6_K] = {
        .type_name                = "q6_K",
        .blck_size                = QK_K,
        .type_size                = sizeof(block_q6_K),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_q6_K,
        .from_float_ref           = (wsp_ggml_from_float_t) wsp_quantize_row_q6_K_ref,
    },
    [WSP_GGML_TYPE_IQ2_XXS] = {
        .type_name                = "iq2_xxs",
        .blck_size                = QK_K,
        .type_size                = sizeof(block_iq2_xxs),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_iq2_xxs,
        .from_float_ref           = NULL,
    },
    [WSP_GGML_TYPE_IQ2_XS] = {
        .type_name                = "iq2_xs",
        .blck_size                = QK_K,
        .type_size                = sizeof(block_iq2_xs),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_iq2_xs,
        .from_float_ref           = NULL,
    },
    [WSP_GGML_TYPE_IQ3_XXS] = {
        .type_name                = "iq3_xxs",
        .blck_size                = QK_K,
        .type_size                = sizeof(block_iq3_xxs),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_iq3_xxs,
        .from_float_ref           = (wsp_ggml_from_float_t)wsp_quantize_row_iq3_xxs_ref,
    },
    [WSP_GGML_TYPE_IQ3_S] = {
        .type_name                = "iq3_s",
        .blck_size                = QK_K,
        .type_size                = sizeof(block_iq3_s),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_iq3_s,
        .from_float_ref           = (wsp_ggml_from_float_t)wsp_quantize_row_iq3_s_ref,
    },
    [WSP_GGML_TYPE_IQ2_S] = {
        .type_name                = "iq2_s",
        .blck_size                = QK_K,
        .type_size                = sizeof(block_iq2_s),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_iq2_s,
        .from_float_ref           = (wsp_ggml_from_float_t)wsp_quantize_row_iq2_s_ref,
    },
    [WSP_GGML_TYPE_IQ1_S] = {
        .type_name                = "iq1_s",
        .blck_size                = QK_K,
        .type_size                = sizeof(block_iq1_s),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_iq1_s,
        .from_float_ref           = NULL,
    },
    [WSP_GGML_TYPE_IQ1_M] = {
        .type_name                = "iq1_m",
        .blck_size                = QK_K,
        .type_size                = sizeof(block_iq1_m),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_iq1_m,
        .from_float_ref           = NULL,
    },
    [WSP_GGML_TYPE_IQ4_NL] = {
        .type_name                = "iq4_nl",
        .blck_size                = QK4_NL,
        .type_size                = sizeof(block_iq4_nl),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_iq4_nl,
        .from_float_ref           = (wsp_ggml_from_float_t)wsp_quantize_row_iq4_nl_ref,
    },
    [WSP_GGML_TYPE_IQ4_XS] = {
        .type_name                = "iq4_xs",
        .blck_size                = QK_K,
        .type_size                = sizeof(block_iq4_xs),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_iq4_xs,
        .from_float_ref           = (wsp_ggml_from_float_t)wsp_quantize_row_iq4_xs_ref,
    },
    [WSP_GGML_TYPE_Q8_K] = {
        .type_name                = "q8_K",
        .blck_size                = QK_K,
        .type_size                = sizeof(block_q8_K),
        .is_quantized             = true,
    },
    [WSP_GGML_TYPE_BF16] = {
        .type_name                = "bf16",
        .blck_size                = 1,
        .type_size                = sizeof(wsp_ggml_bf16_t),
        .is_quantized             = false,
        .to_float                 = (wsp_ggml_to_float_t) wsp_ggml_bf16_to_fp32_row,
        .from_float_ref           = (wsp_ggml_from_float_t) wsp_ggml_fp32_to_bf16_row_ref,
    },
    [31] = { // WSP_GGML_TYPE_Q4_0_4_4
        .type_name                = "TYPE_Q4_0_4_4 REMOVED, use Q4_0 with runtime repacking",
        .blck_size                = 0,
        .type_size                = 0,
        .is_quantized             = false,
    },
    [32] = { // WSP_GGML_TYPE_Q4_0_4_8
        .type_name                = "TYPE_Q4_0_4_8 REMOVED, use Q4_0 with runtime repacking",
        .blck_size                = 0,
        .type_size                = 0,
        .is_quantized             = false,
    },
    [33] = { // WSP_GGML_TYPE_Q4_0_8_8
        .type_name                = "TYPE_Q4_0_8_8 REMOVED, use Q4_0 with runtime repacking",
        .blck_size                = 0,
        .type_size                = 0,
        .is_quantized             = false,
    },
    [WSP_GGML_TYPE_TQ1_0] = {
        .type_name                = "tq1_0",
        .blck_size                = QK_K,
        .type_size                = sizeof(block_tq1_0),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_tq1_0,
        .from_float_ref           = (wsp_ggml_from_float_t) wsp_quantize_row_tq1_0_ref,
    },
    [WSP_GGML_TYPE_TQ2_0] = {
        .type_name                = "tq2_0",
        .blck_size                = QK_K,
        .type_size                = sizeof(block_tq2_0),
        .is_quantized             = true,
        .to_float                 = (wsp_ggml_to_float_t) wsp_dewsp_quantize_row_tq2_0,
        .from_float_ref           = (wsp_ggml_from_float_t) wsp_quantize_row_tq2_0_ref,
    },
    [36] = { // WSP_GGML_TYPE_IQ4_NL_4_4
        .type_name                = "TYPE_IQ4_NL_4_4 REMOVED, use IQ4_NL with runtime repacking",
        .blck_size                = 0,
        .type_size                = 0,
        .is_quantized             = false,
    },
    [37] = { // WSP_GGML_TYPE_IQ4_NL_4_8
        .type_name                = "TYPE_IQ4_NL_4_8 REMOVED, use IQ4_NL with runtime repacking",
        .blck_size                = 0,
        .type_size                = 0,
        .is_quantized             = false,
    },
    [38] = { // WSP_GGML_TYPE_IQ4_NL_8_8
        .type_name                = "TYPE_IQ4_NL_8_8 REMOVED, use IQ4_NL with runtime repacking",
        .blck_size                = 0,
        .type_size                = 0,
        .is_quantized             = false,
    },
};

const struct wsp_ggml_type_traits * wsp_ggml_get_type_traits(enum wsp_ggml_type type) {
    WSP_GGML_ASSERT(type < WSP_GGML_TYPE_COUNT);
    return &type_traits[type];
}

//
// ggml object
//

struct wsp_ggml_object {
    size_t offs;
    size_t size;

    struct wsp_ggml_object * next;

    enum wsp_ggml_object_type type;

    char padding[4];
};

static const size_t WSP_GGML_OBJECT_SIZE = sizeof(struct wsp_ggml_object);

//
// ggml context
//

struct wsp_ggml_context {
    size_t mem_size;
    void * mem_buffer;
    bool   mem_buffer_owned;
    bool   no_alloc;

    int    n_objects;

    struct wsp_ggml_object * objects_begin;
    struct wsp_ggml_object * objects_end;
};

//
// data types
//

static const char * WSP_GGML_OP_NAME[WSP_GGML_OP_COUNT] = {
    "NONE",

    "DUP",
    "ADD",
    "ADD_ID",
    "ADD1",
    "ACC",
    "SUB",
    "MUL",
    "DIV",
    "SQR",
    "SQRT",
    "LOG",
    "SIN",
    "COS",
    "SUM",
    "SUM_ROWS",
    "CUMSUM",
    "MEAN",
    "ARGMAX",
    "COUNT_EQUAL",
    "REPEAT",
    "REPEAT_BACK",
    "CONCAT",
    "SILU_BACK",
    "NORM",
    "RMS_NORM",
    "RMS_NORM_BACK",
    "GROUP_NORM",
    "L2_NORM",

    "MUL_MAT",
    "MUL_MAT_ID",
    "OUT_PROD",

    "SCALE",
    "SET",
    "CPY",
    "CONT",
    "RESHAPE",
    "VIEW",
    "PERMUTE",
    "TRANSPOSE",
    "GET_ROWS",
    "GET_ROWS_BACK",
    "SET_ROWS",
    "DIAG",
    "DIAG_MASK_INF",
    "DIAG_MASK_ZERO",
    "SOFT_MAX",
    "SOFT_MAX_BACK",
    "ROPE",
    "ROPE_BACK",
    "CLAMP",
    "CONV_TRANSPOSE_1D",
    "IM2COL",
    "IM2COL_BACK",
    "IM2COL_3D",
    "CONV_2D",
    "CONV_3D",
    "CONV_2D_DW",
    "CONV_TRANSPOSE_2D",
    "POOL_1D",
    "POOL_2D",
    "POOL_2D_BACK",
    "UPSCALE",
    "PAD",
    "PAD_REFLECT_1D",
    "ROLL",
    "ARANGE",
    "TIMESTEP_EMBEDDING",
    "ARGSORT",
    "LEAKY_RELU",
    "TRI",
    "FILL",

    "FLASH_ATTN_EXT",
    "FLASH_ATTN_BACK",
    "SSM_CONV",
    "SSM_SCAN",
    "WIN_PART",
    "WIN_UNPART",
    "GET_REL_POS",
    "ADD_REL_POS",
    "RWKV_WKV6",
    "GATED_LINEAR_ATTN",
    "RWKV_WKV7",
    "SOLVE_TRI",

    "UNARY",

    "MAP_CUSTOM1",
    "MAP_CUSTOM2",
    "MAP_CUSTOM3",

    "CUSTOM",

    "CROSS_ENTROPY_LOSS",
    "CROSS_ENTROPY_LOSS_BACK",
    "OPT_STEP_ADAMW",
    "OPT_STEP_SGD",

    "GLU",
};

static_assert(WSP_GGML_OP_COUNT == 94, "WSP_GGML_OP_COUNT != 94");

static const char * WSP_GGML_OP_SYMBOL[WSP_GGML_OP_COUNT] = {
    "none",

    "x",
    "x+y",
    "x[i]+y",
    "x+y",
    "view(x,nb,offset)+=y->x",
    "x-y",
    "x*y",
    "x/y",
    "x^2",
    "√x",
    "log(x)",
    "sin(x)",
    "cos(x)",
    "Σx",
    "Σx_k",
    "cumsum(x)",
    "Σx/n",
    "argmax(x)",
    "count_equal(x)",
    "repeat(x)",
    "repeat_back(x)",
    "concat(x, y)",
    "silu_back(x)",
    "norm(x)",
    "rms_norm(x)",
    "rms_norm_back(x)",
    "group_norm(x)",
    "l2_norm(x)",

    "X*Y",
    "X[i]*Y",
    "X*Y",

    "x*v",
    "y-\\>view(x)",
    "x-\\>y",
    "cont(x)",
    "reshape(x)",
    "view(x)",
    "permute(x)",
    "transpose(x)",
    "get_rows(x)",
    "get_rows_back(x)",
    "set_rows(x)",
    "diag(x)",
    "diag_mask_inf(x)",
    "diag_mask_zero(x)",
    "soft_max(x)",
    "soft_max_back(x)",
    "rope(x)",
    "rope_back(x)",
    "clamp(x)",
    "conv_transpose_1d(x)",
    "im2col(x)",
    "im2col_back(x)",
    "im2col_3d(x)",
    "conv_2d(x)",
    "conv_3d(x)",
    "conv_2d_dw(x)",
    "conv_transpose_2d(x)",
    "pool_1d(x)",
    "pool_2d(x)",
    "pool_2d_back(x)",
    "upscale(x)",
    "pad(x)",
    "pad_reflect_1d(x)",
    "roll(x)",
    "arange(start, stop, step)",
    "timestep_embedding(timesteps, dim, max_period)",
    "argsort(x)",
    "leaky_relu(x)",
    "tri(x)",
    "fill(x, c)",

    "flash_attn_ext(x)",
    "flash_attn_back(x)",
    "ssm_conv(x)",
    "ssm_scan(x)",
    "win_part(x)",
    "win_unpart(x)",
    "get_rel_pos(x)",
    "add_rel_pos(x)",
    "rwkv_wkv6(k, v, r, tf, td, s)",
    "gated_linear_attn(k, v, q, gate, s)",
    "rwkv_wkv7(r, w, k, v, a, b, s)",
    "A X = B, A triangular, solve X",

    "unary(x)",

    "map_custom(x)",
    "map_custom(x,y)",
    "map_custom(x,y,z)",

    "custom(x)",

    "cross_entropy_loss(x,y)",
    "cross_entropy_loss_back(x,y)",
    "adamw(x)",
    "sgd(x)",

    "glu(x)",
};

static_assert(WSP_GGML_OP_COUNT == 94, "WSP_GGML_OP_COUNT != 94");

static_assert(WSP_GGML_OP_POOL_COUNT == 2, "WSP_GGML_OP_POOL_COUNT != 2");

static const char * WSP_GGML_UNARY_OP_NAME[WSP_GGML_UNARY_OP_COUNT] = {
    "ABS",
    "SGN",
    "NEG",
    "STEP",
    "TANH",
    "ELU",
    "RELU",
    "SIGMOID",
    "GELU",
    "GELU_QUICK",
    "SILU",
    "HARDSWISH",
    "HARDSIGMOID",
    "EXP",
    "EXPM1",
    "SOFTPLUS",
    "GELU_ERF",
    "XIELU",
    "FLOOR",
    "CEIL",
    "ROUND",
    "TRUNC",
};

static_assert(WSP_GGML_UNARY_OP_COUNT == 22, "WSP_GGML_UNARY_OP_COUNT != 22");

static const char * WSP_GGML_GLU_OP_NAME[WSP_GGML_GLU_OP_COUNT] = {
    "REGLU",
    "GEGLU",
    "SWIGLU",
    "SWIGLU_OAI",
    "GEGLU_ERF",
    "GEGLU_QUICK",
};

static_assert(WSP_GGML_GLU_OP_COUNT == 6, "WSP_GGML_GLU_OP_COUNT != 6");


static_assert(sizeof(struct wsp_ggml_object)%WSP_GGML_MEM_ALIGN == 0, "wsp_ggml_object size must be a multiple of WSP_GGML_MEM_ALIGN");
static_assert(sizeof(struct wsp_ggml_tensor)%WSP_GGML_MEM_ALIGN == 0, "wsp_ggml_tensor size must be a multiple of WSP_GGML_MEM_ALIGN");


////////////////////////////////////////////////////////////////////////////////

void wsp_ggml_print_object(const struct wsp_ggml_object * obj) {
    WSP_GGML_LOG_INFO(" - wsp_ggml_object: type = %d, offset = %zu, size = %zu, next = %p\n",
            obj->type, obj->offs, obj->size, (const void *) obj->next);
}

void wsp_ggml_print_objects(const struct wsp_ggml_context * ctx) {
    struct wsp_ggml_object * obj = ctx->objects_begin;

    WSP_GGML_LOG_INFO("%s: objects in context %p:\n", __func__, (const void *) ctx);

    while (obj != NULL) {
        wsp_ggml_print_object(obj);
        obj = obj->next;
    }

    WSP_GGML_LOG_INFO("%s: --- end ---\n", __func__);
}

int64_t wsp_ggml_nelements(const struct wsp_ggml_tensor * tensor) {
    static_assert(WSP_GGML_MAX_DIMS == 4, "WSP_GGML_MAX_DIMS is not 4 - update this function");

    return tensor->ne[0]*tensor->ne[1]*tensor->ne[2]*tensor->ne[3];
}

int64_t wsp_ggml_nrows(const struct wsp_ggml_tensor * tensor) {
    static_assert(WSP_GGML_MAX_DIMS == 4, "WSP_GGML_MAX_DIMS is not 4 - update this function");

    return tensor->ne[1]*tensor->ne[2]*tensor->ne[3];
}

size_t wsp_ggml_nbytes(const struct wsp_ggml_tensor * tensor) {
    for (int i = 0; i < WSP_GGML_MAX_DIMS; ++i) {
        if (tensor->ne[i] <= 0) {
            return 0;
        }
    }

    size_t nbytes;
    const size_t blck_size = wsp_ggml_blck_size(tensor->type);
    if (blck_size == 1) {
        nbytes = wsp_ggml_type_size(tensor->type);
        for (int i = 0; i < WSP_GGML_MAX_DIMS; ++i) {
            nbytes += (tensor->ne[i] - 1)*tensor->nb[i];
        }
    }
    else {
        nbytes = tensor->ne[0]*tensor->nb[0]/blck_size;
        for (int i = 1; i < WSP_GGML_MAX_DIMS; ++i) {
            nbytes += (tensor->ne[i] - 1)*tensor->nb[i];
        }
    }

    return nbytes;
}

size_t wsp_ggml_nbytes_pad(const struct wsp_ggml_tensor * tensor) {
    return WSP_GGML_PAD(wsp_ggml_nbytes(tensor), WSP_GGML_MEM_ALIGN);
}

int64_t wsp_ggml_blck_size(enum wsp_ggml_type type) {
    return type_traits[type].blck_size;
}

size_t wsp_ggml_type_size(enum wsp_ggml_type type) {
    return type_traits[type].type_size;
}

size_t wsp_ggml_row_size(enum wsp_ggml_type type, int64_t ne) {
    assert(ne % wsp_ggml_blck_size(type) == 0);
    return wsp_ggml_type_size(type)*ne/wsp_ggml_blck_size(type);
}

double wsp_ggml_type_sizef(enum wsp_ggml_type type) {
    return ((double)(type_traits[type].type_size))/type_traits[type].blck_size;
}

const char * wsp_ggml_type_name(enum wsp_ggml_type type) {
    return type < WSP_GGML_TYPE_COUNT ? type_traits[type].type_name : "NONE";
}

bool wsp_ggml_is_quantized(enum wsp_ggml_type type) {
    return type_traits[type].is_quantized;
}

const char * wsp_ggml_op_name(enum wsp_ggml_op op) {
    return WSP_GGML_OP_NAME[op];
}

const char * wsp_ggml_op_symbol(enum wsp_ggml_op op) {
    return WSP_GGML_OP_SYMBOL[op];
}

const char * wsp_ggml_unary_op_name(enum wsp_ggml_unary_op op) {
    return WSP_GGML_UNARY_OP_NAME[op];
}

const char * wsp_ggml_glu_op_name(enum wsp_ggml_glu_op op) {
    return WSP_GGML_GLU_OP_NAME[op];
}

const char * wsp_ggml_op_desc(const struct wsp_ggml_tensor * t) {
    if (t->op == WSP_GGML_OP_UNARY) {
        enum wsp_ggml_unary_op uop = wsp_ggml_get_unary_op(t);
        return wsp_ggml_unary_op_name(uop);
    }
    if (t->op == WSP_GGML_OP_GLU) {
        enum wsp_ggml_glu_op gop = wsp_ggml_get_glu_op(t);
        return wsp_ggml_glu_op_name(gop);
    }
    return wsp_ggml_op_name(t->op);
}

size_t wsp_ggml_element_size(const struct wsp_ggml_tensor * tensor) {
    return wsp_ggml_type_size(tensor->type);
}

bool wsp_ggml_is_scalar(const struct wsp_ggml_tensor * tensor) {
    static_assert(WSP_GGML_MAX_DIMS == 4, "WSP_GGML_MAX_DIMS is not 4 - update this function");

    return tensor->ne[0] == 1 && tensor->ne[1] == 1 && tensor->ne[2] == 1 && tensor->ne[3] == 1;
}

bool wsp_ggml_is_vector(const struct wsp_ggml_tensor * tensor) {
    static_assert(WSP_GGML_MAX_DIMS == 4, "WSP_GGML_MAX_DIMS is not 4 - update this function");

    return tensor->ne[1] == 1 && tensor->ne[2] == 1 && tensor->ne[3] == 1;
}

bool wsp_ggml_is_matrix(const struct wsp_ggml_tensor * tensor) {
    static_assert(WSP_GGML_MAX_DIMS == 4, "WSP_GGML_MAX_DIMS is not 4 - update this function");

    return tensor->ne[2] == 1 && tensor->ne[3] == 1;
}

bool wsp_ggml_is_3d(const struct wsp_ggml_tensor * tensor) {
    return tensor->ne[3] == 1;
}

int wsp_ggml_n_dims(const struct wsp_ggml_tensor * tensor) {
    for (int i = WSP_GGML_MAX_DIMS - 1; i >= 1; --i) {
        if (tensor->ne[i] > 1) {
            return i + 1;
        }
    }
    return 1;
}

enum wsp_ggml_type wsp_ggml_ftype_to_wsp_ggml_type(enum wsp_ggml_ftype ftype) {
    enum wsp_ggml_type wtype = WSP_GGML_TYPE_COUNT;

    switch (ftype) {
        case WSP_GGML_FTYPE_ALL_F32:              wtype = WSP_GGML_TYPE_F32;   break;
        case WSP_GGML_FTYPE_MOSTLY_F16:           wtype = WSP_GGML_TYPE_F16;   break;
        case WSP_GGML_FTYPE_MOSTLY_BF16:          wtype = WSP_GGML_TYPE_BF16;  break;
        case WSP_GGML_FTYPE_MOSTLY_Q4_0:          wtype = WSP_GGML_TYPE_Q4_0;  break;
        case WSP_GGML_FTYPE_MOSTLY_Q4_1:          wtype = WSP_GGML_TYPE_Q4_1;  break;
        case WSP_GGML_FTYPE_MOSTLY_Q5_0:          wtype = WSP_GGML_TYPE_Q5_0;  break;
        case WSP_GGML_FTYPE_MOSTLY_Q5_1:          wtype = WSP_GGML_TYPE_Q5_1;  break;
        case WSP_GGML_FTYPE_MOSTLY_Q8_0:          wtype = WSP_GGML_TYPE_Q8_0;  break;
        case WSP_GGML_FTYPE_MOSTLY_MXFP4:         wtype = WSP_GGML_TYPE_MXFP4; break;
        case WSP_GGML_FTYPE_MOSTLY_Q2_K:          wtype = WSP_GGML_TYPE_Q2_K;  break;
        case WSP_GGML_FTYPE_MOSTLY_Q3_K:          wtype = WSP_GGML_TYPE_Q3_K;  break;
        case WSP_GGML_FTYPE_MOSTLY_Q4_K:          wtype = WSP_GGML_TYPE_Q4_K;  break;
        case WSP_GGML_FTYPE_MOSTLY_Q5_K:          wtype = WSP_GGML_TYPE_Q5_K;  break;
        case WSP_GGML_FTYPE_MOSTLY_Q6_K:          wtype = WSP_GGML_TYPE_Q6_K;  break;
        case WSP_GGML_FTYPE_MOSTLY_IQ2_XXS:       wtype = WSP_GGML_TYPE_IQ2_XXS;  break;
        case WSP_GGML_FTYPE_MOSTLY_IQ2_XS:        wtype = WSP_GGML_TYPE_IQ2_XS;   break;
        case WSP_GGML_FTYPE_MOSTLY_IQ3_XXS:       wtype = WSP_GGML_TYPE_IQ3_XXS;  break;
        case WSP_GGML_FTYPE_MOSTLY_IQ1_S:         wtype = WSP_GGML_TYPE_IQ1_S;    break;
        case WSP_GGML_FTYPE_MOSTLY_IQ1_M:         wtype = WSP_GGML_TYPE_IQ1_M;    break;
        case WSP_GGML_FTYPE_MOSTLY_IQ4_NL:        wtype = WSP_GGML_TYPE_IQ4_NL;   break;
        case WSP_GGML_FTYPE_MOSTLY_IQ4_XS:        wtype = WSP_GGML_TYPE_IQ4_XS;   break;
        case WSP_GGML_FTYPE_MOSTLY_IQ3_S:         wtype = WSP_GGML_TYPE_IQ3_S;    break;
        case WSP_GGML_FTYPE_MOSTLY_IQ2_S:         wtype = WSP_GGML_TYPE_IQ2_S;    break;
        case WSP_GGML_FTYPE_UNKNOWN:              wtype = WSP_GGML_TYPE_COUNT; break;
        case WSP_GGML_FTYPE_MOSTLY_Q4_1_SOME_F16: wtype = WSP_GGML_TYPE_COUNT; break;
    }

    WSP_GGML_ASSERT(wtype != WSP_GGML_TYPE_COUNT);

    return wtype;
}

size_t wsp_ggml_tensor_overhead(void) {
    return WSP_GGML_OBJECT_SIZE + WSP_GGML_TENSOR_SIZE;
}

bool wsp_ggml_is_transposed(const struct wsp_ggml_tensor * tensor) {
    return tensor->nb[0] > tensor->nb[1];
}

static bool wsp_ggml_is_contiguous_n(const struct wsp_ggml_tensor * tensor, int n) {
    size_t next_nb = wsp_ggml_type_size(tensor->type);
    if (tensor->ne[0] != wsp_ggml_blck_size(tensor->type) && tensor->nb[0] != next_nb) {
        return false;
    }
    next_nb *= tensor->ne[0]/wsp_ggml_blck_size(tensor->type);
    for (int i = 1; i < WSP_GGML_MAX_DIMS; i++) {
        if (tensor->ne[i] != 1) {
            if (i > n) {
                if (tensor->nb[i] != next_nb) {
                    return false;
                }
                next_nb *= tensor->ne[i];
            } else {
                // this dimension does not need to be contiguous
                next_nb = tensor->ne[i]*tensor->nb[i];
            }
        }
    }
    return true;
}

bool wsp_ggml_is_contiguous(const struct wsp_ggml_tensor * tensor) {
    return wsp_ggml_is_contiguous_0(tensor);
}

bool wsp_ggml_is_contiguous_0(const struct wsp_ggml_tensor * tensor) {
    return wsp_ggml_is_contiguous_n(tensor, 0);
}

bool wsp_ggml_is_contiguous_1(const struct wsp_ggml_tensor * tensor) {
    return wsp_ggml_is_contiguous_n(tensor, 1);
}

bool wsp_ggml_is_contiguous_2(const struct wsp_ggml_tensor * tensor) {
    return wsp_ggml_is_contiguous_n(tensor, 2);
}

bool wsp_ggml_is_contiguously_allocated(const struct wsp_ggml_tensor * tensor) {
    return wsp_ggml_nbytes(tensor) == wsp_ggml_nelements(tensor) * wsp_ggml_type_size(tensor->type)/wsp_ggml_blck_size(tensor->type);
}

bool wsp_ggml_is_permuted(const struct wsp_ggml_tensor * tensor) {
    static_assert(WSP_GGML_MAX_DIMS == 4, "WSP_GGML_MAX_DIMS is not 4 - update this function");

    return tensor->nb[0] > tensor->nb[1] || tensor->nb[1] > tensor->nb[2] || tensor->nb[2] > tensor->nb[3];
}

bool wsp_ggml_is_contiguous_channels(const struct wsp_ggml_tensor * tensor) {
    return
        tensor->nb[0] > tensor->nb[2] &&
        tensor->nb[1] > tensor->nb[0] &&
        tensor->nb[2] == wsp_ggml_type_size(tensor->type);
}

bool wsp_ggml_is_contiguous_rows(const struct wsp_ggml_tensor * tensor) {
    return
        tensor->ne[0] == wsp_ggml_blck_size(tensor->type) ||
        tensor->nb[0] == wsp_ggml_type_size(tensor->type);
}

static inline bool wsp_ggml_is_padded_1d(const struct wsp_ggml_tensor * tensor) {
    static_assert(WSP_GGML_MAX_DIMS == 4, "WSP_GGML_MAX_DIMS is not 4 - update this function");

    return
        tensor->nb[0] == wsp_ggml_type_size(tensor->type) &&
        tensor->nb[2] == tensor->nb[1]*tensor->ne[1] &&
        tensor->nb[3] == tensor->nb[2]*tensor->ne[2];
}

bool wsp_ggml_is_empty(const struct wsp_ggml_tensor * tensor) {
    for (int i = 0; i < WSP_GGML_MAX_DIMS; ++i) {
        if (tensor->ne[i] == 0) {
            // empty if any dimension has no elements
            return true;
        }
    }
    return false;
}

bool wsp_ggml_are_same_shape(const struct wsp_ggml_tensor * t0, const struct wsp_ggml_tensor * t1) {
    static_assert(WSP_GGML_MAX_DIMS == 4, "WSP_GGML_MAX_DIMS is not 4 - update this function");

    return
        (t0->ne[0] == t1->ne[0]) &&
        (t0->ne[1] == t1->ne[1]) &&
        (t0->ne[2] == t1->ne[2]) &&
        (t0->ne[3] == t1->ne[3]);
}

bool wsp_ggml_are_same_stride(const struct wsp_ggml_tensor * t0, const struct wsp_ggml_tensor * t1) {
    static_assert(WSP_GGML_MAX_DIMS == 4, "WSP_GGML_MAX_DIMS is not 4 - update this function");

    return
        (t0->nb[0] == t1->nb[0]) &&
        (t0->nb[1] == t1->nb[1]) &&
        (t0->nb[2] == t1->nb[2]) &&
        (t0->nb[3] == t1->nb[3]);
}

// check if t1 can be represented as a repetition of t0
bool wsp_ggml_can_repeat(const struct wsp_ggml_tensor * t0, const struct wsp_ggml_tensor * t1) {
    static_assert(WSP_GGML_MAX_DIMS == 4, "WSP_GGML_MAX_DIMS is not 4 - update this function");

    return wsp_ggml_is_empty(t0) ? wsp_ggml_is_empty(t1) :
        (t1->ne[0]%t0->ne[0] == 0) &&
        (t1->ne[1]%t0->ne[1] == 0) &&
        (t1->ne[2]%t0->ne[2] == 0) &&
        (t1->ne[3]%t0->ne[3] == 0);
}

static inline bool wsp_ggml_can_repeat_rows(const struct wsp_ggml_tensor * t0, const struct wsp_ggml_tensor * t1) {
    static_assert(WSP_GGML_MAX_DIMS == 4, "WSP_GGML_MAX_DIMS is not 4 - update this function");

    return (t0->ne[0] == t1->ne[0]) && wsp_ggml_can_repeat(t0, t1);
}

// assert that pointer is aligned to WSP_GGML_MEM_ALIGN
#define WSP_GGML_ASSERT_ALIGNED(ptr) \
    WSP_GGML_ASSERT(((uintptr_t) (ptr))%WSP_GGML_MEM_ALIGN == 0)

////////////////////////////////////////////////////////////////////////////////

struct wsp_ggml_context * wsp_ggml_init(struct wsp_ggml_init_params params) {
    static bool is_first_call = true;

    wsp_ggml_critical_section_start();

    if (is_first_call) {
        // initialize time system (required on Windows)
        wsp_ggml_time_init();

        is_first_call = false;
    }

    wsp_ggml_critical_section_end();

    struct wsp_ggml_context * ctx = WSP_GGML_MALLOC(sizeof(struct wsp_ggml_context));

    // allow to call wsp_ggml_init with 0 size
    if (params.mem_size == 0) {
        params.mem_size = WSP_GGML_MEM_ALIGN;
    }

    const size_t mem_size = params.mem_buffer ? params.mem_size : WSP_GGML_PAD(params.mem_size, WSP_GGML_MEM_ALIGN);

    *ctx = (struct wsp_ggml_context) {
        /*.mem_size           =*/ mem_size,
        /*.mem_buffer         =*/ params.mem_buffer ? params.mem_buffer : wsp_ggml_aligned_malloc(mem_size),
        /*.mem_buffer_owned   =*/ params.mem_buffer ? false : true,
        /*.no_alloc           =*/ params.no_alloc,
        /*.n_objects          =*/ 0,
        /*.objects_begin      =*/ NULL,
        /*.objects_end        =*/ NULL,
    };

    WSP_GGML_ASSERT(ctx->mem_buffer != NULL);

    WSP_GGML_ASSERT_ALIGNED(ctx->mem_buffer);

    WSP_GGML_PRINT_DEBUG("%s: context initialized\n", __func__);

    return ctx;
}

void wsp_ggml_reset(struct wsp_ggml_context * ctx) {
    if (ctx == NULL) {
        return;
    }

    ctx->n_objects     = 0;
    ctx->objects_begin = NULL;
    ctx->objects_end   = NULL;
}

void wsp_ggml_free(struct wsp_ggml_context * ctx) {
    if (ctx == NULL) {
        return;
    }

    if (ctx->mem_buffer_owned) {
        wsp_ggml_aligned_free(ctx->mem_buffer, ctx->mem_size);
    }

    WSP_GGML_FREE(ctx);
}

size_t wsp_ggml_used_mem(const struct wsp_ggml_context * ctx) {
    return ctx->objects_end == NULL ? 0 : ctx->objects_end->offs + ctx->objects_end->size;
}

bool wsp_ggml_get_no_alloc(struct wsp_ggml_context * ctx) {
    return ctx->no_alloc;
}

void wsp_ggml_set_no_alloc(struct wsp_ggml_context * ctx, bool no_alloc) {
    ctx->no_alloc = no_alloc;
}

void * wsp_ggml_get_mem_buffer(const struct wsp_ggml_context * ctx) {
    return ctx->mem_buffer;
}

size_t wsp_ggml_get_mem_size(const struct wsp_ggml_context * ctx) {
    return ctx->mem_size;
}

size_t wsp_ggml_get_max_tensor_size(const struct wsp_ggml_context * ctx) {
    size_t max_size = 0;

    for (struct wsp_ggml_tensor * tensor = wsp_ggml_get_first_tensor(ctx); tensor != NULL; tensor = wsp_ggml_get_next_tensor(ctx, tensor)) {
        size_t bytes = wsp_ggml_nbytes(tensor);
        max_size = MAX(max_size, bytes);
    }

    return max_size;
}

////////////////////////////////////////////////////////////////////////////////

static struct wsp_ggml_object * wsp_ggml_new_object(struct wsp_ggml_context * ctx, enum wsp_ggml_object_type type, size_t size) {
    // always insert objects at the end of the context's memory pool
    struct wsp_ggml_object * obj_cur = ctx->objects_end;

    const size_t cur_offs = obj_cur == NULL ? 0 : obj_cur->offs;
    const size_t cur_size = obj_cur == NULL ? 0 : obj_cur->size;
    const size_t cur_end  = cur_offs + cur_size;

    // align to WSP_GGML_MEM_ALIGN
    size_t size_needed = WSP_GGML_PAD(size, WSP_GGML_MEM_ALIGN);

    char * const mem_buffer = ctx->mem_buffer;
    struct wsp_ggml_object * const obj_new = (struct wsp_ggml_object *)(mem_buffer + cur_end);

    if (cur_end + size_needed + WSP_GGML_OBJECT_SIZE > ctx->mem_size) {
        WSP_GGML_LOG_WARN("%s: not enough space in the context's memory pool (needed %zu, available %zu)\n",
                __func__, cur_end + size_needed + WSP_GGML_OBJECT_SIZE, ctx->mem_size);
#ifndef NDEBUG
        WSP_GGML_ABORT("not enough space in the context's memory pool");
#endif
        return NULL;
    }

    *obj_new = (struct wsp_ggml_object) {
        .offs = cur_end + WSP_GGML_OBJECT_SIZE,
        .size = size_needed,
        .next = NULL,
        .type = type,
    };

    WSP_GGML_ASSERT_ALIGNED(mem_buffer + obj_new->offs);

    if (obj_cur != NULL) {
        obj_cur->next = obj_new;
    } else {
        // this is the first object in this context
        ctx->objects_begin = obj_new;
    }

    ctx->objects_end = obj_new;

    //printf("%s: inserted new object at %zu, size = %zu\n", __func__, cur_end, obj_new->size);

    return obj_new;
}

static struct wsp_ggml_tensor * wsp_ggml_new_tensor_impl(
        struct wsp_ggml_context * ctx,
        enum   wsp_ggml_type      type,
        int                   n_dims,
        const int64_t       * ne,
        struct wsp_ggml_tensor  * view_src,
        size_t                view_offs) {

    WSP_GGML_ASSERT(type >= 0 && type < WSP_GGML_TYPE_COUNT);
    WSP_GGML_ASSERT(n_dims >= 1 && n_dims <= WSP_GGML_MAX_DIMS);

    // find the base tensor and absolute offset
    if (view_src != NULL && view_src->view_src != NULL) {
        view_offs += view_src->view_offs;
        view_src   = view_src->view_src;
    }

    size_t data_size = wsp_ggml_row_size(type, ne[0]);
    for (int i = 1; i < n_dims; i++) {
        data_size *= ne[i];
    }

    WSP_GGML_ASSERT(view_src == NULL || data_size == 0 || data_size + view_offs <= wsp_ggml_nbytes(view_src));

    void * data = view_src != NULL ? view_src->data : NULL;
    if (data != NULL) {
        data = (char *) data + view_offs;
    }

    size_t obj_alloc_size = 0;

    if (view_src == NULL && !ctx->no_alloc) {
        // allocate tensor data in the context's memory pool
        obj_alloc_size = data_size;
    }

    struct wsp_ggml_object * const obj_new = wsp_ggml_new_object(ctx, WSP_GGML_OBJECT_TYPE_TENSOR, WSP_GGML_TENSOR_SIZE + obj_alloc_size);
    WSP_GGML_ASSERT(obj_new);

    struct wsp_ggml_tensor * const result = (struct wsp_ggml_tensor *)((char *)ctx->mem_buffer + obj_new->offs);

    *result = (struct wsp_ggml_tensor) {
        /*.type         =*/ type,
        /*.buffer       =*/ NULL,
        /*.ne           =*/ { 1, 1, 1, 1 },
        /*.nb           =*/ { 0, 0, 0, 0 },
        /*.op           =*/ WSP_GGML_OP_NONE,
        /*.op_params    =*/ { 0 },
        /*.flags        =*/ 0,
        /*.src          =*/ { NULL },
        /*.view_src     =*/ view_src,
        /*.view_offs    =*/ view_offs,
        /*.data         =*/ obj_alloc_size > 0 ? (void *)(result + 1) : data,
        /*.name         =*/ { 0 },
        /*.extra        =*/ NULL,
        /*.padding      =*/ { 0 },
    };

    // TODO: this should not be needed as long as we don't rely on aligned SIMD loads
    //WSP_GGML_ASSERT_ALIGNED(result->data);

    for (int i = 0; i < n_dims; i++) {
        result->ne[i] = ne[i];
    }

    result->nb[0] = wsp_ggml_type_size(type);
    result->nb[1] = result->nb[0]*(result->ne[0]/wsp_ggml_blck_size(type));
    for (int i = 2; i < WSP_GGML_MAX_DIMS; i++) {
        result->nb[i] = result->nb[i - 1]*result->ne[i - 1];
    }

    ctx->n_objects++;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_new_tensor(
        struct wsp_ggml_context * ctx,
        enum   wsp_ggml_type      type,
        int                   n_dims,
        const int64_t       * ne) {
    return wsp_ggml_new_tensor_impl(ctx, type, n_dims, ne, NULL, 0);
}

struct wsp_ggml_tensor * wsp_ggml_new_tensor_1d(
        struct wsp_ggml_context * ctx,
        enum   wsp_ggml_type      type,
        int64_t ne0) {
    return wsp_ggml_new_tensor(ctx, type, 1, &ne0);
}

struct wsp_ggml_tensor * wsp_ggml_new_tensor_2d(
        struct wsp_ggml_context * ctx,
        enum   wsp_ggml_type      type,
        int64_t ne0,
        int64_t ne1) {
    const int64_t ne[2] = { ne0, ne1 };
    return wsp_ggml_new_tensor(ctx, type, 2, ne);
}

struct wsp_ggml_tensor * wsp_ggml_new_tensor_3d(
        struct wsp_ggml_context * ctx,
        enum   wsp_ggml_type      type,
        int64_t ne0,
        int64_t ne1,
        int64_t ne2) {
    const int64_t ne[3] = { ne0, ne1, ne2 };
    return wsp_ggml_new_tensor(ctx, type, 3, ne);
}

struct wsp_ggml_tensor * wsp_ggml_new_tensor_4d(
        struct wsp_ggml_context * ctx,
        enum   wsp_ggml_type type,
        int64_t ne0,
        int64_t ne1,
        int64_t ne2,
        int64_t ne3) {
    const int64_t ne[4] = { ne0, ne1, ne2, ne3 };
    return wsp_ggml_new_tensor(ctx, type, 4, ne);
}

void * wsp_ggml_new_buffer(struct wsp_ggml_context * ctx, size_t nbytes) {
    struct wsp_ggml_object * obj = wsp_ggml_new_object(ctx, WSP_GGML_OBJECT_TYPE_WORK_BUFFER, nbytes);

    return (uint8_t *)ctx->mem_buffer + obj->offs;
}

struct wsp_ggml_tensor * wsp_ggml_dup_tensor(struct wsp_ggml_context * ctx, const struct wsp_ggml_tensor * src) {
    return wsp_ggml_new_tensor(ctx, src->type, WSP_GGML_MAX_DIMS, src->ne);
}

void wsp_ggml_unravel_index(const struct wsp_ggml_tensor * tensor, int64_t i, int64_t * i0, int64_t * i1, int64_t * i2, int64_t * i3) {
    const int64_t ne2 = tensor->ne[2];
    const int64_t ne1 = tensor->ne[1];
    const int64_t ne0 = tensor->ne[0];

    const int64_t i3_ = (i/(ne2*ne1*ne0));
    const int64_t i2_ = (i - i3_*ne2*ne1*ne0)/(ne1*ne0);
    const int64_t i1_ = (i - i3_*ne2*ne1*ne0 - i2_*ne1*ne0)/ne0;
    const int64_t i0_ = (i - i3_*ne2*ne1*ne0 - i2_*ne1*ne0 - i1_*ne0);

    if (i0) {
        * i0 = i0_;
    }
    if (i1) {
        * i1 = i1_;
    }
    if (i2) {
        * i2 = i2_;
    }
    if (i3) {
        * i3 = i3_;
    }
}

void * wsp_ggml_get_data(const struct wsp_ggml_tensor * tensor) {
    return tensor->data;
}

float * wsp_ggml_get_data_f32(const struct wsp_ggml_tensor * tensor) {
    assert(tensor->type == WSP_GGML_TYPE_F32);
    return (float *)(tensor->data);
}

enum wsp_ggml_unary_op wsp_ggml_get_unary_op(const struct wsp_ggml_tensor * tensor) {
    WSP_GGML_ASSERT(tensor->op == WSP_GGML_OP_UNARY);
    return (enum wsp_ggml_unary_op) wsp_ggml_get_op_params_i32(tensor, 0);
}

enum wsp_ggml_glu_op wsp_ggml_get_glu_op(const struct wsp_ggml_tensor * tensor) {
    WSP_GGML_ASSERT(tensor->op == WSP_GGML_OP_GLU);
    return (enum wsp_ggml_glu_op) wsp_ggml_get_op_params_i32(tensor, 0);
}

const char * wsp_ggml_get_name(const struct wsp_ggml_tensor * tensor) {
    return tensor->name;
}

struct wsp_ggml_tensor * wsp_ggml_set_name(struct wsp_ggml_tensor * tensor, const char * name) {
    size_t i;
    for (i = 0; i < sizeof(tensor->name) - 1 && name[i] != '\0'; i++) {
        tensor->name[i] = name[i];
    }
    tensor->name[i] = '\0';
    return tensor;
}

struct wsp_ggml_tensor * wsp_ggml_format_name(struct wsp_ggml_tensor * tensor, const char * fmt, ...) {
    va_list args;
    va_start(args, fmt);
    vsnprintf(tensor->name, sizeof(tensor->name), fmt, args);
    va_end(args);
    return tensor;
}

struct wsp_ggml_tensor * wsp_ggml_view_tensor(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * src) {
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_impl(ctx, src->type, WSP_GGML_MAX_DIMS, src->ne, src, 0);
    wsp_ggml_format_name(result, "%s (view)", src->name);

    for (int i = 0; i < WSP_GGML_MAX_DIMS; i++) {
        result->nb[i] = src->nb[i];
    }

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_get_first_tensor(const struct wsp_ggml_context * ctx) {
    struct wsp_ggml_object * obj = ctx->objects_begin;

    char * const mem_buffer = ctx->mem_buffer;

    while (obj != NULL) {
        if (obj->type == WSP_GGML_OBJECT_TYPE_TENSOR) {
            return (struct wsp_ggml_tensor *)(mem_buffer + obj->offs);
        }

        obj = obj->next;
    }

    return NULL;
}

struct wsp_ggml_tensor * wsp_ggml_get_next_tensor(const struct wsp_ggml_context * ctx, struct wsp_ggml_tensor * tensor) {
    struct wsp_ggml_object * obj = (struct wsp_ggml_object *) ((char *)tensor - WSP_GGML_OBJECT_SIZE);
    obj = obj->next;

    char * const mem_buffer = ctx->mem_buffer;

    while (obj != NULL) {
        if (obj->type == WSP_GGML_OBJECT_TYPE_TENSOR) {
            return (struct wsp_ggml_tensor *)(mem_buffer + obj->offs);
        }

        obj = obj->next;
    }

    return NULL;
}

struct wsp_ggml_tensor * wsp_ggml_get_tensor(struct wsp_ggml_context * ctx, const char * name) {
    struct wsp_ggml_object * obj = ctx->objects_begin;

    char * const mem_buffer = ctx->mem_buffer;

    while (obj != NULL) {
        if (obj->type == WSP_GGML_OBJECT_TYPE_TENSOR) {
            struct wsp_ggml_tensor * cur = (struct wsp_ggml_tensor *)(mem_buffer + obj->offs);
            if (strcmp(cur->name, name) == 0) {
                return cur;
            }
        }

        obj = obj->next;
    }

    return NULL;
}

////////////////////////////////////////////////////////////////////////////////

// wsp_ggml_dup

static struct wsp_ggml_tensor * wsp_ggml_dup_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        bool                  inplace) {
    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    result->op     = WSP_GGML_OP_DUP;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_dup(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_dup_impl(ctx, a, false);
}

struct wsp_ggml_tensor * wsp_ggml_dup_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_dup_impl(ctx, a, true);
}

// wsp_ggml_add

static struct wsp_ggml_tensor * wsp_ggml_add_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        bool                  inplace) {
    WSP_GGML_ASSERT(wsp_ggml_can_repeat(b, a));

    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    result->op     = WSP_GGML_OP_ADD;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_add(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_add_impl(ctx, a, b, false);
}

struct wsp_ggml_tensor * wsp_ggml_add_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_add_impl(ctx, a, b, true);
}

// wsp_ggml_add_cast

static struct wsp_ggml_tensor * wsp_ggml_add_cast_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        enum   wsp_ggml_type      type) {
    // TODO: support less-strict constraint
    //       WSP_GGML_ASSERT(wsp_ggml_can_repeat(b, a));
    WSP_GGML_ASSERT(wsp_ggml_can_repeat_rows(b, a));

    // currently only supported for quantized input and f16
    WSP_GGML_ASSERT(wsp_ggml_is_quantized(a->type) ||
                a->type == WSP_GGML_TYPE_F16 ||
                a->type == WSP_GGML_TYPE_BF16);

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, type, WSP_GGML_MAX_DIMS, a->ne);

    result->op     = WSP_GGML_OP_ADD;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_add_cast(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        enum   wsp_ggml_type      type) {
    return wsp_ggml_add_cast_impl(ctx, a, b, type);
}

struct wsp_ggml_tensor * wsp_ggml_add_id(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            struct wsp_ggml_tensor  * ids) {

    WSP_GGML_ASSERT(a->ne[0] == b->ne[0]);
    WSP_GGML_ASSERT(a->ne[1] == ids->ne[0]);
    WSP_GGML_ASSERT(a->ne[2] == ids->ne[1]);
    WSP_GGML_ASSERT(ids->type == WSP_GGML_TYPE_I32);

    struct wsp_ggml_tensor * result = wsp_ggml_dup_tensor(ctx, a);

    result->op     = WSP_GGML_OP_ADD_ID;
    result->src[0] = a;
    result->src[1] = b;
    result->src[2] = ids;

    return result;
}

// wsp_ggml_add1

static struct wsp_ggml_tensor * wsp_ggml_add1_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        bool                  inplace) {
    WSP_GGML_ASSERT(wsp_ggml_is_scalar(b));
    WSP_GGML_ASSERT(wsp_ggml_is_padded_1d(a));

    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    result->op     = WSP_GGML_OP_ADD1;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_add1(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_add1_impl(ctx, a, b, false);
}

struct wsp_ggml_tensor * wsp_ggml_add1_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_add1_impl(ctx, a, b, true);
}

// wsp_ggml_acc

static struct wsp_ggml_tensor * wsp_ggml_acc_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        size_t                nb1,
        size_t                nb2,
        size_t                nb3,
        size_t                offset,
        bool                  inplace) {
    WSP_GGML_ASSERT(wsp_ggml_nelements(b) <= wsp_ggml_nelements(a));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(a));
    WSP_GGML_ASSERT(a->type == WSP_GGML_TYPE_F32);
    WSP_GGML_ASSERT(b->type == WSP_GGML_TYPE_F32);

    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    int32_t params[] = { nb1, nb2, nb3, offset, inplace ? 1 : 0 };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_ACC;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_acc(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        size_t                nb1,
        size_t                nb2,
        size_t                nb3,
        size_t                offset) {
    return wsp_ggml_acc_impl(ctx, a, b, nb1, nb2, nb3, offset, false);
}

struct wsp_ggml_tensor * wsp_ggml_acc_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        size_t                nb1,
        size_t                nb2,
        size_t                nb3,
        size_t                offset) {
    return wsp_ggml_acc_impl(ctx, a, b, nb1, nb2, nb3, offset, true);
}

// wsp_ggml_sub

static struct wsp_ggml_tensor * wsp_ggml_sub_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        bool                  inplace) {
    WSP_GGML_ASSERT(wsp_ggml_can_repeat(b, a));

    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    result->op     = WSP_GGML_OP_SUB;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_sub(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_sub_impl(ctx, a, b, false);
}

struct wsp_ggml_tensor * wsp_ggml_sub_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_sub_impl(ctx, a, b, true);
}

// wsp_ggml_mul

static struct wsp_ggml_tensor * wsp_ggml_mul_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        bool                  inplace) {
    WSP_GGML_ASSERT(wsp_ggml_can_repeat(b, a));

    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    result->op     = WSP_GGML_OP_MUL;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_mul(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_mul_impl(ctx, a, b, false);
}

struct wsp_ggml_tensor * wsp_ggml_mul_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_mul_impl(ctx, a, b, true);
}

// wsp_ggml_div

static struct wsp_ggml_tensor * wsp_ggml_div_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        bool                  inplace) {
    WSP_GGML_ASSERT(wsp_ggml_can_repeat(b, a));

    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    result->op     = WSP_GGML_OP_DIV;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_div(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_div_impl(ctx, a, b, false);
}

struct wsp_ggml_tensor * wsp_ggml_div_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_div_impl(ctx, a, b, true);
}

// wsp_ggml_sqr

static struct wsp_ggml_tensor * wsp_ggml_sqr_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        bool                  inplace) {
    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    result->op     = WSP_GGML_OP_SQR;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_sqr(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_sqr_impl(ctx, a, false);
}

struct wsp_ggml_tensor * wsp_ggml_sqr_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_sqr_impl(ctx, a, true);
}

// wsp_ggml_sqrt

static struct wsp_ggml_tensor * wsp_ggml_sqrt_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        bool                  inplace) {
    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    result->op     = WSP_GGML_OP_SQRT;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_sqrt(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_sqrt_impl(ctx, a, false);
}

struct wsp_ggml_tensor * wsp_ggml_sqrt_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_sqrt_impl(ctx, a, true);
}

// wsp_ggml_log

static struct wsp_ggml_tensor * wsp_ggml_log_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        bool                  inplace) {
    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    result->op     = WSP_GGML_OP_LOG;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_log(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_log_impl(ctx, a, false);
}

struct wsp_ggml_tensor * wsp_ggml_log_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_log_impl(ctx, a, true);
}

struct wsp_ggml_tensor * wsp_ggml_expm1(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_EXPM1);
}

struct wsp_ggml_tensor * wsp_ggml_expm1_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_EXPM1);
}

struct wsp_ggml_tensor * wsp_ggml_softplus(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_SOFTPLUS);
}

struct wsp_ggml_tensor * wsp_ggml_softplus_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_SOFTPLUS);
}

// wsp_ggml_sin

static struct wsp_ggml_tensor * wsp_ggml_sin_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        bool                  inplace) {
    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    result->op     = WSP_GGML_OP_SIN;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_sin(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_sin_impl(ctx, a, false);
}

struct wsp_ggml_tensor * wsp_ggml_sin_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_sin_impl(ctx, a, true);
}

// wsp_ggml_cos

static struct wsp_ggml_tensor * wsp_ggml_cos_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        bool                  inplace) {
    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    result->op     = WSP_GGML_OP_COS;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_cos(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_cos_impl(ctx, a, false);
}

struct wsp_ggml_tensor * wsp_ggml_cos_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_cos_impl(ctx, a, true);
}

// wsp_ggml_sum

struct wsp_ggml_tensor * wsp_ggml_sum(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_1d(ctx, a->type, 1);

    result->op     = WSP_GGML_OP_SUM;
    result->src[0] = a;

    return result;
}

// wsp_ggml_sum_rows

struct wsp_ggml_tensor * wsp_ggml_sum_rows(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    int64_t ne[WSP_GGML_MAX_DIMS] = { 1 };
    for (int i = 1; i < WSP_GGML_MAX_DIMS; ++i) {
        ne[i] = a->ne[i];
    }

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, a->type, WSP_GGML_MAX_DIMS, ne);

    result->op     = WSP_GGML_OP_SUM_ROWS;
    result->src[0] = a;

    return result;
}

// wsp_ggml_cumsum

struct wsp_ggml_tensor * wsp_ggml_cumsum(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    WSP_GGML_ASSERT(a->type == WSP_GGML_TYPE_F32);

    struct wsp_ggml_tensor * result = wsp_ggml_dup_tensor(ctx, a);

    result->op     = WSP_GGML_OP_CUMSUM;
    result->src[0] = a;

    return result;
}

// wsp_ggml_mean

struct wsp_ggml_tensor * wsp_ggml_mean(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    int64_t ne[4] = { 1, a->ne[1], a->ne[2], a->ne[3] };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 4, ne);

    result->op     = WSP_GGML_OP_MEAN;
    result->src[0] = a;

    return result;
}

// wsp_ggml_argmax

struct wsp_ggml_tensor * wsp_ggml_argmax(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    WSP_GGML_ASSERT(wsp_ggml_is_matrix(a));
    WSP_GGML_ASSERT(a->ne[0] <= INT32_MAX);

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_1d(ctx, WSP_GGML_TYPE_I32, a->ne[1]);

    result->op     = WSP_GGML_OP_ARGMAX;
    result->src[0] = a;

    return result;
}

// wsp_ggml_count_equal

struct wsp_ggml_tensor * wsp_ggml_count_equal(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    WSP_GGML_ASSERT(wsp_ggml_are_same_shape(a, b));

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_1d(ctx, WSP_GGML_TYPE_I64, 1);

    result->op     = WSP_GGML_OP_COUNT_EQUAL;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

// wsp_ggml_repeat

struct wsp_ggml_tensor * wsp_ggml_repeat(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    WSP_GGML_ASSERT(wsp_ggml_can_repeat(a, b));

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, a->type, WSP_GGML_MAX_DIMS, b->ne);

    result->op     = WSP_GGML_OP_REPEAT;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_repeat_4d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor * a,
        int64_t ne0, int64_t ne1, int64_t ne2, int64_t ne3) {
    const bool can_repeat = wsp_ggml_is_empty(a) || (
        (ne0 % a->ne[0] == 0) &&
        (ne1 % a->ne[1] == 0) &&
        (ne2 % a->ne[2] == 0) &&
        (ne3 % a->ne[3] == 0)
    );
    WSP_GGML_ASSERT(can_repeat);

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_4d(ctx, a->type, ne0, ne1, ne2, ne3);

    result->op     = WSP_GGML_OP_REPEAT;
    result->src[0] = a;

    return result;
}

// wsp_ggml_repeat_back

struct wsp_ggml_tensor * wsp_ggml_repeat_back(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    WSP_GGML_ASSERT(wsp_ggml_can_repeat(b, a));

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, a->type, WSP_GGML_MAX_DIMS, b->ne);

    result->op     = WSP_GGML_OP_REPEAT_BACK;
    result->src[0] = a;

    return result;
}

// wsp_ggml_concat

struct wsp_ggml_tensor * wsp_ggml_concat(
    struct wsp_ggml_context * ctx,
    struct wsp_ggml_tensor  * a,
    struct wsp_ggml_tensor  * b,
    int                   dim) {
    WSP_GGML_ASSERT(dim >= 0 && dim < WSP_GGML_MAX_DIMS);
    WSP_GGML_ASSERT(a->type == b->type);

    int64_t ne[WSP_GGML_MAX_DIMS];
    for (int d = 0; d < WSP_GGML_MAX_DIMS; ++d) {
        if (d == dim) {
            ne[d] = a->ne[d] + b->ne[d];
            continue;
        }
        WSP_GGML_ASSERT(a->ne[d] == b->ne[d]);
        ne[d] = a->ne[d];
    }

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, a->type, WSP_GGML_MAX_DIMS, ne);

    wsp_ggml_set_op_params_i32(result, 0, dim);

    result->op     = WSP_GGML_OP_CONCAT;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

// wsp_ggml_abs

struct wsp_ggml_tensor * wsp_ggml_abs(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_ABS);
}

struct wsp_ggml_tensor * wsp_ggml_abs_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_ABS);
}

// wsp_ggml_sgn

struct wsp_ggml_tensor * wsp_ggml_sgn(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_SGN);
}

struct wsp_ggml_tensor * wsp_ggml_sgn_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_SGN);
}

// wsp_ggml_neg

struct wsp_ggml_tensor * wsp_ggml_neg(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_NEG);
}

struct wsp_ggml_tensor * wsp_ggml_neg_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_NEG);
}

// wsp_ggml_step

struct wsp_ggml_tensor * wsp_ggml_step(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_STEP);
}

struct wsp_ggml_tensor * wsp_ggml_step_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_STEP);
}

// wsp_ggml_tanh

struct wsp_ggml_tensor * wsp_ggml_tanh(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_TANH);
}

struct wsp_ggml_tensor * wsp_ggml_tanh_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_TANH);
}

// wsp_ggml_elu

struct wsp_ggml_tensor * wsp_ggml_elu(
    struct wsp_ggml_context * ctx,
    struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_ELU);
}

struct wsp_ggml_tensor * wsp_ggml_elu_inplace(
    struct wsp_ggml_context * ctx,
    struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_ELU);
}

// wsp_ggml_relu

struct wsp_ggml_tensor * wsp_ggml_relu(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_RELU);
}

struct wsp_ggml_tensor * wsp_ggml_relu_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_RELU);
}

// wsp_ggml_leaky_relu

struct wsp_ggml_tensor * wsp_ggml_leaky_relu(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 negative_slope,
        bool                  inplace) {
    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    wsp_ggml_set_op_params(result, &negative_slope, sizeof(negative_slope));

    result->op     = WSP_GGML_OP_LEAKY_RELU;
    result->src[0] = a;

    return result;
}

// wsp_ggml_sigmoid

struct wsp_ggml_tensor * wsp_ggml_sigmoid(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_SIGMOID);
}

struct wsp_ggml_tensor * wsp_ggml_sigmoid_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_SIGMOID);
}

// wsp_ggml_gelu

struct wsp_ggml_tensor * wsp_ggml_gelu(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_GELU);
}

struct wsp_ggml_tensor * wsp_ggml_gelu_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_GELU);
}

// wsp_ggml_gelu_erf

struct wsp_ggml_tensor * wsp_ggml_gelu_erf(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_GELU_ERF);
}

struct wsp_ggml_tensor * wsp_ggml_gelu_erf_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_GELU_ERF);
}

// wsp_ggml_gelu_quick

struct wsp_ggml_tensor * wsp_ggml_gelu_quick(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_GELU_QUICK);
}

struct wsp_ggml_tensor * wsp_ggml_gelu_quick_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_GELU_QUICK);
}

// wsp_ggml_silu

struct wsp_ggml_tensor * wsp_ggml_silu(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_SILU);
}

struct wsp_ggml_tensor * wsp_ggml_silu_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_SILU);
}

// wsp_ggml_xielu

struct wsp_ggml_tensor * wsp_ggml_xielu(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float alpha_n,
        float alpha_p,
        float beta,
        float eps) {
    struct wsp_ggml_tensor * result = wsp_ggml_dup_tensor(ctx, a);

    wsp_ggml_set_op_params_i32(result, 0, (int32_t) WSP_GGML_UNARY_OP_XIELU);
    wsp_ggml_set_op_params_f32(result, 1, beta + wsp_ggml_compute_softplus_f32(alpha_n));
    wsp_ggml_set_op_params_f32(result, 2, wsp_ggml_compute_softplus_f32(alpha_p));
    wsp_ggml_set_op_params_f32(result, 3, beta);
    wsp_ggml_set_op_params_f32(result, 4, eps);

    result->op     = WSP_GGML_OP_UNARY;
    result->src[0] = a;

    return result;
}

// wsp_ggml_silu_back

struct wsp_ggml_tensor * wsp_ggml_silu_back(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    struct wsp_ggml_tensor * result = wsp_ggml_dup_tensor(ctx, a);

    result->op     = WSP_GGML_OP_SILU_BACK;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

// ggml hardswish

struct wsp_ggml_tensor * wsp_ggml_hardswish(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_HARDSWISH);
}

// ggml hardsigmoid

struct wsp_ggml_tensor * wsp_ggml_hardsigmoid(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_HARDSIGMOID);
}

// ggml exp

struct wsp_ggml_tensor * wsp_ggml_exp(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_EXP);
}

struct wsp_ggml_tensor * wsp_ggml_exp_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_EXP);
}

// wsp_ggml_glu

static struct wsp_ggml_tensor * wsp_ggml_glu_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        enum wsp_ggml_glu_op      op,
        bool                  swapped) {
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous_1(a));

    if (b) {
        WSP_GGML_ASSERT(wsp_ggml_is_contiguous_1(b));
        WSP_GGML_ASSERT(wsp_ggml_are_same_shape(a, b));
        WSP_GGML_ASSERT(a->type == b->type);
    }

    int64_t ne[WSP_GGML_MAX_DIMS] = { a->ne[0] / 2 }; for (int i = 1; i < WSP_GGML_MAX_DIMS; i++) ne[i] = a->ne[i];
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_impl(ctx, a->type, WSP_GGML_MAX_DIMS, b ? a->ne : ne, NULL, 0);

    wsp_ggml_set_op_params_i32(result, 0, (int32_t) op);
    wsp_ggml_set_op_params_i32(result, 1, (int32_t) swapped);

    result->op     = WSP_GGML_OP_GLU;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

// wsp_ggml_floor

struct wsp_ggml_tensor * wsp_ggml_floor(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_FLOOR);
}

struct wsp_ggml_tensor * wsp_ggml_floor_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_FLOOR);
}

// wsp_ggml_ceil

struct wsp_ggml_tensor * wsp_ggml_ceil(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_CEIL);
}

struct wsp_ggml_tensor * wsp_ggml_ceil_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_CEIL);
}

//wsp_ggml_round

struct wsp_ggml_tensor * wsp_ggml_round(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_ROUND);
}

struct wsp_ggml_tensor * wsp_ggml_round_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_ROUND);
}

//wsp_ggml_trunc

struct wsp_ggml_tensor * wsp_ggml_trunc(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary(ctx, a, WSP_GGML_UNARY_OP_TRUNC);
}

struct wsp_ggml_tensor * wsp_ggml_trunc_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_unary_inplace(ctx, a, WSP_GGML_UNARY_OP_TRUNC);
}

struct wsp_ggml_tensor * wsp_ggml_glu(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        enum wsp_ggml_glu_op      op,
        bool                  swapped) {
    return wsp_ggml_glu_impl(ctx, a, NULL, op, swapped);
}

struct wsp_ggml_tensor * wsp_ggml_glu_split(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        enum wsp_ggml_glu_op      op) {
    return wsp_ggml_glu_impl(ctx, a, b, op, false);
}

// wsp_ggml_reglu

struct wsp_ggml_tensor * wsp_ggml_reglu(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_glu_impl(ctx, a, NULL, WSP_GGML_GLU_OP_REGLU, false);
}

struct wsp_ggml_tensor * wsp_ggml_reglu_swapped(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_glu_impl(ctx, a, NULL, WSP_GGML_GLU_OP_REGLU, true);
}

struct wsp_ggml_tensor * wsp_ggml_reglu_split(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_glu_impl(ctx, a, b, WSP_GGML_GLU_OP_REGLU, false);
}

// wsp_ggml_geglu

struct wsp_ggml_tensor * wsp_ggml_geglu(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_glu_impl(ctx, a, NULL, WSP_GGML_GLU_OP_GEGLU, false);
}

struct wsp_ggml_tensor * wsp_ggml_geglu_swapped(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_glu_impl(ctx, a, NULL, WSP_GGML_GLU_OP_GEGLU, true);
}

struct wsp_ggml_tensor * wsp_ggml_geglu_split(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_glu_impl(ctx, a, b, WSP_GGML_GLU_OP_GEGLU, false);
}

// wsp_ggml_swiglu

struct wsp_ggml_tensor * wsp_ggml_swiglu(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_glu_impl(ctx, a, NULL, WSP_GGML_GLU_OP_SWIGLU, false);
}

struct wsp_ggml_tensor * wsp_ggml_swiglu_swapped(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_glu_impl(ctx, a, NULL, WSP_GGML_GLU_OP_SWIGLU, true);
}

struct wsp_ggml_tensor * wsp_ggml_swiglu_split(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_glu_impl(ctx, a, b, WSP_GGML_GLU_OP_SWIGLU, false);
}

// wsp_ggml_geglu_erf

struct wsp_ggml_tensor * wsp_ggml_geglu_erf(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_glu_impl(ctx, a, NULL, WSP_GGML_GLU_OP_GEGLU_ERF, false);
}

struct wsp_ggml_tensor * wsp_ggml_geglu_erf_swapped(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_glu_impl(ctx, a, NULL, WSP_GGML_GLU_OP_GEGLU_ERF, true);
}

struct wsp_ggml_tensor * wsp_ggml_geglu_erf_split(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_glu_impl(ctx, a, b, WSP_GGML_GLU_OP_GEGLU_ERF, false);
}

// wsp_ggml_geglu_quick

struct wsp_ggml_tensor * wsp_ggml_geglu_quick(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_glu_impl(ctx, a, NULL, WSP_GGML_GLU_OP_GEGLU_QUICK, false);
}

struct wsp_ggml_tensor * wsp_ggml_geglu_quick_swapped(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_glu_impl(ctx, a, NULL, WSP_GGML_GLU_OP_GEGLU_QUICK, true);
}

struct wsp_ggml_tensor * wsp_ggml_geglu_quick_split(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_glu_impl(ctx, a, b, WSP_GGML_GLU_OP_GEGLU_QUICK, false);
}

struct wsp_ggml_tensor * wsp_ggml_swiglu_oai(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        float                 alpha,
        float                 limit) {
    struct wsp_ggml_tensor * result = wsp_ggml_glu_impl(ctx, a, b, WSP_GGML_GLU_OP_SWIGLU_OAI, false);
    wsp_ggml_set_op_params_f32(result, 2, alpha);
    wsp_ggml_set_op_params_f32(result, 3, limit);

    return result;
}

// wsp_ggml_norm

static struct wsp_ggml_tensor * wsp_ggml_norm_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 eps,
        bool                  inplace) {
    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    wsp_ggml_set_op_params(result, &eps, sizeof(eps));

    result->op     = WSP_GGML_OP_NORM;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_norm(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 eps) {
    return wsp_ggml_norm_impl(ctx, a, eps, false);
}

struct wsp_ggml_tensor * wsp_ggml_norm_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 eps) {
    return wsp_ggml_norm_impl(ctx, a, eps, true);
}

// wsp_ggml_rms_norm

static struct wsp_ggml_tensor * wsp_ggml_rms_norm_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 eps,
        bool                  inplace) {
    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    wsp_ggml_set_op_params(result, &eps, sizeof(eps));

    result->op     = WSP_GGML_OP_RMS_NORM;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_rms_norm(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 eps) {
    return wsp_ggml_rms_norm_impl(ctx, a, eps, false);
}

struct wsp_ggml_tensor * wsp_ggml_rms_norm_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 eps) {
    return wsp_ggml_rms_norm_impl(ctx, a, eps, true);
}

// wsp_ggml_rms_norm_back

struct wsp_ggml_tensor * wsp_ggml_rms_norm_back(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        float                 eps) {
    struct wsp_ggml_tensor * result = wsp_ggml_dup_tensor(ctx, a);

    wsp_ggml_set_op_params(result, &eps, sizeof(eps));

    result->op     = WSP_GGML_OP_RMS_NORM_BACK;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

// wsp_ggml_group_norm

static struct wsp_ggml_tensor * wsp_ggml_group_norm_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   n_groups,
        float                 eps,
        bool                  inplace) {
    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    wsp_ggml_set_op_params_i32(result, 0, n_groups);
    wsp_ggml_set_op_params_f32(result, 1, eps);

    result->op     = WSP_GGML_OP_GROUP_NORM;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_group_norm(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   n_groups,
        float                 eps) {
    return wsp_ggml_group_norm_impl(ctx, a, n_groups, eps, false);
}

struct wsp_ggml_tensor * wsp_ggml_group_norm_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   n_groups,
        float                 eps) {
    return wsp_ggml_group_norm_impl(ctx, a, n_groups, eps, true);
}

// wsp_ggml_l2_norm

static struct wsp_ggml_tensor * wsp_ggml_l2_norm_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 eps,
        bool                  inplace) {
    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    wsp_ggml_set_op_params_f32(result, 0, eps);

    result->op     = WSP_GGML_OP_L2_NORM;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_l2_norm(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 eps) {
    return wsp_ggml_l2_norm_impl(ctx, a, eps, false);
}

struct wsp_ggml_tensor * wsp_ggml_l2_norm_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 eps) {
    return wsp_ggml_l2_norm_impl(ctx, a, eps, true);
}

// wsp_ggml_mul_mat

static inline bool wsp_ggml_can_mul_mat(const struct wsp_ggml_tensor * t0, const struct wsp_ggml_tensor * t1) {
    static_assert(WSP_GGML_MAX_DIMS == 4, "WSP_GGML_MAX_DIMS is not 4 - update this function");

    return (t0->ne[0]           == t1->ne[0])  &&
           (t1->ne[2]%t0->ne[2] == 0)          && // verify t0 is broadcastable
           (t1->ne[3]%t0->ne[3] == 0);
}

struct wsp_ggml_tensor * wsp_ggml_mul_mat(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    WSP_GGML_ASSERT(wsp_ggml_can_mul_mat(a, b));
    WSP_GGML_ASSERT(!wsp_ggml_is_transposed(a));

    const int64_t ne[4] = { a->ne[1], b->ne[1], b->ne[2], b->ne[3] };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 4, ne);

    result->op     = WSP_GGML_OP_MUL_MAT;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

void wsp_ggml_mul_mat_set_prec(
        struct wsp_ggml_tensor * a,
        enum wsp_ggml_prec       prec) {
    WSP_GGML_ASSERT(a->op == WSP_GGML_OP_MUL_MAT);

    const int32_t prec_i32 = (int32_t) prec;

    wsp_ggml_set_op_params_i32(a, 0, prec_i32);
}

// wsp_ggml_mul_mat_id

/*
    c = wsp_ggml_mul_mat_id(ctx, as, b, ids);

    as  -> [cols, rows, n_expert]
    b   -> [cols, n_expert_used, n_tokens]
    ids -> [n_expert_used, n_tokens] (i32)
    c   -> [rows, n_expert_used, n_tokens]

    in b, n_expert_used can be broadcasted to match the n_expert_used of ids

    c ~= as[:,:,i] @ b[:,i%r,t], i = ids[e,t] for all e,t in ids
*/
struct wsp_ggml_tensor * wsp_ggml_mul_mat_id(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * as,
        struct wsp_ggml_tensor  * b,
        struct wsp_ggml_tensor  * ids) {
    WSP_GGML_ASSERT(!wsp_ggml_is_transposed(as));
    WSP_GGML_ASSERT(ids->type == WSP_GGML_TYPE_I32);

    WSP_GGML_ASSERT(as->ne[3] == 1); // as is 3d (one matrix per expert)
    WSP_GGML_ASSERT(b->ne[3] == 1); // b is 3d
    WSP_GGML_ASSERT(ids->ne[2] == 1 && ids->ne[3] == 1); // ids is 2d
    WSP_GGML_ASSERT(ids->ne[1] == b->ne[2]); // must have an expert list per b row
    WSP_GGML_ASSERT(as->ne[0] == b->ne[0]); // can_mul_mat
    WSP_GGML_ASSERT(ids->ne[0] % b->ne[1] == 0); // can broadcast

    const int64_t ne[4] = { as->ne[1], ids->ne[0], b->ne[2], 1 };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 4, ne);

    result->op     = WSP_GGML_OP_MUL_MAT_ID;
    result->src[0] = as;
    result->src[1] = b;
    result->src[2] = ids;

    return result;
}

// wsp_ggml_out_prod

static inline bool wsp_ggml_can_out_prod(const struct wsp_ggml_tensor * t0, const struct wsp_ggml_tensor * t1) {
    static_assert(WSP_GGML_MAX_DIMS == 4, "WSP_GGML_MAX_DIMS is not 4 - update this function");

    return (t0->ne[1] == t1->ne[1])   &&
           (t1->ne[2]%t0->ne[2] == 0) && // verify t0 is broadcastable
           (t1->ne[3]%t0->ne[3] == 0);
}

struct wsp_ggml_tensor * wsp_ggml_out_prod(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    WSP_GGML_ASSERT(wsp_ggml_can_out_prod(a, b));
    WSP_GGML_ASSERT(!wsp_ggml_is_transposed(a));

    // a is broadcastable to b for ne[2] and ne[3] -> use b->ne[2] and b->ne[3]
    const int64_t ne[4] = { a->ne[0], b->ne[0], b->ne[2], b->ne[3] };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 4, ne);

    result->op     = WSP_GGML_OP_OUT_PROD;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

// wsp_ggml_scale

static struct wsp_ggml_tensor * wsp_ggml_scale_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 s,
        float                 b,
        bool                  inplace) {
    WSP_GGML_ASSERT(wsp_ggml_is_padded_1d(a));

    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    float params[2] = { s, b };
    wsp_ggml_set_op_params(result, &params, sizeof(params));

    result->op     = WSP_GGML_OP_SCALE;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_scale(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 s) {
    return wsp_ggml_scale_impl(ctx, a, s, 0.0, false);
}

struct wsp_ggml_tensor * wsp_ggml_scale_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 s) {
    return wsp_ggml_scale_impl(ctx, a, s, 0.0, true);
}

struct wsp_ggml_tensor * wsp_ggml_scale_bias(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 s,
        float                 b) {
    return wsp_ggml_scale_impl(ctx, a, s, b, false);
}

struct wsp_ggml_tensor * wsp_ggml_scale_bias_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 s,
        float                 b) {
    return wsp_ggml_scale_impl(ctx, a, s, b, true);
}

// wsp_ggml_set

static struct wsp_ggml_tensor * wsp_ggml_set_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        size_t                nb1,
        size_t                nb2,
        size_t                nb3,
        size_t                offset,
        bool                  inplace) {
    WSP_GGML_ASSERT(wsp_ggml_nelements(a) >= wsp_ggml_nelements(b));

    // make a view of the destination
    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    WSP_GGML_ASSERT(offset < (size_t)(1 << 30));
    int32_t params[] = { nb1, nb2, nb3, offset, inplace ? 1 : 0 };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_SET;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_set(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        size_t                nb1,
        size_t                nb2,
        size_t                nb3,
        size_t                offset) {
    return wsp_ggml_set_impl(ctx, a, b, nb1, nb2, nb3, offset, false);
}

struct wsp_ggml_tensor * wsp_ggml_set_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        size_t                nb1,
        size_t                nb2,
        size_t                nb3,
        size_t                offset) {
    return wsp_ggml_set_impl(ctx, a, b, nb1, nb2, nb3, offset, true);
}

struct wsp_ggml_tensor * wsp_ggml_set_1d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        size_t                offset) {
    return wsp_ggml_set_impl(ctx, a, b, a->nb[1], a->nb[2], a->nb[3], offset, false);
}

struct wsp_ggml_tensor * wsp_ggml_set_1d_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        size_t                offset) {
    return wsp_ggml_set_impl(ctx, a, b, a->nb[1], a->nb[2], a->nb[3], offset, true);
}

struct wsp_ggml_tensor * wsp_ggml_set_2d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        size_t                nb1,
        size_t                offset) {
    return wsp_ggml_set_impl(ctx, a, b, nb1, a->nb[2], a->nb[3], offset, false);
}

struct wsp_ggml_tensor * wsp_ggml_set_2d_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        size_t                nb1,
        size_t                offset) {
    return wsp_ggml_set_impl(ctx, a, b, nb1, a->nb[2], a->nb[3], offset, true);
}

// wsp_ggml_cpy

static struct wsp_ggml_tensor * wsp_ggml_cpy_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    WSP_GGML_ASSERT(wsp_ggml_nelements(a) == wsp_ggml_nelements(b));

    // make a view of the destination
    struct wsp_ggml_tensor * result = wsp_ggml_view_tensor(ctx, b);
    if (strlen(b->name) > 0) {
        wsp_ggml_format_name(result, "%s (copy of %s)", b->name, a->name);
    } else {
        wsp_ggml_format_name(result, "%s (copy)", a->name);
    }

    result->op     = WSP_GGML_OP_CPY;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_cpy(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor * a,
        struct wsp_ggml_tensor * b) {
    return wsp_ggml_cpy_impl(ctx, a, b);
}

struct wsp_ggml_tensor * wsp_ggml_cast(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        enum   wsp_ggml_type      type) {
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, type, WSP_GGML_MAX_DIMS, a->ne);
    wsp_ggml_format_name(result, "%s (copy)", a->name);

    result->op     = WSP_GGML_OP_CPY;
    result->src[0] = a;
    result->src[1] = result;

    return result;
}

// wsp_ggml_cont

static struct wsp_ggml_tensor * wsp_ggml_cont_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    struct wsp_ggml_tensor * result = wsp_ggml_dup_tensor(ctx, a);
    wsp_ggml_format_name(result, "%s (cont)", a->name);

    result->op     = WSP_GGML_OP_CONT;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_cont(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor * a) {
    return wsp_ggml_cont_impl(ctx, a);
}

// make contiguous, with new shape
WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_cont_1d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int64_t               ne0) {
    return wsp_ggml_cont_4d(ctx, a, ne0, 1, 1, 1);
}

WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_cont_2d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int64_t               ne0,
        int64_t               ne1) {
    return wsp_ggml_cont_4d(ctx, a, ne0, ne1, 1, 1);
}

WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_cont_3d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int64_t               ne0,
        int64_t               ne1,
        int64_t               ne2) {
    return wsp_ggml_cont_4d(ctx, a, ne0, ne1, ne2, 1);
}

struct wsp_ggml_tensor * wsp_ggml_cont_4d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int64_t               ne0,
        int64_t               ne1,
        int64_t               ne2,
        int64_t               ne3) {
    WSP_GGML_ASSERT(wsp_ggml_nelements(a) == (ne0*ne1*ne2*ne3));

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_4d(ctx, a->type, ne0, ne1, ne2, ne3);
    wsp_ggml_format_name(result, "%s (cont)", a->name);

    result->op     = WSP_GGML_OP_CONT;
    result->src[0] = a;

    return result;
}

// wsp_ggml_reshape

struct wsp_ggml_tensor * wsp_ggml_reshape(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor * a,
        struct wsp_ggml_tensor * b) {
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(a));
    // as only the shape of b is relevant, and not its memory layout, b is allowed to be non contiguous.
    WSP_GGML_ASSERT(wsp_ggml_nelements(a) == wsp_ggml_nelements(b));

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_impl(ctx, a->type, WSP_GGML_MAX_DIMS, b->ne, a, 0);
    wsp_ggml_format_name(result, "%s (reshaped)", a->name);

    result->op     = WSP_GGML_OP_RESHAPE;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_reshape_1d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int64_t               ne0) {
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(a));
    WSP_GGML_ASSERT(wsp_ggml_nelements(a) == ne0);

    const int64_t ne[1] = { ne0 };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_impl(ctx, a->type, 1, ne, a, 0);
    wsp_ggml_format_name(result, "%s (reshaped)", a->name);

    result->op     = WSP_GGML_OP_RESHAPE;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_reshape_2d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int64_t               ne0,
        int64_t               ne1) {
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(a));
    WSP_GGML_ASSERT(wsp_ggml_nelements(a) == ne0*ne1);

    const int64_t ne[2] = { ne0, ne1 };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_impl(ctx, a->type, 2, ne, a, 0);
    wsp_ggml_format_name(result, "%s (reshaped)", a->name);

    result->op     = WSP_GGML_OP_RESHAPE;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_reshape_3d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int64_t               ne0,
        int64_t               ne1,
        int64_t               ne2) {
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(a));
    WSP_GGML_ASSERT(wsp_ggml_nelements(a) == ne0*ne1*ne2);

    const int64_t ne[3] = { ne0, ne1, ne2 };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_impl(ctx, a->type, 3, ne, a, 0);
    wsp_ggml_format_name(result, "%s (reshaped)", a->name);

    result->op     = WSP_GGML_OP_RESHAPE;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_reshape_4d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int64_t               ne0,
        int64_t               ne1,
        int64_t               ne2,
        int64_t               ne3) {
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(a));
    WSP_GGML_ASSERT(wsp_ggml_nelements(a) == ne0*ne1*ne2*ne3);

    const int64_t ne[4] = { ne0, ne1, ne2, ne3 };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_impl(ctx, a->type, 4, ne, a, 0);
    wsp_ggml_format_name(result, "%s (reshaped)", a->name);

    result->op     = WSP_GGML_OP_RESHAPE;
    result->src[0] = a;

    return result;
}

static struct wsp_ggml_tensor * wsp_ggml_view_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   n_dims,
        const int64_t       * ne,
        size_t                offset) {
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_impl(ctx, a->type, n_dims, ne, a, offset);
    wsp_ggml_format_name(result, "%s (view)", a->name);

    wsp_ggml_set_op_params(result, &offset, sizeof(offset));

    result->op     = WSP_GGML_OP_VIEW;
    result->src[0] = a;

    return result;
}

// wsp_ggml_view_1d

struct wsp_ggml_tensor * wsp_ggml_view_1d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int64_t               ne0,
        size_t                offset) {
    struct wsp_ggml_tensor * result = wsp_ggml_view_impl(ctx, a, 1, &ne0, offset);

    return result;
}

// wsp_ggml_view_2d

struct wsp_ggml_tensor * wsp_ggml_view_2d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int64_t               ne0,
        int64_t               ne1,
        size_t                nb1,
        size_t                offset) {
    const int64_t ne[2] = { ne0, ne1 };

    struct wsp_ggml_tensor * result = wsp_ggml_view_impl(ctx, a, 2, ne, offset);

    result->nb[1] = nb1;
    result->nb[2] = result->nb[1]*ne1;
    result->nb[3] = result->nb[2];

    return result;
}

// wsp_ggml_view_3d

struct wsp_ggml_tensor * wsp_ggml_view_3d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int64_t               ne0,
        int64_t               ne1,
        int64_t               ne2,
        size_t                nb1,
        size_t                nb2,
        size_t                offset) {
    const int64_t ne[3] = { ne0, ne1, ne2 };

    struct wsp_ggml_tensor * result = wsp_ggml_view_impl(ctx, a, 3, ne, offset);

    result->nb[1] = nb1;
    result->nb[2] = nb2;
    result->nb[3] = result->nb[2]*ne2;

    return result;
}

// wsp_ggml_view_4d

struct wsp_ggml_tensor * wsp_ggml_view_4d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int64_t               ne0,
        int64_t               ne1,
        int64_t               ne2,
        int64_t               ne3,
        size_t                nb1,
        size_t                nb2,
        size_t                nb3,
        size_t                offset) {
    const int64_t ne[4] = { ne0, ne1, ne2, ne3 };

    struct wsp_ggml_tensor * result = wsp_ggml_view_impl(ctx, a, 4, ne, offset);

    result->nb[1] = nb1;
    result->nb[2] = nb2;
    result->nb[3] = nb3;

    return result;
}

// wsp_ggml_permute

struct wsp_ggml_tensor * wsp_ggml_permute(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   axis0,
        int                   axis1,
        int                   axis2,
        int                   axis3) {
    WSP_GGML_ASSERT(axis0 >= 0 && axis0 < WSP_GGML_MAX_DIMS);
    WSP_GGML_ASSERT(axis1 >= 0 && axis1 < WSP_GGML_MAX_DIMS);
    WSP_GGML_ASSERT(axis2 >= 0 && axis2 < WSP_GGML_MAX_DIMS);
    WSP_GGML_ASSERT(axis3 >= 0 && axis3 < WSP_GGML_MAX_DIMS);

    WSP_GGML_ASSERT(axis0 != axis1);
    WSP_GGML_ASSERT(axis0 != axis2);
    WSP_GGML_ASSERT(axis0 != axis3);
    WSP_GGML_ASSERT(axis1 != axis2);
    WSP_GGML_ASSERT(axis1 != axis3);
    WSP_GGML_ASSERT(axis2 != axis3);

    struct wsp_ggml_tensor * result = wsp_ggml_view_tensor(ctx, a);
    wsp_ggml_format_name(result, "%s (permuted)", a->name);

    int ne[WSP_GGML_MAX_DIMS];
    int nb[WSP_GGML_MAX_DIMS];

    ne[axis0] = a->ne[0];
    ne[axis1] = a->ne[1];
    ne[axis2] = a->ne[2];
    ne[axis3] = a->ne[3];

    nb[axis0] = a->nb[0];
    nb[axis1] = a->nb[1];
    nb[axis2] = a->nb[2];
    nb[axis3] = a->nb[3];

    result->ne[0] = ne[0];
    result->ne[1] = ne[1];
    result->ne[2] = ne[2];
    result->ne[3] = ne[3];

    result->nb[0] = nb[0];
    result->nb[1] = nb[1];
    result->nb[2] = nb[2];
    result->nb[3] = nb[3];

    result->op     = WSP_GGML_OP_PERMUTE;
    result->src[0] = a;

    int32_t params[] = { axis0, axis1, axis2, axis3 };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    return result;
}

// wsp_ggml_transpose

struct wsp_ggml_tensor * wsp_ggml_transpose(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    struct wsp_ggml_tensor * result = wsp_ggml_view_tensor(ctx, a);
    wsp_ggml_format_name(result, "%s (transposed)", a->name);

    result->ne[0] = a->ne[1];
    result->ne[1] = a->ne[0];

    result->nb[0] = a->nb[1];
    result->nb[1] = a->nb[0];

    result->op     = WSP_GGML_OP_TRANSPOSE;
    result->src[0] = a;

    return result;
}

// wsp_ggml_get_rows

struct wsp_ggml_tensor * wsp_ggml_get_rows(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    WSP_GGML_ASSERT(a->ne[2] == b->ne[1]);
    WSP_GGML_ASSERT(a->ne[3] == b->ne[2]);
    WSP_GGML_ASSERT(b->ne[3] == 1);
    WSP_GGML_ASSERT(b->type == WSP_GGML_TYPE_I32);

    // TODO: implement non F32 return
    enum wsp_ggml_type type = WSP_GGML_TYPE_F32;
    if (a->type == WSP_GGML_TYPE_I32) {
        type = a->type;
    }
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_4d(ctx, type, a->ne[0], b->ne[0], b->ne[1], b->ne[2]);

    result->op     = WSP_GGML_OP_GET_ROWS;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

// wsp_ggml_get_rows_back

struct wsp_ggml_tensor * wsp_ggml_get_rows_back(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        struct wsp_ggml_tensor  * c) {
    WSP_GGML_ASSERT(wsp_ggml_is_matrix(a) && wsp_ggml_is_vector(b) && b->type == WSP_GGML_TYPE_I32);
    WSP_GGML_ASSERT(wsp_ggml_is_matrix(c) && (a->ne[0] == c->ne[0]));

    // TODO: implement non F32 return
    //struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_2d(ctx, a->type, a->ne[0], b->ne[0]);
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_2d(ctx, WSP_GGML_TYPE_F32, c->ne[0], c->ne[1]);

    result->op     = WSP_GGML_OP_GET_ROWS_BACK;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

// wsp_ggml_set_rows

struct wsp_ggml_tensor * wsp_ggml_set_rows(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        struct wsp_ggml_tensor  * c) {
    WSP_GGML_ASSERT(a->ne[0] == b->ne[0]);
    WSP_GGML_ASSERT(a->ne[2] == b->ne[2]);
    WSP_GGML_ASSERT(a->ne[3] == b->ne[3]);
    WSP_GGML_ASSERT(b->ne[1] == c->ne[0]);
    WSP_GGML_ASSERT(b->ne[2] % c->ne[1] == 0);
    WSP_GGML_ASSERT(b->ne[3] % c->ne[2] == 0);
    WSP_GGML_ASSERT(c->ne[3] == 1);
    WSP_GGML_ASSERT(b->type == WSP_GGML_TYPE_F32);
    WSP_GGML_ASSERT(c->type == WSP_GGML_TYPE_I64 || c->type == WSP_GGML_TYPE_I32);

    WSP_GGML_ASSERT(wsp_ggml_is_contiguous_rows(a));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous_rows(b));

    struct wsp_ggml_tensor * result = wsp_ggml_view_tensor(ctx, a);

    result->op     = WSP_GGML_OP_SET_ROWS;
    result->src[0] = b;
    result->src[1] = c;
    result->src[2] = a; // note: order is weird due to legacy reasons (https://github.com/ggml-org/llama.cpp/pull/16063#discussion_r2385795931)

    return result;
}

// wsp_ggml_diag

struct wsp_ggml_tensor * wsp_ggml_diag(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    WSP_GGML_ASSERT(a->ne[1] == 1);

    const int64_t ne[4] = { a->ne[0], a->ne[0], a->ne[2], a->ne[3] };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, a->type, 4, ne);

    result->op     = WSP_GGML_OP_DIAG;
    result->src[0] = a;

    return result;
}

// wsp_ggml_diag_mask_inf

static struct wsp_ggml_tensor * wsp_ggml_diag_mask_inf_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   n_past,
        bool                  inplace) {
    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    int32_t params[] = { n_past };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_DIAG_MASK_INF;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_diag_mask_inf(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   n_past) {
    return wsp_ggml_diag_mask_inf_impl(ctx, a, n_past, false);
}

struct wsp_ggml_tensor * wsp_ggml_diag_mask_inf_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   n_past) {
    return wsp_ggml_diag_mask_inf_impl(ctx, a, n_past, true);
}

// wsp_ggml_diag_mask_zero

static struct wsp_ggml_tensor * wsp_ggml_diag_mask_zero_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   n_past,
        bool                  inplace) {
    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    int32_t params[] = { n_past };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_DIAG_MASK_ZERO;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_diag_mask_zero(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   n_past) {
    return wsp_ggml_diag_mask_zero_impl(ctx, a, n_past, false);
}

struct wsp_ggml_tensor * wsp_ggml_diag_mask_zero_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   n_past) {
    return wsp_ggml_diag_mask_zero_impl(ctx, a, n_past, true);
}

// wsp_ggml_soft_max

static struct wsp_ggml_tensor * wsp_ggml_soft_max_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * mask,
        float                 scale,
        float                 max_bias,
        bool                  inplace) {
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(a));

    if (mask) {
        WSP_GGML_ASSERT(mask->type == WSP_GGML_TYPE_F16 || mask->type == WSP_GGML_TYPE_F32);
        WSP_GGML_ASSERT(wsp_ggml_is_contiguous(mask));
        WSP_GGML_ASSERT(mask->ne[0] == a->ne[0]);
        WSP_GGML_ASSERT(mask->ne[1] >= a->ne[1]);
        WSP_GGML_ASSERT(a->ne[2]%mask->ne[2] == 0);
        WSP_GGML_ASSERT(a->ne[3]%mask->ne[3] == 0);
    }

    if (max_bias > 0.0f) {
        WSP_GGML_ASSERT(mask);
    }

    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    float params[] = { scale, max_bias };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_SOFT_MAX;
    result->src[0] = a;
    result->src[1] = mask;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_soft_max(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_soft_max_impl(ctx, a, NULL, 1.0f, 0.0f, false);
}

struct wsp_ggml_tensor * wsp_ggml_soft_max_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a) {
    return wsp_ggml_soft_max_impl(ctx, a, NULL, 1.0f, 0.0f, true);
}

struct wsp_ggml_tensor * wsp_ggml_soft_max_ext(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * mask,
        float                 scale,
        float                 max_bias) {
    return wsp_ggml_soft_max_impl(ctx, a, mask, scale, max_bias, false);
}

struct wsp_ggml_tensor * wsp_ggml_soft_max_ext_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * mask,
        float                 scale,
        float                 max_bias) {
    return wsp_ggml_soft_max_impl(ctx, a, mask, scale, max_bias, true);
}

void wsp_ggml_soft_max_add_sinks(
        struct wsp_ggml_tensor * a,
        struct wsp_ggml_tensor * sinks) {
    if (!sinks) {
        a->src[2] = NULL;
        return;
    }

    WSP_GGML_ASSERT(a->op == WSP_GGML_OP_SOFT_MAX);
    WSP_GGML_ASSERT(a->src[2] == NULL);
    WSP_GGML_ASSERT(a->src[0]->ne[2] == sinks->ne[0]);
    WSP_GGML_ASSERT(sinks->type == WSP_GGML_TYPE_F32);

    a->src[2] = sinks;
}

// wsp_ggml_soft_max_ext_back

static struct wsp_ggml_tensor * wsp_ggml_soft_max_ext_back_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        float                 scale,
        float                 max_bias,
        bool                  inplace) {
    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    result->op     = WSP_GGML_OP_SOFT_MAX_BACK;
    result->src[0] = a;
    result->src[1] = b;

    memcpy((float *) result->op_params + 0, &scale,    sizeof(float));
    memcpy((float *) result->op_params + 1, &max_bias, sizeof(float));

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_soft_max_ext_back(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        float                 scale,
        float                 max_bias) {
    return wsp_ggml_soft_max_ext_back_impl(ctx, a, b, scale, max_bias, false);
}

struct wsp_ggml_tensor * wsp_ggml_soft_max_ext_back_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        float                 scale,
        float                 max_bias) {
    return wsp_ggml_soft_max_ext_back_impl(ctx, a, b, scale, max_bias, true);
}

// wsp_ggml_rope

static struct wsp_ggml_tensor * wsp_ggml_rope_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        struct wsp_ggml_tensor  * c,
        int                   n_dims,
        int                   sections[WSP_GGML_MROPE_SECTIONS],
        int                   mode,
        int                   n_ctx_orig,
        float                 freq_base,
        float                 freq_scale,
        float                 ext_factor,
        float                 attn_factor,
        float                 beta_fast,
        float                 beta_slow,
        bool                  inplace) {
    WSP_GGML_ASSERT((mode & 1) == 0 && "mode & 1 == 1 is no longer supported");

    WSP_GGML_ASSERT(wsp_ggml_is_vector(b));
    WSP_GGML_ASSERT(b->type == WSP_GGML_TYPE_I32);

    bool mrope_used = mode & WSP_GGML_ROPE_TYPE_MROPE;
    if (mrope_used) {
        WSP_GGML_ASSERT(a->ne[2] * 4 == b->ne[0]); // mrope expecting 4 position ids per token
    } else {
        WSP_GGML_ASSERT(a->ne[2] == b->ne[0]);
    }

    if (c) {
        WSP_GGML_ASSERT(c->type == WSP_GGML_TYPE_F32);
        WSP_GGML_ASSERT(c->ne[0] >= n_dims / 2);
    }

    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    int32_t params[15] = { /*n_past*/ 0, n_dims, mode, /*n_ctx*/ 0, n_ctx_orig };
    memcpy(params +  5, &freq_base,    sizeof(float));
    memcpy(params +  6, &freq_scale,   sizeof(float));
    memcpy(params +  7, &ext_factor,   sizeof(float));
    memcpy(params +  8, &attn_factor,  sizeof(float));
    memcpy(params +  9, &beta_fast,    sizeof(float));
    memcpy(params + 10, &beta_slow,    sizeof(float));
    if (mrope_used && sections) {
        memcpy(params + 11, sections,  sizeof(int32_t) * WSP_GGML_MROPE_SECTIONS);
    } else {
        memset(params + 11, 0,         sizeof(int32_t) * WSP_GGML_MROPE_SECTIONS);
    }
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_ROPE;
    result->src[0] = a;
    result->src[1] = b;
    result->src[2] = c;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_rope(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int                   n_dims,
        int                   mode) {
    return wsp_ggml_rope_impl(
        ctx, a, b, NULL, n_dims, NULL, mode, 0, 10000.0f, 1.0f, 0.0f, 1.0f, 0.0f, 0.0f, false
    );
}

struct wsp_ggml_tensor * wsp_ggml_rope_multi(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        struct wsp_ggml_tensor  * c,
        int                   n_dims,
        int                   sections[WSP_GGML_MROPE_SECTIONS],
        int                   mode,
        int                   n_ctx_orig,
        float                 freq_base,
        float                 freq_scale,
        float                 ext_factor,
        float                 attn_factor,
        float                 beta_fast,
        float                 beta_slow) {
    return wsp_ggml_rope_impl(
        ctx, a, b, c, n_dims, sections, mode, n_ctx_orig, freq_base, freq_scale,
        ext_factor, attn_factor, beta_fast, beta_slow, false
    );
}

struct wsp_ggml_tensor * wsp_ggml_rope_multi_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        struct wsp_ggml_tensor  * c,
        int                   n_dims,
        int                   sections[WSP_GGML_MROPE_SECTIONS],
        int                   mode,
        int                   n_ctx_orig,
        float                 freq_base,
        float                 freq_scale,
        float                 ext_factor,
        float                 attn_factor,
        float                 beta_fast,
        float                 beta_slow) {
    return wsp_ggml_rope_impl(
        ctx, a, b, c, n_dims, sections, mode, n_ctx_orig, freq_base, freq_scale,
        ext_factor, attn_factor, beta_fast, beta_slow, true
    );
}

struct wsp_ggml_tensor * wsp_ggml_rope_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int                   n_dims,
        int                   mode) {
    return wsp_ggml_rope_impl(
        ctx, a, b, NULL, n_dims, NULL, mode, 0, 10000.0f, 1.0f, 0.0f, 1.0f, 0.0f, 0.0f, true
    );
}

struct wsp_ggml_tensor * wsp_ggml_rope_ext(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        struct wsp_ggml_tensor  * c,
        int                   n_dims,
        int                   mode,
        int                   n_ctx_orig,
        float                 freq_base,
        float                 freq_scale,
        float                 ext_factor,
        float                 attn_factor,
        float                 beta_fast,
        float                 beta_slow) {
    return wsp_ggml_rope_impl(
        ctx, a, b, c, n_dims, NULL, mode, n_ctx_orig, freq_base, freq_scale,
        ext_factor, attn_factor, beta_fast, beta_slow, false
    );
}

struct wsp_ggml_tensor * wsp_ggml_rope_ext_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        struct wsp_ggml_tensor  * c,
        int                   n_dims,
        int                   mode,
        int                   n_ctx_orig,
        float                 freq_base,
        float                 freq_scale,
        float                 ext_factor,
        float                 attn_factor,
        float                 beta_fast,
        float                 beta_slow) {
    return wsp_ggml_rope_impl(
        ctx, a, b, c, n_dims, NULL, mode, n_ctx_orig, freq_base, freq_scale,
        ext_factor, attn_factor, beta_fast, beta_slow, true
    );
}

struct wsp_ggml_tensor * wsp_ggml_rope_custom(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int                   n_dims,
        int                   mode,
        int                   n_ctx_orig,
        float                 freq_base,
        float                 freq_scale,
        float                 ext_factor,
        float                 attn_factor,
        float                 beta_fast,
        float                 beta_slow) {
    return wsp_ggml_rope_impl(
        ctx, a, b, NULL, n_dims, NULL, mode, n_ctx_orig, freq_base, freq_scale,
        ext_factor, attn_factor, beta_fast, beta_slow, false
    );
}

struct wsp_ggml_tensor * wsp_ggml_rope_custom_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int                   n_dims,
        int                   mode,
        int                   n_ctx_orig,
        float                 freq_base,
        float                 freq_scale,
        float                 ext_factor,
        float                 attn_factor,
        float                 beta_fast,
        float                 beta_slow) {
    return wsp_ggml_rope_impl(
        ctx, a, b, NULL, n_dims, NULL, mode, n_ctx_orig, freq_base, freq_scale,
        ext_factor, attn_factor, beta_fast, beta_slow, true
    );
}

// Apparently solving `n_rot = 2pi * x * base^((2 * max_pos_emb) / n_dims)` for x, we get
// `corr_dim(n_rot) = n_dims * log(max_pos_emb / (n_rot * 2pi)) / (2 * log(base))`
static float wsp_ggml_rope_yarn_corr_dim(int n_dims, int n_ctx_orig, float n_rot, float base) {
    return n_dims * logf(n_ctx_orig / (n_rot * 2 * (float)M_PI)) / (2 * logf(base));
}

void wsp_ggml_rope_yarn_corr_dims(
    int n_dims, int n_ctx_orig, float freq_base, float beta_fast, float beta_slow, float dims[2]
) {
    // start and end correction dims
    float start = floorf(wsp_ggml_rope_yarn_corr_dim(n_dims, n_ctx_orig, beta_fast, freq_base));
    float end   =  ceilf(wsp_ggml_rope_yarn_corr_dim(n_dims, n_ctx_orig, beta_slow, freq_base));
    dims[0] = MAX(0, start);
    dims[1] = MIN(n_dims - 1, end);
}

// wsp_ggml_rope_back

struct wsp_ggml_tensor * wsp_ggml_rope_ext_back(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        struct wsp_ggml_tensor  * c,
        int                   n_dims,
        int                   mode,
        int                   n_ctx_orig,
        float                 freq_base,
        float                 freq_scale,
        float                 ext_factor,
        float                 attn_factor,
        float                 beta_fast,
        float                 beta_slow) {
    struct wsp_ggml_tensor * result = wsp_ggml_rope_ext(
        ctx, a, b, c, n_dims, mode, n_ctx_orig, freq_base, freq_scale, ext_factor, attn_factor, beta_fast, beta_slow);
    result->op = WSP_GGML_OP_ROPE_BACK;
    return result;
}

struct wsp_ggml_tensor * wsp_ggml_rope_multi_back(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        struct wsp_ggml_tensor  * c,
        int                   n_dims,
        int                   sections[4],
        int                   mode,
        int                   n_ctx_orig,
        float                 freq_base,
        float                 freq_scale,
        float                 ext_factor,
        float                 attn_factor,
        float                 beta_fast,
        float                 beta_slow) {
    struct wsp_ggml_tensor * result = wsp_ggml_rope_multi(
        ctx, a, b, c, n_dims, sections, mode, n_ctx_orig, freq_base, freq_scale, ext_factor, attn_factor, beta_fast, beta_slow);
    result->op = WSP_GGML_OP_ROPE_BACK;
    return result;
}
// wsp_ggml_clamp

struct wsp_ggml_tensor * wsp_ggml_clamp(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 min,
        float                 max) {
    // TODO: when implement backward, fix this:
    struct wsp_ggml_tensor * result = wsp_ggml_view_tensor(ctx, a);

    float params[] = { min, max };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_CLAMP;
    result->src[0] = a;

    return result;
}

static int64_t wsp_ggml_calc_conv_output_size(int64_t ins, int64_t ks, int s, int p, int d) {
    return (ins + 2 * p - d * (ks - 1) - 1) / s + 1;
}

// im2col: [N, IC, IH, IW] => [N, OH, OW, IC*KH*KW]
// a: [OC，IC, KH, KW]
// b: [N, IC, IH, IW]
// result: [N, OH, OW, IC*KH*KW]
struct wsp_ggml_tensor * wsp_ggml_im2col(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int                   s0,
        int                   s1,
        int                   p0,
        int                   p1,
        int                   d0,
        int                   d1,
        bool                  is_2D,
        enum wsp_ggml_type        dst_type) {
    if (is_2D) {
        WSP_GGML_ASSERT(a->ne[2] == b->ne[2]);
    } else {
        //WSP_GGML_ASSERT(b->ne[1] % a->ne[1] == 0);
        WSP_GGML_ASSERT(b->ne[1] == a->ne[1]);
        WSP_GGML_ASSERT(b->ne[3] == 1);
    }

    const int64_t OH = is_2D ? wsp_ggml_calc_conv_output_size(b->ne[1], a->ne[1], s1, p1, d1) : 0;
    const int64_t OW =         wsp_ggml_calc_conv_output_size(b->ne[0], a->ne[0], s0, p0, d0);

    WSP_GGML_ASSERT((!is_2D || OH > 0) && "b too small compared to a");
    WSP_GGML_ASSERT((OW > 0)           && "b too small compared to a");

    const int64_t ne[4] = {
        is_2D ? (a->ne[2] * a->ne[1] * a->ne[0]) : a->ne[1] * a->ne[0],
        OW,
        is_2D ? OH : b->ne[2],
        is_2D ?      b->ne[3] : 1,
    };

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, dst_type, 4, ne);
    int32_t params[] = { s0, s1, p0, p1, d0, d1, (is_2D ? 1 : 0) };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_IM2COL;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_im2col_back(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int64_t             * ne,
        int                   s0,
        int                   s1,
        int                   p0,
        int                   p1,
        int                   d0,
        int                   d1,
        bool                  is_2D) {
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 4, ne);
    int32_t params[] = { s0, s1, p0, p1, d0, d1, (is_2D ? 1 : 0) };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_IM2COL_BACK;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

// wsp_ggml_conv_1d

struct wsp_ggml_tensor * wsp_ggml_conv_1d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int                   s0,
        int                   p0,
        int                   d0) {
    struct wsp_ggml_tensor * im2col = wsp_ggml_im2col(ctx, a, b, s0, 0, p0, 0, d0, 0, false, WSP_GGML_TYPE_F16); // [N, OL, IC * K]

    struct wsp_ggml_tensor * result =
        wsp_ggml_mul_mat(ctx,
                wsp_ggml_reshape_2d(ctx, im2col, im2col->ne[0], (im2col->ne[2] * im2col->ne[1])), // [N, OL, IC * K] => [N*OL, IC * K]
                wsp_ggml_reshape_2d(ctx, a, (a->ne[0] * a->ne[1]), a->ne[2]));                    // [OC，IC, K] => [OC, IC * K]

    result = wsp_ggml_reshape_3d(ctx, result, im2col->ne[1], a->ne[2], im2col->ne[2]); // [N, OC, OL]

    return result;
}

// wsp_ggml_conv_1d_ph

struct wsp_ggml_tensor* wsp_ggml_conv_1d_ph(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int                   s,
        int                   d) {
    return wsp_ggml_conv_1d(ctx, a, b, s, a->ne[0] / 2, d);
}

// wsp_ggml_conv_1d_dw

struct wsp_ggml_tensor * wsp_ggml_conv_1d_dw(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int                   s0,
        int                   p0,
        int                   d0) {
    struct wsp_ggml_tensor * new_b = wsp_ggml_reshape_4d(ctx, b, b->ne[0], 1, b->ne[1], b->ne[2]);

    struct wsp_ggml_tensor * im2col = wsp_ggml_im2col(ctx, a, new_b, s0, 0, p0, 0, d0, 0, false, WSP_GGML_TYPE_F16);

    struct wsp_ggml_tensor * result = wsp_ggml_mul_mat(ctx, im2col, a);

    result = wsp_ggml_reshape_3d(ctx, result, result->ne[0], result->ne[2], 1);

    return result;
}

// wsp_ggml_conv_1d_dw_ph

struct wsp_ggml_tensor * wsp_ggml_conv_1d_dw_ph(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int                   s0,
        int                   d0) {
    return wsp_ggml_conv_1d_dw(ctx, a, b, s0, a->ne[0] / 2, d0);
}

// wsp_ggml_conv_transpose_1d

static int64_t wsp_ggml_calc_conv_transpose_1d_output_size(int64_t ins, int64_t ks, int s, int p, int d) {
    return (ins - 1) * s - 2 * p + d * (ks - 1) + 1;
}

WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_conv_transpose_1d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int                   s0,
        int                   p0,
        int                   d0) {
    WSP_GGML_ASSERT(wsp_ggml_is_matrix(b));
    WSP_GGML_ASSERT(a->ne[2] == b->ne[1]);
    WSP_GGML_ASSERT(a->ne[3] == 1);

    WSP_GGML_ASSERT(p0 == 0);
    WSP_GGML_ASSERT(d0 == 1);

    const int64_t ne[4] = {
        wsp_ggml_calc_conv_transpose_1d_output_size(b->ne[0], a->ne[0], s0, 0 /*p0*/, 1 /*d0*/),
        a->ne[1], b->ne[2], 1,
    };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 4, ne);

    int32_t params[] = { s0, p0, d0 };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_CONV_TRANSPOSE_1D;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

// wsp_ggml_conv_2d

// a: [OC，IC, KH, KW]
// b: [N, IC, IH, IW]
// result: [N, OC, OH, OW]
struct wsp_ggml_tensor * wsp_ggml_conv_2d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int                   s0,
        int                   s1,
        int                   p0,
        int                   p1,
        int                   d0,
        int                   d1) {
    struct wsp_ggml_tensor * im2col = wsp_ggml_im2col(ctx, a, b, s0, s1, p0, p1, d0, d1, true, a->type); // [N, OH, OW, IC * KH * KW]

    struct wsp_ggml_tensor * result =
        wsp_ggml_mul_mat(ctx,
                wsp_ggml_reshape_2d(ctx, im2col, im2col->ne[0],  im2col->ne[3] * im2col->ne[2] * im2col->ne[1]), // [N, OH, OW, IC * KH * KW] => [N*OH*OW, IC * KH * KW]
                wsp_ggml_reshape_2d(ctx, a, (a->ne[0] * a->ne[1] * a->ne[2]),  a->ne[3]));                       // [OC，IC, KH, KW] => [OC, IC * KH * KW]

    result = wsp_ggml_reshape_4d(ctx, result, im2col->ne[1], im2col->ne[2], im2col->ne[3], a->ne[3]); // [OC, N, OH, OW]
    result = wsp_ggml_cont(ctx, wsp_ggml_permute(ctx, result, 0, 1, 3, 2)); // [N, OC, OH, OW]


    return result;
}

// a: [OC*IC, KD, KH, KW]
// b: [N*IC, ID, IH, IW]
// result: [N*OD, OH, OW, IC * KD * KH * KW]
struct wsp_ggml_tensor * wsp_ggml_im2col_3d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int64_t               IC,
        int                   s0, // stride width
        int                   s1, // stride height
        int                   s2, // stride depth
        int                   p0, // padding width
        int                   p1, // padding height
        int                   p2, // padding depth
        int                   d0, // dilation width
        int                   d1, // dilation height
        int                   d2, // dilation depth
        enum wsp_ggml_type        dst_type) {
    const int64_t N = b->ne[3] / IC;
    const int64_t ID = b->ne[2];
    const int64_t IH = b->ne[1];
    const int64_t IW = b->ne[0];

    const int64_t OC = a->ne[3] / IC;
    UNUSED(OC);
    const int64_t KD = a->ne[2];
    const int64_t KH = a->ne[1];
    const int64_t KW = a->ne[0];
    const int64_t OD = wsp_ggml_calc_conv_output_size(ID, KD, s2, p2, d2);
    const int64_t OH = wsp_ggml_calc_conv_output_size(IH, KH, s1, p1, d1);
    const int64_t OW = wsp_ggml_calc_conv_output_size(IW, KW, s0, p0, d0);

    WSP_GGML_ASSERT((OD > 0)  && "b too small compared to a");
    WSP_GGML_ASSERT((OH > 0)  && "b too small compared to a");
    WSP_GGML_ASSERT((OW > 0)  && "b too small compared to a");


    const int64_t ne[4] = {KW*KH*KD*IC, OW, OH, OD*N};

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, dst_type, 4, ne);
    int32_t params[] = { s0, s1, s2, p0, p1, p2, d0, d1, d2, (int32_t)IC};
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_IM2COL_3D;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

// a: [OC*IC, KD, KH, KW]
// b: [N*IC, ID, IH, IW]
// result: [N*OC, OD, OH, OW]
struct wsp_ggml_tensor * wsp_ggml_conv_3d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int64_t               IC,
        int                   s0, // stride width
        int                   s1, // stride height
        int                   s2, // stride depth
        int                   p0, // padding width
        int                   p1, // padding height
        int                   p2, // padding depth
        int                   d0, // dilation width
        int                   d1, // dilation height
        int                   d2  // dilation depth
        ) {
    struct wsp_ggml_tensor * im2col = wsp_ggml_im2col_3d(ctx, a, b, IC, s0, s1, s2, p0, p1, p2, d0, d1, d2, a->type); // [N*OD, OH, OW, IC * KD * KH * KW]

    int64_t OC = a->ne[3] / IC;
    int64_t N = b->ne[3] / IC;
    struct wsp_ggml_tensor * result =
        wsp_ggml_mul_mat(ctx,
                wsp_ggml_reshape_2d(ctx, im2col, im2col->ne[0], im2col->ne[3] * im2col->ne[2] * im2col->ne[1]), // [N*OD, OH, OW, IC * KD * KH * KW] => [N*OD*OH*OW, IC * KD * KH * KW]
                wsp_ggml_reshape_2d(ctx, a, (a->ne[0] * a->ne[1] * a->ne[2] * IC), OC));                          // [OC*IC, KD, KH, KW] => [OC, IC * KD * KH * KW]

    int64_t OD = im2col->ne[3] / N;
    result = wsp_ggml_reshape_4d(ctx, result, im2col->ne[1]*im2col->ne[2], OD, N, OC); // [OC, N*OD*OH*OW] => [OC, N, OD, OH*OW]
    result = wsp_ggml_cont(ctx, wsp_ggml_permute(ctx, result, 0, 1, 3, 2)); // [N, OC, OD, OH*OW]
    result = wsp_ggml_reshape_4d(ctx, result, im2col->ne[1], im2col->ne[2], OD, OC * N); // [N*OC, OD, OH, OW]

    return result;
}

// wsp_ggml_conv_2d_sk_p0

struct wsp_ggml_tensor * wsp_ggml_conv_2d_sk_p0(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_conv_2d(ctx, a, b, a->ne[0], a->ne[1], 0, 0, 1, 1);
}

// wsp_ggml_conv_2d_s1_ph

struct wsp_ggml_tensor * wsp_ggml_conv_2d_s1_ph(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    return wsp_ggml_conv_2d(ctx, a, b, 1, 1, a->ne[0] / 2, a->ne[1] / 2, 1, 1);
}

// wsp_ggml_conv_2d_dw

struct wsp_ggml_tensor * wsp_ggml_conv_2d_dw(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int                   s0,
        int                   s1,
        int                   p0,
        int                   p1,
        int                   d0,
        int                   d1) {
    struct wsp_ggml_tensor * new_a = wsp_ggml_reshape_4d(ctx, a, a->ne[0], a->ne[1], 1, a->ne[2] * a->ne[3]);
    struct wsp_ggml_tensor * im2col = wsp_ggml_im2col(ctx, new_a,
                                        wsp_ggml_reshape_4d(ctx, b, b->ne[0], b->ne[1], 1, b->ne[2] * b->ne[3]),
                                        s0, s1, p0, p1, d0, d1, true, WSP_GGML_TYPE_F16); // [N * IC, OH, OW, KH * KW]
    struct wsp_ggml_tensor * new_b = wsp_ggml_reshape_4d(ctx, im2col, im2col->ne[0], im2col->ne[2] * im2col->ne[1], b->ne[2], b->ne[3]); // [N * IC, OH, OW, KH * KW] => [N, IC, OH * OW, KH * KW]

    new_a = wsp_ggml_reshape_4d(ctx, new_a, (new_a->ne[0] * new_a->ne[1]), new_a->ne[2],  new_a->ne[3], 1);                       // [OC，1, KH, KW] => [1, OC, 1, KH * KW]
    struct wsp_ggml_tensor * result = wsp_ggml_mul_mat(ctx, new_a, new_b);
    result = wsp_ggml_reshape_4d(ctx, result, im2col->ne[1], im2col->ne[2], b->ne[2], b->ne[3]); // [N, OC, OH, OW]

    return result;
}

// wsp_ggml_conv_2d_dw_direct

struct wsp_ggml_tensor * wsp_ggml_conv_2d_dw_direct(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int                   stride0,
        int                   stride1,
        int                   pad0,
        int                   pad1,
        int                   dilation0,
        int                   dilation1) {
    WSP_GGML_ASSERT(a->ne[2] == 1);
    WSP_GGML_ASSERT(a->ne[3] == b->ne[2]);
    int64_t ne[4];
    ne[0] = wsp_ggml_calc_conv_output_size(b->ne[0], a->ne[0], stride0, pad0, dilation0);
    ne[1] = wsp_ggml_calc_conv_output_size(b->ne[1], a->ne[1], stride1, pad1, dilation1);
    ne[2] = b->ne[2];
    ne[3] = b->ne[3];

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, b->type, 4, ne);

    if (wsp_ggml_is_contiguous_channels(b)) {
        // Result will be permuted the same way as input (CWHN order)
        const int64_t type_size = wsp_ggml_type_size(result->type);
        WSP_GGML_ASSERT(wsp_ggml_blck_size(result->type) == 1);
        result->nb[0] = result->ne[2] * type_size;
        result->nb[1] = result->ne[0] * result->nb[0];
        result->nb[2] = type_size;
    }

    int32_t params[] = { stride0, stride1, pad0, pad1, dilation0, dilation1 };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_CONV_2D_DW;
    result->src[0] = a;
    result->src[1] = b;
    return result;
}

// wsp_ggml_conv_2d_direct

struct wsp_ggml_tensor * wsp_ggml_conv_2d_direct(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,   // convolution kernel [KW, KH, IC, OC]
        struct wsp_ggml_tensor  * b,   // input data [W, H, C, N]
        int                   s0,  // stride dimension 0
        int                   s1,  // stride dimension 1
        int                   p0,  // padding dimension 0
        int                   p1,  // padding dimension 1
        int                   d0,  // dilation dimension 0
        int                   d1) {// dilation dimension 1

    WSP_GGML_ASSERT(a->ne[2] == b->ne[2]);
    //WSP_GGML_ASSERT(a->type == b->type);

    int64_t ne[4];
    ne[0] = wsp_ggml_calc_conv_output_size(b->ne[0], a->ne[0], s0, p0, d0);
    ne[1] = wsp_ggml_calc_conv_output_size(b->ne[1], a->ne[1], s1, p1, d1);
    ne[2] = a->ne[3];
    ne[3] = b->ne[3];

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, b->type, 4, ne);

    wsp_ggml_set_op_params_i32(result, 0, s0);
    wsp_ggml_set_op_params_i32(result, 1, s1);
    wsp_ggml_set_op_params_i32(result, 2, p0);
    wsp_ggml_set_op_params_i32(result, 3, p1);
    wsp_ggml_set_op_params_i32(result, 4, d0);
    wsp_ggml_set_op_params_i32(result, 5, d1);

    result->op = WSP_GGML_OP_CONV_2D;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

// wsp_ggml_conv_3d_direct

struct wsp_ggml_tensor * wsp_ggml_conv_3d_direct(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int                   s0,
        int                   s1,
        int                   s2,
        int                   p0,
        int                   p1,
        int                   p2,
        int                   d0,
        int                   d1,
        int                   d2,
        int                   c,
        int                   n,
        int                   oc) {

    WSP_GGML_ASSERT(a->ne[3] == (int64_t) c * oc);
    WSP_GGML_ASSERT(b->ne[3] == (int64_t) c * n);

    int64_t ne[4];
    ne[0] = wsp_ggml_calc_conv_output_size(b->ne[0], a->ne[0], s0, p0, d0);
    ne[1] = wsp_ggml_calc_conv_output_size(b->ne[1], a->ne[1], s1, p1, d1);
    ne[2] = wsp_ggml_calc_conv_output_size(b->ne[2], a->ne[2], s2, p2, d2);
    ne[3] = (int64_t) oc * n;

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 4, ne);

    wsp_ggml_set_op_params_i32(result, 0,  s0);
    wsp_ggml_set_op_params_i32(result, 1,  s1);
    wsp_ggml_set_op_params_i32(result, 2,  s2);
    wsp_ggml_set_op_params_i32(result, 3,  p0);
    wsp_ggml_set_op_params_i32(result, 4,  p1);
    wsp_ggml_set_op_params_i32(result, 5,  p2);
    wsp_ggml_set_op_params_i32(result, 6,  d0);
    wsp_ggml_set_op_params_i32(result, 7,  d1);
    wsp_ggml_set_op_params_i32(result, 8,  d2);
    wsp_ggml_set_op_params_i32(result, 9,  c);
    wsp_ggml_set_op_params_i32(result, 10, n);
    wsp_ggml_set_op_params_i32(result, 11, oc);

    result->op = WSP_GGML_OP_CONV_3D;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

// wsp_ggml_conv_transpose_2d_p0

static int64_t wsp_ggml_calc_conv_transpose_output_size(int64_t ins, int64_t ks, int s, int p) {
    return (ins - 1) * s - 2 * p + ks;
}

struct wsp_ggml_tensor * wsp_ggml_conv_transpose_2d_p0(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        int                   stride) {
    WSP_GGML_ASSERT(a->ne[3] == b->ne[2]);

    const int64_t ne[4] = {
        wsp_ggml_calc_conv_transpose_output_size(b->ne[0], a->ne[0], stride, 0 /*p0*/),
        wsp_ggml_calc_conv_transpose_output_size(b->ne[1], a->ne[1], stride, 0 /*p1*/),
        a->ne[2], b->ne[3],
    };

    struct wsp_ggml_tensor* result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 4, ne);

    wsp_ggml_set_op_params_i32(result, 0, stride);

    result->op     = WSP_GGML_OP_CONV_TRANSPOSE_2D;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

// wsp_ggml_pool_*

static int64_t wsp_ggml_calc_pool_output_size(int64_t ins, int ks, int s, float p) {
    return (ins + 2 * p - ks) / s + 1;
}

// wsp_ggml_pool_1d

struct wsp_ggml_tensor * wsp_ggml_pool_1d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        enum wsp_ggml_op_pool     op,
        int                   k0,
        int                   s0,
        int                   p0) {
    const int64_t ne[4] = {
        wsp_ggml_calc_pool_output_size(a->ne[0], k0, s0, p0),
        a->ne[1],
        a->ne[2],
        a->ne[3],
    };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 4, ne);

    int32_t params[] = { op, k0, s0, p0 };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_POOL_1D;
    result->src[0] = a;

    return result;
}

// wsp_ggml_pool_2d

struct wsp_ggml_tensor * wsp_ggml_pool_2d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        enum wsp_ggml_op_pool     op,
        int                   k0,
        int                   k1,
        int                   s0,
        int                   s1,
        float                 p0,
        float                 p1) {
    struct wsp_ggml_tensor * result;
    const int64_t ne[4] = {
        wsp_ggml_calc_pool_output_size(a->ne[0], k0, s0, p0),
        wsp_ggml_calc_pool_output_size(a->ne[1], k1, s1, p1),
        a->ne[2],
        a->ne[3],
    };
    result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 4, ne);

    int32_t params[] = { op, k0, k1, s0, s1, p0, p1 };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_POOL_2D;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_pool_2d_back(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * af,
        enum wsp_ggml_op_pool     op,
        int                   k0,
        int                   k1,
        int                   s0,
        int                   s1,
        float                 p0,
        float                 p1) {
    struct wsp_ggml_tensor * result;
    result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 4, af->ne);

    int32_t params[] = { op, k0, k1, s0, s1, p0, p1 };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_POOL_2D_BACK;
    result->src[0] = a;
    result->src[1] = af;

    return result;
}

// wsp_ggml_upscale / wsp_ggml_interpolate

static struct wsp_ggml_tensor * wsp_ggml_interpolate_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int64_t               ne0,
        int64_t               ne1,
        int64_t               ne2,
        int64_t               ne3,
        uint32_t              mode) {
    WSP_GGML_ASSERT((mode & 0xFF) < WSP_GGML_SCALE_MODE_COUNT);

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_4d(ctx, a->type, ne0, ne1, ne2, ne3);

    wsp_ggml_set_op_params_i32(result, 0, (int32_t)mode);

    result->op     = WSP_GGML_OP_UPSCALE;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_upscale(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   scale_factor,
        enum wsp_ggml_scale_mode  mode) {
    WSP_GGML_ASSERT(scale_factor > 1);
    return wsp_ggml_interpolate_impl(ctx, a, a->ne[0] * scale_factor, a->ne[1] * scale_factor, a->ne[2], a->ne[3], mode);
}

struct wsp_ggml_tensor * wsp_ggml_upscale_ext(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   ne0,
        int                   ne1,
        int                   ne2,
        int                   ne3,
        enum wsp_ggml_scale_mode  mode) {
    return wsp_ggml_interpolate_impl(ctx, a, ne0, ne1, ne2, ne3, mode);
}

struct wsp_ggml_tensor * wsp_ggml_interpolate(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int64_t               ne0,
        int64_t               ne1,
        int64_t               ne2,
        int64_t               ne3,
        uint32_t              mode) {
    return wsp_ggml_interpolate_impl(ctx, a, ne0, ne1, ne2, ne3, mode);
}

// wsp_ggml_pad

struct wsp_ggml_tensor * wsp_ggml_pad(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   p0,
        int                   p1,
        int                   p2,
        int                   p3) {
    return wsp_ggml_pad_ext(ctx, a, 0, p0, 0, p1, 0, p2, 0, p3);
}

struct wsp_ggml_tensor * wsp_ggml_pad_ext(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                  lp0,
            int                  rp0,
            int                  lp1,
            int                  rp1,
            int                  lp2,
            int                  rp2,
            int                  lp3,
            int                  rp3
            ) {
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_4d(ctx, a->type,
            a->ne[0] + lp0 + rp0,
            a->ne[1] + lp1 + rp1,
            a->ne[2] + lp2 + rp2,
            a->ne[3] + lp3 + rp3);

    wsp_ggml_set_op_params_i32(result, 0, lp0);
    wsp_ggml_set_op_params_i32(result, 1, rp0);
    wsp_ggml_set_op_params_i32(result, 2, lp1);
    wsp_ggml_set_op_params_i32(result, 3, rp1);
    wsp_ggml_set_op_params_i32(result, 4, lp2);
    wsp_ggml_set_op_params_i32(result, 5, rp2);
    wsp_ggml_set_op_params_i32(result, 6, lp3);
    wsp_ggml_set_op_params_i32(result, 7, rp3);


    result->op     = WSP_GGML_OP_PAD;
    result->src[0] = a;

    return result;
}

// wsp_ggml_pad_reflect_1d

struct wsp_ggml_tensor * wsp_ggml_pad_reflect_1d(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   p0,
        int                   p1) {
    WSP_GGML_ASSERT(p0 >= 0);
    WSP_GGML_ASSERT(p1 >= 0);

    WSP_GGML_ASSERT(p0 < a->ne[0]); // padding length on each size must be less than the
    WSP_GGML_ASSERT(p1 < a->ne[0]); // existing length of the dimension being padded

    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(a));
    WSP_GGML_ASSERT(a->type == WSP_GGML_TYPE_F32);

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_4d(ctx, a->type,
            a->ne[0] + p0 + p1,
            a->ne[1],
            a->ne[2],
            a->ne[3]);

    int32_t params[] = { p0, p1 };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_PAD_REFLECT_1D;
    result->src[0] = a;

    return result;
}

// wsp_ggml_roll

struct wsp_ggml_tensor * wsp_ggml_roll(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   shift0,
        int                   shift1,
        int                   shift2,
        int                   shift3) {
    WSP_GGML_ASSERT(a->nb[0] == wsp_ggml_type_size(a->type));
    WSP_GGML_ASSERT(abs(shift0) < a->ne[0]);
    WSP_GGML_ASSERT(abs(shift1) < a->ne[1]);
    WSP_GGML_ASSERT(abs(shift2) < a->ne[2]);
    WSP_GGML_ASSERT(abs(shift3) < a->ne[3]);

    struct wsp_ggml_tensor * result = wsp_ggml_dup_tensor(ctx, a);

    wsp_ggml_set_op_params_i32(result, 0, shift0);
    wsp_ggml_set_op_params_i32(result, 1, shift1);
    wsp_ggml_set_op_params_i32(result, 2, shift2);
    wsp_ggml_set_op_params_i32(result, 3, shift3);

    result->op     = WSP_GGML_OP_ROLL;
    result->src[0] = a;

    return result;
}

// wsp_ggml_arange

struct wsp_ggml_tensor * wsp_ggml_arange(
        struct wsp_ggml_context * ctx,
        float                 start,
        float                 stop,
        float                 step) {
    WSP_GGML_ASSERT(stop > start);

    const int64_t steps = (int64_t) ceilf((stop - start) / step);

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_1d(ctx, WSP_GGML_TYPE_F32, steps);

    wsp_ggml_set_op_params_f32(result, 0, start);
    wsp_ggml_set_op_params_f32(result, 1, stop);
    wsp_ggml_set_op_params_f32(result, 2, step);

    result->op = WSP_GGML_OP_ARANGE;

    return result;
}

// wsp_ggml_timestep_embedding

struct wsp_ggml_tensor * wsp_ggml_timestep_embedding(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * timesteps,
        int                   dim,
        int                   max_period) {

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_2d(ctx, WSP_GGML_TYPE_F32, dim, timesteps->ne[0]);

    wsp_ggml_set_op_params_i32(result, 0, dim);
    wsp_ggml_set_op_params_i32(result, 1, max_period);

    result->op     = WSP_GGML_OP_TIMESTEP_EMBEDDING;
    result->src[0] = timesteps;

    return result;
}

// wsp_ggml_tri

struct wsp_ggml_tensor * wsp_ggml_tri(
    struct wsp_ggml_context * ctx,
    struct wsp_ggml_tensor  * a,
    enum wsp_ggml_tri_type    type) {
    WSP_GGML_ASSERT(a->type == WSP_GGML_TYPE_F32);

    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(a));
    WSP_GGML_ASSERT(a->ne[0] == a->ne[1]);

    struct wsp_ggml_tensor * result = wsp_ggml_dup_tensor(ctx, a);

    wsp_ggml_set_op_params_i32(result, 0, type);

    result->op = WSP_GGML_OP_TRI;
    result->src[0] = a;

    return result;
}

// wsp_ggml_fill

static struct wsp_ggml_tensor * wsp_ggml_fill_impl(
    struct wsp_ggml_context * ctx,
    struct wsp_ggml_tensor  * a,
    float                 c,
    bool                  inplace) {
    WSP_GGML_ASSERT(a->type == WSP_GGML_TYPE_F32);
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(a));

    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    wsp_ggml_set_op_params_f32(result, 0, c);

    result->op = WSP_GGML_OP_FILL;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_fill(
    struct wsp_ggml_context * ctx,
    struct wsp_ggml_tensor  * a,
    float                 c) {
    return wsp_ggml_fill_impl(ctx, a, c, false);
}

struct wsp_ggml_tensor * wsp_ggml_fill_inplace(
    struct wsp_ggml_context * ctx,
    struct wsp_ggml_tensor  * a,
    float                 c) {
    return wsp_ggml_fill_impl(ctx, a, c, true);
}

// wsp_ggml_argsort

struct wsp_ggml_tensor * wsp_ggml_argsort(
        struct wsp_ggml_context  * ctx,
        struct wsp_ggml_tensor   * a,
        enum wsp_ggml_sort_order   order) {
    WSP_GGML_ASSERT(a->ne[0] <= INT32_MAX);
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_I32, WSP_GGML_MAX_DIMS, a->ne);

    wsp_ggml_set_op_params_i32(result, 0, (int32_t) order);

    result->op     = WSP_GGML_OP_ARGSORT;
    result->src[0] = a;

    return result;
}

// wsp_ggml_top_k

struct wsp_ggml_tensor * wsp_ggml_top_k(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   k) {
    WSP_GGML_ASSERT(a->ne[0] >= k);

    struct wsp_ggml_tensor * result = wsp_ggml_argsort(ctx, a, WSP_GGML_SORT_ORDER_DESC);

    result = wsp_ggml_view_4d(ctx, result,
                k, result->ne[1], result->ne[2], result->ne[3],
                   result->nb[1], result->nb[2], result->nb[3],
                0);

    return result;
}

// wsp_ggml_flash_attn_ext

struct wsp_ggml_tensor * wsp_ggml_flash_attn_ext(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * q,
        struct wsp_ggml_tensor  * k,
        struct wsp_ggml_tensor  * v,
        struct wsp_ggml_tensor  * mask,
        float                 scale,
        float                 max_bias,
        float                 logit_softcap) {
    WSP_GGML_ASSERT(wsp_ggml_can_mul_mat(k, q));
    // TODO: check if vT can be multiplied by (k*qT)

    WSP_GGML_ASSERT(q->ne[3] == k->ne[3]);
    WSP_GGML_ASSERT(q->ne[3] == v->ne[3]);

    if (mask) {
        WSP_GGML_ASSERT(wsp_ggml_is_contiguous(mask));
        WSP_GGML_ASSERT(mask->ne[1] >= WSP_GGML_PAD(q->ne[1], WSP_GGML_KQ_MASK_PAD) &&
                "the Flash-Attention kernel requires the mask to be padded to WSP_GGML_KQ_MASK_PAD and at least n_queries big");
        //WSP_GGML_ASSERT(wsp_ggml_can_repeat_rows(mask, qk));

        WSP_GGML_ASSERT(q->ne[2] % mask->ne[2] == 0);
        WSP_GGML_ASSERT(q->ne[3] % mask->ne[3] == 0);
    }

    if (max_bias > 0.0f) {
        WSP_GGML_ASSERT(mask);
    }

    // permute(0, 2, 1, 3)
    int64_t ne[4] = { v->ne[0], q->ne[2], q->ne[1], q->ne[3] };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 4, ne);

    float params[] = { scale, max_bias, logit_softcap };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_FLASH_ATTN_EXT;
    result->src[0] = q;
    result->src[1] = k;
    result->src[2] = v;
    result->src[3] = mask;

    return result;
}

void wsp_ggml_flash_attn_ext_set_prec(
        struct wsp_ggml_tensor * a,
        enum wsp_ggml_prec       prec) {
    WSP_GGML_ASSERT(a->op == WSP_GGML_OP_FLASH_ATTN_EXT);

    const int32_t prec_i32 = (int32_t) prec;

    wsp_ggml_set_op_params_i32(a, 3, prec_i32); // scale is on first pos, max_bias on second
}

enum wsp_ggml_prec wsp_ggml_flash_attn_ext_get_prec(
        const struct wsp_ggml_tensor * a) {
    WSP_GGML_ASSERT(a->op == WSP_GGML_OP_FLASH_ATTN_EXT);

    const int32_t prec_i32 = wsp_ggml_get_op_params_i32(a, 3);

    return (enum wsp_ggml_prec) prec_i32;
}

void wsp_ggml_flash_attn_ext_add_sinks(
        struct wsp_ggml_tensor * a,
        struct wsp_ggml_tensor * sinks) {
    if (!sinks) {
        a->src[4] = NULL;
        return;
    }

    WSP_GGML_ASSERT(a->op == WSP_GGML_OP_FLASH_ATTN_EXT);
    WSP_GGML_ASSERT(a->src[4] == NULL);
    WSP_GGML_ASSERT(a->src[0]->ne[2] == sinks->ne[0]);
    WSP_GGML_ASSERT(sinks->type == WSP_GGML_TYPE_F32);

    a->src[4] = sinks;
}

// wsp_ggml_flash_attn_back

struct wsp_ggml_tensor * wsp_ggml_flash_attn_back(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * q,
        struct wsp_ggml_tensor  * k,
        struct wsp_ggml_tensor  * v,
        struct wsp_ggml_tensor  * d,
        bool                  masked) {
    WSP_GGML_ABORT("TODO: adapt to wsp_ggml_flash_attn_ext() changes");

    WSP_GGML_ASSERT(wsp_ggml_can_mul_mat(k, q));
    // TODO: check if vT can be multiplied by (k*qT)

    // d shape [D,N,ne2,ne3]
    // q shape [D,N,ne2,ne3]
    // k shape [D,M,kvne2,ne3]
    // v shape [M,D,kvne2,ne3]

    const int64_t     D = q->ne[0];
    const int64_t     N = q->ne[1];
    const int64_t     M = k->ne[1];
    const int64_t   ne2 = q->ne[2];
    const int64_t   ne3 = q->ne[3];
    const int64_t kvne2 = k->ne[2];

    WSP_GGML_ASSERT(k->ne[0] == D);
    WSP_GGML_ASSERT(v->ne[0] == M);
    WSP_GGML_ASSERT(v->ne[1] == D);
    WSP_GGML_ASSERT(d->ne[0] == D);
    WSP_GGML_ASSERT(d->ne[1] == N);
    WSP_GGML_ASSERT(k->ne[2] == kvne2);
    WSP_GGML_ASSERT(k->ne[3] == ne3);
    WSP_GGML_ASSERT(v->ne[2] == kvne2);
    WSP_GGML_ASSERT(v->ne[3] == ne3);
    WSP_GGML_ASSERT(d->ne[2] == ne2);
    WSP_GGML_ASSERT(d->ne[3] == ne3);

    WSP_GGML_ASSERT(ne2 % kvne2 == 0);

    // store gradients of q, k and v as continuous tensors concatenated in result.
    // note: v and gradv are actually transposed, i.e. v->ne[0] != D.
    const int64_t elem_q = wsp_ggml_nelements(q);
    const int64_t elem_k = wsp_ggml_nelements(k);
    const int64_t elem_v = wsp_ggml_nelements(v);

    enum wsp_ggml_type result_type = WSP_GGML_TYPE_F32;
    WSP_GGML_ASSERT(wsp_ggml_blck_size(result_type) == 1);
    const size_t tsize = wsp_ggml_type_size(result_type);

    const size_t offs_q = 0;
    const size_t offs_k = offs_q + WSP_GGML_PAD(elem_q * tsize, WSP_GGML_MEM_ALIGN);
    const size_t offs_v = offs_k + WSP_GGML_PAD(elem_k * tsize, WSP_GGML_MEM_ALIGN);
    const size_t end    = offs_v + WSP_GGML_PAD(elem_v * tsize, WSP_GGML_MEM_ALIGN);

    const size_t nelements = (end + tsize - 1)/tsize;

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_1d(ctx, WSP_GGML_TYPE_F32, nelements);

    int32_t masked_i = masked ? 1 : 0;
    wsp_ggml_set_op_params(result, &masked_i, sizeof(masked_i));

    result->op     = WSP_GGML_OP_FLASH_ATTN_BACK;
    result->src[0] = q;
    result->src[1] = k;
    result->src[2] = v;
    result->src[3] = d;

    return result;
}

// wsp_ggml_ssm_conv

struct wsp_ggml_tensor * wsp_ggml_ssm_conv(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * sx,
        struct wsp_ggml_tensor  * c) {
    WSP_GGML_ASSERT(wsp_ggml_is_3d(sx));
    WSP_GGML_ASSERT(wsp_ggml_is_matrix(c));

    const int64_t d_conv  = c->ne[0];
    const int64_t d_inner = c->ne[1];
    const int64_t n_t     = sx->ne[0] - d_conv + 1; // tokens per sequence
    const int64_t n_s     = sx->ne[2];

    // TODO: maybe support other strides than 1?
    WSP_GGML_ASSERT(sx->ne[0] == d_conv - 1 + n_t);
    WSP_GGML_ASSERT(sx->ne[1] == d_inner);
    WSP_GGML_ASSERT(n_t >= 0);

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_3d(ctx, WSP_GGML_TYPE_F32, d_inner, n_t, n_s);

    result->op     = WSP_GGML_OP_SSM_CONV;
    result->src[0] = sx;
    result->src[1] = c;

    return result;
}

// wsp_ggml_ssm_scan

struct wsp_ggml_tensor * wsp_ggml_ssm_scan(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * s,
        struct wsp_ggml_tensor  * x,
        struct wsp_ggml_tensor  * dt,
        struct wsp_ggml_tensor  * A,
        struct wsp_ggml_tensor  * B,
        struct wsp_ggml_tensor  * C,
        struct wsp_ggml_tensor  * ids) {
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(s));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(dt));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(A));
    WSP_GGML_ASSERT(x->nb[0] == wsp_ggml_type_size(x->type));
    WSP_GGML_ASSERT(B->nb[0] == wsp_ggml_type_size(B->type));
    WSP_GGML_ASSERT(C->nb[0] == wsp_ggml_type_size(C->type));
    WSP_GGML_ASSERT(x->nb[1] == x->ne[0]*x->nb[0]);
    WSP_GGML_ASSERT(B->nb[1] == B->ne[0]*B->nb[0]);
    WSP_GGML_ASSERT(C->nb[1] == C->ne[0]*C->nb[0]);
    WSP_GGML_ASSERT(wsp_ggml_are_same_shape(B, C));
    WSP_GGML_ASSERT(ids->type == WSP_GGML_TYPE_I32);

    {
        const int64_t d_state      = s->ne[0];
        const int64_t head_dim     = x->ne[0];
        const int64_t n_head       = x->ne[1];
        const int64_t n_seq_tokens = x->ne[2];
        const int64_t n_seqs       = x->ne[3];

        WSP_GGML_ASSERT(dt->ne[0] == n_head);
        WSP_GGML_ASSERT(dt->ne[1] == n_seq_tokens);
        WSP_GGML_ASSERT(dt->ne[2] == n_seqs);
        WSP_GGML_ASSERT(wsp_ggml_is_3d(dt));
        WSP_GGML_ASSERT(s->ne[1] == head_dim);
        WSP_GGML_ASSERT(s->ne[2] == n_head);
        WSP_GGML_ASSERT(B->ne[0] == d_state);
        WSP_GGML_ASSERT(B->ne[2] == n_seq_tokens);
        WSP_GGML_ASSERT(B->ne[3] == n_seqs);
        WSP_GGML_ASSERT(ids->ne[0] == n_seqs);
        WSP_GGML_ASSERT(wsp_ggml_is_vector(ids));
        WSP_GGML_ASSERT(A->ne[1] == n_head);
        WSP_GGML_ASSERT(wsp_ggml_is_matrix(A));

        if (A->ne[0] != 1) {
            // Mamba-1 has more granular decay factors
            WSP_GGML_ASSERT(A->ne[0] == d_state);
        }
    }

    // concatenated y + ssm_states
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_1d(ctx, WSP_GGML_TYPE_F32, wsp_ggml_nelements(x) + s->ne[0]*s->ne[1]*s->ne[2]*ids->ne[0]);

    result->op   = WSP_GGML_OP_SSM_SCAN;
    result->src[0] = s;
    result->src[1] = x;
    result->src[2] = dt;
    result->src[3] = A;
    result->src[4] = B;
    result->src[5] = C;
    result->src[6] = ids;

    return result;
}

// wsp_ggml_win_part

struct wsp_ggml_tensor * wsp_ggml_win_part(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   w) {
    WSP_GGML_ASSERT(a->ne[3] == 1);
    WSP_GGML_ASSERT(a->type  == WSP_GGML_TYPE_F32);

    // padding
    const int px = (w - a->ne[1]%w)%w;
    const int py = (w - a->ne[2]%w)%w;

    const int npx = (px + a->ne[1])/w;
    const int npy = (py + a->ne[2])/w;
    const int np  = npx*npy;

    const int64_t ne[4] = { a->ne[0], w, w, np, };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 4, ne);

    int32_t params[] = { npx, npy, w };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_WIN_PART;
    result->src[0] = a;

    return result;
}

// wsp_ggml_win_unpart

struct wsp_ggml_tensor * wsp_ggml_win_unpart(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   w0,
        int                   h0,
        int                   w) {
    WSP_GGML_ASSERT(a->type == WSP_GGML_TYPE_F32);

    const int64_t ne[4] = { a->ne[0], w0, h0, 1, };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 3, ne);

    int32_t params[] = { w };
    wsp_ggml_set_op_params(result, params, sizeof(params));

    result->op     = WSP_GGML_OP_WIN_UNPART;
    result->src[0] = a;

    return result;
}

// wsp_ggml_get_rel_pos

struct wsp_ggml_tensor * wsp_ggml_get_rel_pos(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        int                   qh,
        int                   kh) {
    WSP_GGML_ASSERT(qh == kh);
    WSP_GGML_ASSERT(2*MAX(qh, kh) - 1 == a->ne[1]);

    const int64_t ne[4] = { a->ne[0], kh, qh, 1, };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F16, 3, ne);

    result->op     = WSP_GGML_OP_GET_REL_POS;
    result->src[0] = a;

    return result;
}

// wsp_ggml_add_rel_pos

static struct wsp_ggml_tensor * wsp_ggml_add_rel_pos_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * pw,
        struct wsp_ggml_tensor  * ph,
        bool                  inplace) {
    WSP_GGML_ASSERT(wsp_ggml_are_same_shape(pw, ph));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(a));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(pw));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(ph));
    WSP_GGML_ASSERT(ph->type == WSP_GGML_TYPE_F32);
    WSP_GGML_ASSERT(pw->type == WSP_GGML_TYPE_F32);
    WSP_GGML_ASSERT(pw->ne[3] == a->ne[2]);
    WSP_GGML_ASSERT(pw->ne[0]*pw->ne[0] == a->ne[0]);
    WSP_GGML_ASSERT(pw->ne[1]*pw->ne[2] == a->ne[1]);

    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);
    wsp_ggml_set_op_params_i32(result, 0, inplace ? 1 : 0);

    result->op     = WSP_GGML_OP_ADD_REL_POS;
    result->src[0] = a;
    result->src[1] = pw;
    result->src[2] = ph;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_add_rel_pos(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * pw,
        struct wsp_ggml_tensor  * ph) {
    return wsp_ggml_add_rel_pos_impl(ctx, a, pw, ph, false);
}

struct wsp_ggml_tensor * wsp_ggml_add_rel_pos_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * pw,
        struct wsp_ggml_tensor  * ph) {
    return wsp_ggml_add_rel_pos_impl(ctx, a, pw, ph, true);
}

// wsp_ggml_rwkv_wkv6

struct wsp_ggml_tensor * wsp_ggml_rwkv_wkv6(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * k,
        struct wsp_ggml_tensor  * v,
        struct wsp_ggml_tensor  * r,
        struct wsp_ggml_tensor  * tf,
        struct wsp_ggml_tensor  * td,
        struct wsp_ggml_tensor  * state) {
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(k));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(v));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(r));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(tf));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(td));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(state));

    const int64_t S = k->ne[0];
    const int64_t H = k->ne[1];
    const int64_t n_tokens = k->ne[2];
    const int64_t n_seqs = state->ne[1];
    {
        WSP_GGML_ASSERT(v->ne[0] == S && v->ne[1] == H && v->ne[2] == n_tokens);
        WSP_GGML_ASSERT(r->ne[0] == S && r->ne[1] == H && r->ne[2] == n_tokens);
        WSP_GGML_ASSERT(td->ne[0] == S && td->ne[1] == H && td->ne[2] == n_tokens);
        WSP_GGML_ASSERT(wsp_ggml_nelements(state) == S * S * H * n_seqs);
    }

    // concat output and new_state
    const int64_t ne[4] = { S * H, n_tokens + S * n_seqs, 1, 1 };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 4, ne);

    result->op     = WSP_GGML_OP_RWKV_WKV6;
    result->src[0] = k;
    result->src[1] = v;
    result->src[2] = r;
    result->src[3] = tf;
    result->src[4] = td;
    result->src[5] = state;

    return result;
}

// wsp_ggml_gated_linear_attn

struct wsp_ggml_tensor * wsp_ggml_gated_linear_attn(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * k,
        struct wsp_ggml_tensor  * v,
        struct wsp_ggml_tensor  * q,
        struct wsp_ggml_tensor  * g,
        struct wsp_ggml_tensor  * state,
        float scale) {
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(k));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(v));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(q));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(g));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(state));

    const int64_t S = k->ne[0];
    const int64_t H = k->ne[1];
    const int64_t n_tokens = k->ne[2];
    const int64_t n_seqs = state->ne[1];
    {
        WSP_GGML_ASSERT(v->ne[0] == S && v->ne[1] == H && v->ne[2] == n_tokens);
        WSP_GGML_ASSERT(q->ne[0] == S && q->ne[1] == H && q->ne[2] == n_tokens);
        WSP_GGML_ASSERT(g->ne[0] == S && g->ne[1] == H && g->ne[2] == n_tokens);
        WSP_GGML_ASSERT(wsp_ggml_nelements(state) == S * S * H * n_seqs);
    }

    // concat output and new_state
    const int64_t ne[4] = { S * H, n_tokens + S * n_seqs, 1, 1 };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 4, ne);

    wsp_ggml_set_op_params_f32(result, 0, scale);

    result->op     = WSP_GGML_OP_GATED_LINEAR_ATTN;
    result->src[0] = k;
    result->src[1] = v;
    result->src[2] = q;
    result->src[3] = g;
    result->src[4] = state;

    return result;
}

// wsp_ggml_rwkv_wkv7

struct wsp_ggml_tensor * wsp_ggml_rwkv_wkv7(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * r,
        struct wsp_ggml_tensor  * w,
        struct wsp_ggml_tensor  * k,
        struct wsp_ggml_tensor  * v,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        struct wsp_ggml_tensor  * state) {
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(r));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(w));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(k));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(v));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(a));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(b));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(state));

    const int64_t S = k->ne[0];
    const int64_t H = k->ne[1];
    const int64_t n_tokens = k->ne[2];
    const int64_t n_seqs = state->ne[1];
    {
        WSP_GGML_ASSERT(w->ne[0] == S && w->ne[1] == H && w->ne[2] == n_tokens);
        WSP_GGML_ASSERT(k->ne[0] == S && k->ne[1] == H && k->ne[2] == n_tokens);
        WSP_GGML_ASSERT(v->ne[0] == S && v->ne[1] == H && v->ne[2] == n_tokens);
        WSP_GGML_ASSERT(a->ne[0] == S && a->ne[1] == H && a->ne[2] == n_tokens);
        WSP_GGML_ASSERT(b->ne[0] == S && b->ne[1] == H && b->ne[2] == n_tokens);
        WSP_GGML_ASSERT(wsp_ggml_nelements(state) == S * S * H * n_seqs);
    }

    // concat output and new_state
    const int64_t ne[4] = { S * H, n_tokens + S * n_seqs, 1, 1 };
    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, 4, ne);

    result->op     = WSP_GGML_OP_RWKV_WKV7;
    result->src[0] = r;
    result->src[1] = w;
    result->src[2] = k;
    result->src[3] = v;
    result->src[4] = a;
    result->src[5] = b;
    result->src[6] = state;

    return result;
}

// wsp_ggml_unary

static struct wsp_ggml_tensor * wsp_ggml_unary_impl(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        enum wsp_ggml_unary_op    op,
        bool                  inplace) {
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous_1(a));

    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    wsp_ggml_set_op_params_i32(result, 0, (int32_t) op);

    result->op     = WSP_GGML_OP_UNARY;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_unary(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        enum wsp_ggml_unary_op    op) {
    return wsp_ggml_unary_impl(ctx, a, op, false);
}

struct wsp_ggml_tensor * wsp_ggml_unary_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        enum wsp_ggml_unary_op    op) {
    return wsp_ggml_unary_impl(ctx, a, op, true);
}

// wsp_ggml_map_custom1

static struct wsp_ggml_tensor * wsp_ggml_map_custom1_impl(
        struct wsp_ggml_context      * ctx,
        struct wsp_ggml_tensor       * a,
        const  wsp_ggml_custom1_op_t   fun,
        int                        n_tasks,
        void                     * userdata,
        bool                       inplace) {
    WSP_GGML_ASSERT(n_tasks == WSP_GGML_N_TASKS_MAX || n_tasks > 0);

    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    struct wsp_ggml_map_custom1_op_params params = {
        /*.fun      =*/ fun,
        /*.n_tasks  =*/ n_tasks,
        /*.userdata =*/ userdata
    };
    wsp_ggml_set_op_params(result, &params, sizeof(params));

    result->op     = WSP_GGML_OP_MAP_CUSTOM1;
    result->src[0] = a;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_map_custom1(
        struct wsp_ggml_context      * ctx,
        struct wsp_ggml_tensor       * a,
        const  wsp_ggml_custom1_op_t   fun,
        int                        n_tasks,
        void                     * userdata) {
    return wsp_ggml_map_custom1_impl(ctx, a, fun, n_tasks, userdata, false);
}

struct wsp_ggml_tensor * wsp_ggml_map_custom1_inplace(
        struct wsp_ggml_context      * ctx,
        struct wsp_ggml_tensor       * a,
        const  wsp_ggml_custom1_op_t   fun,
        int                        n_tasks,
        void                     * userdata) {
    return wsp_ggml_map_custom1_impl(ctx, a, fun, n_tasks, userdata, true);
}

// wsp_ggml_map_custom2

static struct wsp_ggml_tensor * wsp_ggml_map_custom2_impl(
        struct wsp_ggml_context      * ctx,
        struct wsp_ggml_tensor       * a,
        struct wsp_ggml_tensor       * b,
        const  wsp_ggml_custom2_op_t   fun,
        int                        n_tasks,
        void                     * userdata,
        bool                       inplace) {
    WSP_GGML_ASSERT(n_tasks == WSP_GGML_N_TASKS_MAX || n_tasks > 0);

    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    struct wsp_ggml_map_custom2_op_params params = {
        /*.fun      =*/ fun,
        /*.n_tasks  =*/ n_tasks,
        /*.userdata =*/ userdata
    };
    wsp_ggml_set_op_params(result, &params, sizeof(params));

    result->op     = WSP_GGML_OP_MAP_CUSTOM2;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_map_custom2(
        struct wsp_ggml_context      * ctx,
        struct wsp_ggml_tensor       * a,
        struct wsp_ggml_tensor       * b,
        const  wsp_ggml_custom2_op_t   fun,
        int                        n_tasks,
        void                     * userdata) {
    return wsp_ggml_map_custom2_impl(ctx, a, b, fun, n_tasks, userdata, false);
}

struct wsp_ggml_tensor * wsp_ggml_map_custom2_inplace(
        struct wsp_ggml_context      * ctx,
        struct wsp_ggml_tensor       * a,
        struct wsp_ggml_tensor       * b,
        const  wsp_ggml_custom2_op_t   fun,
        int                        n_tasks,
        void                     * userdata) {
    return wsp_ggml_map_custom2_impl(ctx, a, b, fun, n_tasks, userdata, true);
}

// wsp_ggml_map_custom3

static struct wsp_ggml_tensor * wsp_ggml_map_custom3_impl(
        struct wsp_ggml_context      * ctx,
        struct wsp_ggml_tensor       * a,
        struct wsp_ggml_tensor       * b,
        struct wsp_ggml_tensor       * c,
        const  wsp_ggml_custom3_op_t   fun,
        int                        n_tasks,
        void                     * userdata,
        bool                       inplace) {
    WSP_GGML_ASSERT(n_tasks == WSP_GGML_N_TASKS_MAX || n_tasks > 0);

    struct wsp_ggml_tensor * result = inplace ? wsp_ggml_view_tensor(ctx, a) : wsp_ggml_dup_tensor(ctx, a);

    struct wsp_ggml_map_custom3_op_params params = {
        /*.fun      =*/ fun,
        /*.n_tasks  =*/ n_tasks,
        /*.userdata =*/ userdata
    };
    wsp_ggml_set_op_params(result, &params, sizeof(params));

    result->op     = WSP_GGML_OP_MAP_CUSTOM3;
    result->src[0] = a;
    result->src[1] = b;
    result->src[2] = c;

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_map_custom3(
        struct wsp_ggml_context      * ctx,
        struct wsp_ggml_tensor       * a,
        struct wsp_ggml_tensor       * b,
        struct wsp_ggml_tensor       * c,
        const  wsp_ggml_custom3_op_t   fun,
        int                        n_tasks,
        void                     * userdata) {
    return wsp_ggml_map_custom3_impl(ctx, a, b, c, fun, n_tasks, userdata, false);
}

struct wsp_ggml_tensor * wsp_ggml_map_custom3_inplace(
        struct wsp_ggml_context      * ctx,
        struct wsp_ggml_tensor       * a,
        struct wsp_ggml_tensor       * b,
        struct wsp_ggml_tensor       * c,
        const  wsp_ggml_custom3_op_t   fun,
        int                        n_tasks,
        void                     * userdata) {
    return wsp_ggml_map_custom3_impl(ctx, a, b, c, fun, n_tasks, userdata, true);
}

struct wsp_ggml_tensor * wsp_ggml_custom_4d(
        struct wsp_ggml_context * ctx,
        enum wsp_ggml_type        type,
        int64_t               ne0,
        int64_t               ne1,
        int64_t               ne2,
        int64_t               ne3,
        struct wsp_ggml_tensor ** args,
        int                   n_args,
        wsp_ggml_custom_op_t      fun,
        int                   n_tasks,
        void                * userdata) {

    WSP_GGML_ASSERT(n_args < WSP_GGML_MAX_SRC);

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_4d(ctx, type, ne0, ne1, ne2, ne3);

    struct wsp_ggml_custom_op_params params = {
        /*.fun      =*/ fun,
        /*.n_tasks  =*/ n_tasks,
        /*.userdata =*/ userdata
    };
    wsp_ggml_set_op_params(result, &params, sizeof(params));

    result->op = WSP_GGML_OP_CUSTOM;
    for (int i = 0; i < n_args; i++) {
        result->src[i] = args[i];
    }

    return result;
}

struct wsp_ggml_tensor * wsp_ggml_custom_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor ** args,
        int                   n_args,
        wsp_ggml_custom_op_t      fun,
        int                   n_tasks,
        void                * userdata) {

    WSP_GGML_ASSERT(n_args < WSP_GGML_MAX_SRC - 1);

    struct wsp_ggml_tensor * result = wsp_ggml_view_tensor(ctx, a);

    struct wsp_ggml_custom_op_params params = {
        /*.fun      =*/ fun,
        /*.n_tasks  =*/ n_tasks,
        /*.userdata =*/ userdata
    };
    wsp_ggml_set_op_params(result, &params, sizeof(params));

    result->op = WSP_GGML_OP_CUSTOM;
    result->src[0] = a;
    for (int i = 0; i < n_args; i++) {
        result->src[i + 1] = args[i];
    }

    return result;
}
// wsp_ggml_cross_entropy_loss

struct wsp_ggml_tensor * wsp_ggml_cross_entropy_loss(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b) {
    WSP_GGML_ASSERT(wsp_ggml_are_same_shape(a, b));

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_1d(ctx, a->type, 1);

    result->op     = WSP_GGML_OP_CROSS_ENTROPY_LOSS;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

// wsp_ggml_cross_entropy_loss_back

struct wsp_ggml_tensor * wsp_ggml_cross_entropy_loss_back(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        struct wsp_ggml_tensor  * c) {
    WSP_GGML_ASSERT(wsp_ggml_is_scalar(a));
    WSP_GGML_ASSERT(wsp_ggml_are_same_shape(b, c));

    struct wsp_ggml_tensor * result = wsp_ggml_dup_tensor(ctx, b);

    result->op     = WSP_GGML_OP_CROSS_ENTROPY_LOSS_BACK;
    result->src[0] = a;
    result->src[1] = b;
    result->src[2] = c;

    return result;
}

// opt_step_adamw

struct wsp_ggml_tensor * wsp_ggml_opt_step_adamw(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * grad,
        struct wsp_ggml_tensor  * m,
        struct wsp_ggml_tensor  * v,
        struct wsp_ggml_tensor  * adamw_params) {
    WSP_GGML_ASSERT(a->flags & WSP_GGML_TENSOR_FLAG_PARAM);
    WSP_GGML_ASSERT(wsp_ggml_are_same_shape(a, grad));
    WSP_GGML_ASSERT(wsp_ggml_are_same_shape(a, m));
    WSP_GGML_ASSERT(wsp_ggml_are_same_shape(a, v));
    WSP_GGML_ASSERT(adamw_params->type == WSP_GGML_TYPE_F32);
    WSP_GGML_ASSERT(wsp_ggml_nelements(adamw_params) == 7);

    struct wsp_ggml_tensor * result = wsp_ggml_view_tensor(ctx, a);

    result->op     = WSP_GGML_OP_OPT_STEP_ADAMW;
    result->src[0] = a;
    result->src[1] = grad;
    result->src[2] = m;
    result->src[3] = v;
    result->src[4] = adamw_params;

    return result;
}

// opt_step_sgd

struct wsp_ggml_tensor * wsp_ggml_opt_step_sgd(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * grad,
        struct wsp_ggml_tensor  * params) {
    WSP_GGML_ASSERT(a->flags & WSP_GGML_TENSOR_FLAG_PARAM);
    WSP_GGML_ASSERT(wsp_ggml_are_same_shape(a, grad));
    WSP_GGML_ASSERT(params->type == WSP_GGML_TYPE_F32);
    WSP_GGML_ASSERT(wsp_ggml_nelements(params) == 2);

    struct wsp_ggml_tensor * result = wsp_ggml_view_tensor(ctx, a);

    result->op     = WSP_GGML_OP_OPT_STEP_SGD;
    result->src[0] = a;
    result->src[1] = grad;
    result->src[2] = params;

    return result;
}

// solve_tri

struct wsp_ggml_tensor * wsp_ggml_solve_tri(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        bool                  left,
        bool                  lower,
        bool                  uni) {
    WSP_GGML_ASSERT(a->type == WSP_GGML_TYPE_F32);
    WSP_GGML_ASSERT(b->type == WSP_GGML_TYPE_F32);

    // A must be square and lower diagonal
    WSP_GGML_ASSERT(a->ne[0] == a->ne[1]);
    // B must have same outer dimension as A
    WSP_GGML_ASSERT(a->ne[1] == b->ne[1]);

    // batch dimensions must be equal
    WSP_GGML_ASSERT(a->ne[2] == b->ne[2]);
    WSP_GGML_ASSERT(a->ne[3] == b->ne[3]);

    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(a));
    WSP_GGML_ASSERT(wsp_ggml_is_contiguous(b));

    WSP_GGML_ASSERT(lower && left && !uni); // TODO: support other variants

    struct wsp_ggml_tensor * result = wsp_ggml_new_tensor_4d(ctx, WSP_GGML_TYPE_F32, b->ne[0], b->ne[1], b->ne[2], b->ne[3]);

    result->op     = WSP_GGML_OP_SOLVE_TRI;
    result->src[0] = a;
    result->src[1] = b;

    return result;
}

////////////////////////////////////////////////////////////////////////////////

struct wsp_ggml_hash_set wsp_ggml_hash_set_new(size_t size) {
    size = wsp_ggml_hash_size(size);
    struct wsp_ggml_hash_set result;
    result.size = size;
    result.keys = WSP_GGML_MALLOC(sizeof(struct wsp_ggml_tensor *) * size);
    result.used = WSP_GGML_CALLOC(wsp_ggml_bitset_size(size), sizeof(wsp_ggml_bitset_t));
    return result;
}

void wsp_ggml_hash_set_reset(struct wsp_ggml_hash_set * hash_set) {
    memset(hash_set->used, 0, sizeof(wsp_ggml_bitset_t) * wsp_ggml_bitset_size(hash_set->size));
}

void wsp_ggml_hash_set_free(struct wsp_ggml_hash_set * hash_set) {
    WSP_GGML_FREE(hash_set->used);
    WSP_GGML_FREE(hash_set->keys);
}

size_t wsp_ggml_hash_size(size_t min_sz) {
    // next primes after powers of two
    static const size_t primes[] = {
        2, 3, 5, 11, 17, 37, 67, 131, 257, 521, 1031,
        2053, 4099, 8209, 16411, 32771, 65537, 131101,
        262147, 524309, 1048583, 2097169, 4194319, 8388617,
        16777259, 33554467, 67108879, 134217757, 268435459,
        536870923, 1073741827, 2147483659
    };
    static const size_t n_primes = sizeof(primes)/sizeof(primes[0]);

    // find the smallest prime that is larger or equal than min_sz
    size_t l = 0;
    size_t r = n_primes;
    while (l < r) {
        size_t m = (l + r)/2;
        if (primes[m] < min_sz) {
            l = m + 1;
        } else {
            r = m;
        }
    }
    size_t sz = l < n_primes ? primes[l] : min_sz | 1;
    return sz;
}

struct hash_map {
    struct wsp_ggml_hash_set set;
    struct wsp_ggml_tensor ** vals;
};

static struct hash_map * wsp_ggml_new_hash_map(size_t size) {
    struct hash_map * result = WSP_GGML_MALLOC(sizeof(struct hash_map));
    result->set = wsp_ggml_hash_set_new(size);
    result->vals = WSP_GGML_CALLOC(result->set.size, sizeof(struct wsp_ggml_tensor *));
    return result;
}

static void wsp_ggml_hash_map_free(struct hash_map * map) {
    wsp_ggml_hash_set_free(&map->set);
    WSP_GGML_FREE(map->vals);
    WSP_GGML_FREE(map);
}

// utility functions to change gradients
// isrc is the index of tensor in cgraph->visited_has_set.keys
// the corresponding gradient (accumulators) are also at position isrc
// if tensor has a gradient accumulator, modify that accumulator in-place
// else if there is no gradient for tensor, set the corresponding value
// else, just add/subtract/etc. the gradients

static void wsp_ggml_add_or_set(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_cgraph  * cgraph,
        size_t                isrc,
        struct wsp_ggml_tensor  * tensor) {
    struct wsp_ggml_tensor * src = cgraph->visited_hash_set.keys[isrc];
    WSP_GGML_ASSERT(src);
    if (cgraph->grads[isrc]) {
        cgraph->grads[isrc] = wsp_ggml_add_impl(ctx, cgraph->grads[isrc], tensor, /*inplace =*/ cgraph->grad_accs[isrc]);
    } else {
        cgraph->grads[isrc] = tensor;
    }
    wsp_ggml_format_name(cgraph->grads[isrc], "grad for %s", src->name);
    wsp_ggml_build_forward_expand(cgraph, cgraph->grads[isrc]);
}

static void wsp_ggml_acc_or_set(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_cgraph  * cgraph,
        size_t                isrc,
        struct wsp_ggml_tensor  * tensor,
        const  size_t         nb1,
        const  size_t         nb2,
        const  size_t         nb3,
        const  size_t         offset) {
    struct wsp_ggml_tensor * src = cgraph->visited_hash_set.keys[isrc];
    WSP_GGML_ASSERT(src);
    if (cgraph->grads[isrc]) {
        cgraph->grads[isrc] = wsp_ggml_acc_impl(ctx, cgraph->grads[isrc], tensor, nb1, nb2, nb3, offset, cgraph->grad_accs[isrc]);
    } else {
        struct wsp_ggml_tensor * a_zero = wsp_ggml_scale(ctx, src, 0.0f); // FIXME this is going to produce NaN if a contains inf/NaN
        cgraph->grads[isrc] = wsp_ggml_acc_impl(ctx, a_zero, tensor, nb1, nb2, nb3, offset, false);
    }
    wsp_ggml_format_name(cgraph->grads[isrc], "grad for %s", cgraph->visited_hash_set.keys[isrc]->name);
    wsp_ggml_build_forward_expand(cgraph, cgraph->grads[isrc]);
}

static void wsp_ggml_add1_or_set(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_cgraph  * cgraph,
        size_t                isrc,
        struct wsp_ggml_tensor  * tensor) {
    struct wsp_ggml_tensor * src = cgraph->visited_hash_set.keys[isrc];
    WSP_GGML_ASSERT(src);
    if (cgraph->grads[isrc]) {
        cgraph->grads[isrc] = wsp_ggml_add1_impl(ctx, cgraph->grads[isrc], tensor, cgraph->grad_accs[isrc]);
    } else {
        cgraph->grads[isrc] = wsp_ggml_repeat(ctx, tensor, src);
    }
    wsp_ggml_format_name(cgraph->grads[isrc], "grad for %s", src->name);
    wsp_ggml_build_forward_expand(cgraph, cgraph->grads[isrc]);
}

static void wsp_ggml_sub_or_set(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_cgraph  * cgraph,
        size_t                isrc,
        struct wsp_ggml_tensor  * tensor) {
    struct wsp_ggml_tensor * src = cgraph->visited_hash_set.keys[isrc];
    WSP_GGML_ASSERT(src);
    if (cgraph->grads[isrc]) {
        cgraph->grads[isrc] = wsp_ggml_sub_impl(ctx, cgraph->grads[isrc], tensor, cgraph->grad_accs[isrc]);
    } else {
        cgraph->grads[isrc] = wsp_ggml_neg(ctx, tensor);
    }
    wsp_ggml_format_name(cgraph->grads[isrc], "grad for %s", src->name);
    wsp_ggml_build_forward_expand(cgraph, cgraph->grads[isrc]);
}

static void wsp_ggml_compute_backward(
        struct wsp_ggml_context * ctx, struct wsp_ggml_cgraph * cgraph, int i, const bool * grads_needed) {
    struct wsp_ggml_tensor * tensor = cgraph->nodes[i];
    struct wsp_ggml_tensor * grad   = wsp_ggml_graph_get_grad(cgraph, tensor);

    if (!grad) {
        return;
    }

    struct wsp_ggml_tensor * src0 = tensor->src[0];
    struct wsp_ggml_tensor * src1 = tensor->src[1];
    struct wsp_ggml_tensor * src2 = tensor->src[2];
    struct wsp_ggml_hash_set * hash_set = &cgraph->visited_hash_set;
    const size_t isrc0 = src0 ? wsp_ggml_hash_find(hash_set, src0) : (size_t) -1;
    const size_t isrc1 = src1 ? wsp_ggml_hash_find(hash_set, src1) : (size_t) -1;
    const size_t isrc2 = src2 ? wsp_ggml_hash_find(hash_set, src2) : (size_t) -1;
    const bool src0_needs_grads = src0 && isrc0 != WSP_GGML_HASHSET_FULL && wsp_ggml_bitset_get(hash_set->used, isrc0) && grads_needed[isrc0];
    const bool src1_needs_grads = src1 && isrc1 != WSP_GGML_HASHSET_FULL && wsp_ggml_bitset_get(hash_set->used, isrc1) && grads_needed[isrc1];
    const bool src2_needs_grads = src2 && isrc2 != WSP_GGML_HASHSET_FULL && wsp_ggml_bitset_get(hash_set->used, isrc2) && grads_needed[isrc2];

    switch (tensor->op) {
        case WSP_GGML_OP_DUP: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, grad);
            }
        } break;
        case WSP_GGML_OP_ADD: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, grad);
            }
            if (src1_needs_grads) {
                struct wsp_ggml_tensor * tmp = grad;
                if (!wsp_ggml_are_same_shape(src0, src1)) {
                    tmp = wsp_ggml_repeat_back(ctx, tmp, src1);
                }
                wsp_ggml_add_or_set(ctx, cgraph, isrc1, tmp);
            }
        } break;
        case WSP_GGML_OP_ADD1: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, grad);
            }
            if (src1_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc1, wsp_ggml_mean(ctx, grad)); // TODO: should probably be sum instead of mean
            }
        } break;
        case WSP_GGML_OP_ACC: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, grad);
            }
            if (src1_needs_grads) {
                const size_t nb1    = ((int32_t *) tensor->op_params)[0];
                const size_t nb2    = ((int32_t *) tensor->op_params)[1];
                const size_t nb3    = ((int32_t *) tensor->op_params)[2];
                const size_t offset = ((int32_t *) tensor->op_params)[3];

                struct wsp_ggml_tensor * tensor_grad_view = wsp_ggml_view_4d(ctx,
                    grad, src1->ne[0], src1->ne[1], src1->ne[2], src1->ne[3],
                    nb1, nb2, nb3, offset);

                wsp_ggml_add_or_set(ctx, cgraph, isrc1, wsp_ggml_reshape(ctx, wsp_ggml_cont(ctx, tensor_grad_view), src1));
            }
        } break;
        case WSP_GGML_OP_SUB: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, grad);
            }
            if (src1_needs_grads) {
                wsp_ggml_sub_or_set(ctx, cgraph, isrc1, grad);
            }
        } break;
        case WSP_GGML_OP_MUL: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_mul(ctx, grad, src1));
            }
            if (src1_needs_grads) {
                struct wsp_ggml_tensor * tmp = wsp_ggml_mul(ctx, src0, grad);
                if (!wsp_ggml_are_same_shape(src0, src1)) {
                    tmp = wsp_ggml_repeat_back(ctx, tmp, src1);
                }
                wsp_ggml_add_or_set(ctx, cgraph, isrc1, tmp);
            }
        } break;
        case WSP_GGML_OP_DIV: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_div(ctx, grad, src1));
            }
            if (src1_needs_grads) {
                wsp_ggml_sub_or_set(ctx, cgraph, isrc1, wsp_ggml_mul(ctx, grad, wsp_ggml_div(ctx, tensor, src1)));
            }
        } break;
        case WSP_GGML_OP_SQR: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_scale(ctx, wsp_ggml_mul(ctx, src0, grad), 2.0f));
            }
        } break;
        case WSP_GGML_OP_SQRT: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_scale(ctx, wsp_ggml_div(ctx, grad, tensor), 0.5f));
            }
        } break;
        case WSP_GGML_OP_LOG: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_div(ctx, grad, src0));
            }
        } break;
        case WSP_GGML_OP_SIN: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_mul(ctx, grad, wsp_ggml_cos(ctx, src0)));
            }
        } break;
        case WSP_GGML_OP_COS: {
            if (src0_needs_grads) {
                wsp_ggml_sub_or_set(ctx, cgraph, isrc0, wsp_ggml_mul(ctx, grad, wsp_ggml_sin(ctx, src0)));
            }
        } break;
        case WSP_GGML_OP_SUM: {
            if (src0_needs_grads) {
                wsp_ggml_add1_or_set(ctx, cgraph, isrc0, grad);
            }
        } break;
        case WSP_GGML_OP_SUM_ROWS: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_repeat(ctx, grad, src0));
            }
        } break;
        case WSP_GGML_OP_MEAN: {
            if (src0_needs_grads) {
                wsp_ggml_add1_or_set(ctx, cgraph, isrc0, wsp_ggml_scale_impl(ctx, grad, 1.0f/src0->ne[0], 0.0, false));
            }
        } break;
        case WSP_GGML_OP_REPEAT: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_repeat_back(ctx, grad, src0));
            }
        } break;
        case WSP_GGML_OP_REPEAT_BACK: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_repeat(ctx, grad, src0));
            }
        } break;
        case WSP_GGML_OP_RMS_NORM: {
            if (src0_needs_grads) {
                float eps;
                memcpy(&eps, tensor->op_params, sizeof(float));
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_rms_norm_back(ctx, grad, src0, eps));
            }
        } break;
        case WSP_GGML_OP_MUL_MAT: {
            // https://cs231n.github.io/optimization-2/#staged
            // # forward pass
            // s0 = np.random.randn(5, 10)
            // s1 = np.random.randn(10, 3)
            // t = s0.dot(s1)

            // # now suppose we had the gradient on t from above in the circuit
            // dt = np.random.randn(*t.shape) # same shape as t
            // ds0 = dt.dot(s1.T) #.T gives the transpose of the matrix
            // ds1 = t.T.dot(dt)

            // tensor.shape [m,p,qq,rr]
            // src0.shape   [n,m,q1,r1]
            // src1.shape   [n,p,qq,rr]

            if (src0_needs_grads) {
                WSP_GGML_ASSERT(grad->ne[2] == src1->ne[2]);
                WSP_GGML_ASSERT(grad->ne[3] == src1->ne[3]);
                struct wsp_ggml_tensor * tmp =
                    wsp_ggml_out_prod(ctx, // [n,m,qq,rr]
                        src1,          // [n,p,qq,rr]
                        grad);         // [m,p,qq,rr]
                if (!wsp_ggml_are_same_shape(tmp, src0)) {
                    WSP_GGML_ASSERT(tmp->ne[0] == src0->ne[0]);
                    WSP_GGML_ASSERT(tmp->ne[1] == src0->ne[1]);
                    WSP_GGML_ASSERT(tmp->ne[3] == 1);

                    const int64_t nr2 = tmp->ne[2] / src0->ne[2];
                    const size_t nb2 = tmp->nb[2] * nr2;
                    const size_t nb3 = tmp->nb[2];

                    tmp = wsp_ggml_view_4d(ctx, tmp, src0->ne[0], src0->ne[1], src0->ne[2], nr2, tmp->nb[1], nb2, nb3, 0);
                    tmp = wsp_ggml_repeat_back(ctx, tmp, src0);
                }
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, tmp);
            }
            if (src1_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc1,
                        // wsp_ggml_mul_mat(ctx,                   // [n,p,qq,rr]
                        //     wsp_ggml_cont(ctx,                  // [m,n,q1,r1]
                        //         wsp_ggml_transpose(ctx, src0)), // [m,n,q1,r1]
                        //     grad),                          // [m,p,qq,rr]

                        // when src0 is bigger than tensor->grad (this is mostly the case in llama),
                        // avoid transpose of src0, rather transpose smaller tensor->grad
                        // and then use wsp_ggml_out_prod
                        wsp_ggml_out_prod(ctx,      // [n,p,qq,rr]
                            src0,               // [n,m,q1,r1]
                            wsp_ggml_transpose(ctx, // [p,m,qq,rr]
                                grad)));        // [m,p,qq,rr]
            }
        } break;
        case WSP_GGML_OP_SCALE: {
            if (src0_needs_grads) {
                float s;
                memcpy(&s, tensor->op_params, sizeof(float));
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_scale_impl(ctx, grad, s, 0.0, false));
            }
        } break;
        case WSP_GGML_OP_SET: {
            const size_t nb1    = ((const int32_t *) tensor->op_params)[0];
            const size_t nb2    = ((const int32_t *) tensor->op_params)[1];
            const size_t nb3    = ((const int32_t *) tensor->op_params)[2];
            const size_t offset = ((const int32_t *) tensor->op_params)[3];

            struct wsp_ggml_tensor * tensor_grad_view = NULL;

            if (src0_needs_grads || src1_needs_grads) {
                WSP_GGML_ASSERT(src0->type == tensor->type);
                WSP_GGML_ASSERT(!cgraph->grads[isrc0] ||                      cgraph->grads[isrc0]->type == grad->type);
                WSP_GGML_ASSERT(!cgraph->grads[isrc1] || !src1_needs_grads || cgraph->grads[isrc1]->type == grad->type);

                tensor_grad_view = wsp_ggml_view_4d(ctx,
                    grad, src1->ne[0], src1->ne[1], src1->ne[2], src1->ne[3],
                    nb1, nb2, nb3, offset);
            }

            if (src0_needs_grads) {
                struct wsp_ggml_tensor * tmp = wsp_ggml_neg(ctx, tensor_grad_view);
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_acc_impl(ctx, grad, tmp, nb1, nb2, nb3, offset, false));
            }

            if (src1_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc1, wsp_ggml_reshape(ctx, wsp_ggml_cont(ctx, tensor_grad_view), src1));
            }
        } break;
        case WSP_GGML_OP_CPY: {
            // cpy overwrites value of src1 by src0 and returns view(src1)
            // the overwriting is mathematically equivalent to:
            // tensor = src0 * 1 + src1 * 0
            if (src0_needs_grads) {
                // dsrc0 = dtensor * 1
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_reshape(ctx, grad, src0));
            }
            if (src1_needs_grads) {
                // dsrc1 = dtensor * 0 -> noop
            }
        } break;
        case WSP_GGML_OP_CONT: {
            // same as cpy
            if (src0_needs_grads) {
                WSP_GGML_ASSERT(!cgraph->grads[isrc0] || wsp_ggml_is_contiguous(cgraph->grads[isrc0]));
                WSP_GGML_ASSERT(wsp_ggml_is_contiguous(grad));
                WSP_GGML_ASSERT(wsp_ggml_nelements(tensor) == wsp_ggml_nelements(src0));
                wsp_ggml_add_or_set(ctx, cgraph, isrc0,
                    wsp_ggml_are_same_shape(tensor, src0) ? grad : wsp_ggml_reshape(ctx, grad, src0));
            }
        } break;
        case WSP_GGML_OP_RESHAPE: {
            if (src0_needs_grads) {
                struct wsp_ggml_tensor * grad_cont = wsp_ggml_is_contiguous(grad) ? grad : wsp_ggml_cont(ctx, grad);
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_reshape(ctx, grad_cont, src0));
            }
        } break;
        case WSP_GGML_OP_VIEW: {
            if (src0_needs_grads) {
                size_t offset;

                memcpy(&offset, tensor->op_params, sizeof(offset));

                size_t nb1 = tensor->nb[1];
                size_t nb2 = tensor->nb[2];
                size_t nb3 = tensor->nb[3];

                if (cgraph->grads[isrc0] && src0->type != cgraph->grads[isrc0]->type) {
                    // gradient is typically F32, but src0 could be other type
                    size_t ng = wsp_ggml_element_size(cgraph->grads[isrc0]);
                    size_t n0 = wsp_ggml_element_size(src0);
                    WSP_GGML_ASSERT(offset % n0 == 0);
                    WSP_GGML_ASSERT(nb1 % n0 == 0);
                    WSP_GGML_ASSERT(nb2 % n0 == 0);
                    WSP_GGML_ASSERT(nb3 % n0 == 0);
                    offset = (offset / n0) * ng;
                    nb1 = (nb1 / n0) * ng;
                    nb2 = (nb2 / n0) * ng;
                    nb3 = (nb3 / n0) * ng;
                }

                wsp_ggml_acc_or_set(ctx, cgraph, isrc0, grad, nb1, nb2, nb3, offset);
            }
        } break;
        case WSP_GGML_OP_PERMUTE: {
            if (src0_needs_grads) {
                const int32_t * axes = (const int32_t *) tensor->op_params;
                const int axis0 = axes[0] & 0x3;
                const int axis1 = axes[1] & 0x3;
                const int axis2 = axes[2] & 0x3;
                const int axis3 = axes[3] & 0x3;
                int axb[4] = {0,0,0,0}; // axes backward
                axb[axis0] = 0;
                axb[axis1] = 1;
                axb[axis2] = 2;
                axb[axis3] = 3;
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_permute(ctx, grad, axb[0], axb[1], axb[2], axb[3]));
            }
        } break;
        case WSP_GGML_OP_TRANSPOSE: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_transpose(ctx, grad));
            }
        } break;
        case WSP_GGML_OP_GET_ROWS: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_get_rows_back(ctx, grad, src1, src0));
            }
            if (src1_needs_grads) {
                // noop
            }
        } break;
        case WSP_GGML_OP_DIAG_MASK_INF: {
            if (src0_needs_grads) {
                /* wsp_ggml_diag_mask_inf_impl() shouldn't be here */
                /* ref:  https://github.com/ggerganov/llama.cpp/pull/4203#discussion_r1412377992 */
                const int n_past = ((const int32_t *) tensor->op_params)[0];
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_diag_mask_zero_impl(ctx, grad, n_past, false));
            }
        } break;
        case WSP_GGML_OP_DIAG_MASK_ZERO: {
            if (src0_needs_grads) {
                const int n_past = ((const int32_t *) tensor->op_params)[0];
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_diag_mask_zero_impl(ctx, grad, n_past, false));
            }
        } break;
        case WSP_GGML_OP_SOFT_MAX: {
            if (src0_needs_grads) {
                float scale    = 1.0f;
                float max_bias = 0.0f;

                memcpy(&scale,    (const float *) tensor->op_params + 0, sizeof(float));
                memcpy(&max_bias, (const float *) tensor->op_params + 1, sizeof(float));

                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_soft_max_ext_back(ctx, grad, tensor, scale, max_bias));
            }
            WSP_GGML_ASSERT((!src1 || !src1_needs_grads) && "backward pass for softmax mask not implemented");
        } break;
        case WSP_GGML_OP_ROPE: {
            if (src0_needs_grads) {
                //const int n_past = ((int32_t *) tensor->op_params)[0];
                const int n_dims     = ((const int32_t *) tensor->op_params)[1];
                const int mode       = ((const int32_t *) tensor->op_params)[2];
                //const int n_ctx      = ((int32_t *) tensor->op_params)[3];
                const int n_ctx_orig = ((const int32_t *) tensor->op_params)[4];
                float freq_base, freq_scale, ext_factor, attn_factor, beta_fast, beta_slow;
                int sections[4] = {0, 0, 0, 0};

                memcpy(&freq_base,   (const float *) tensor->op_params +  5, sizeof(float));
                memcpy(&freq_scale,  (const float *) tensor->op_params +  6, sizeof(float));
                memcpy(&ext_factor,  (const float *) tensor->op_params +  7, sizeof(float));
                memcpy(&attn_factor, (const float *) tensor->op_params +  8, sizeof(float));
                memcpy(&beta_fast,   (const float *) tensor->op_params +  9, sizeof(float));
                memcpy(&beta_slow,   (const float *) tensor->op_params + 10, sizeof(float));
                memcpy(&sections,                    tensor->op_params + 11, sizeof(sections));

                struct wsp_ggml_tensor * rope_back = grad->ne[2] == src1->ne[0] ?
                    wsp_ggml_rope_ext_back(ctx, grad, src1, src2, n_dims,
                        mode, n_ctx_orig, freq_base, freq_scale, ext_factor, attn_factor, beta_fast, beta_slow) :
                    wsp_ggml_rope_multi_back(ctx, grad, src1, src2, n_dims, sections,
                        mode, n_ctx_orig, freq_base, freq_scale, ext_factor, attn_factor, beta_fast, beta_slow);
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, rope_back);
            }
            WSP_GGML_ASSERT((!src2 || !src2_needs_grads) && "gradients for freq factors not implemented");
        } break;
        case WSP_GGML_OP_IM2COL: {
            if (src1_needs_grads) {
                const int32_t s0    = wsp_ggml_get_op_params_i32(tensor, 0);
                const int32_t s1    = wsp_ggml_get_op_params_i32(tensor, 1);
                const int32_t p0    = wsp_ggml_get_op_params_i32(tensor, 2);
                const int32_t p1    = wsp_ggml_get_op_params_i32(tensor, 3);
                const int32_t d0    = wsp_ggml_get_op_params_i32(tensor, 4);
                const int32_t d1    = wsp_ggml_get_op_params_i32(tensor, 5);
                const bool    is_2D = wsp_ggml_get_op_params_i32(tensor, 6) == 1;

                wsp_ggml_add_or_set(ctx, cgraph, isrc1, wsp_ggml_im2col_back(ctx, grad, src0, src1->ne, s0, s1, p0, p1, d0, d1, is_2D));
            }
        } break;
        case WSP_GGML_OP_POOL_2D: {
            if (src0_needs_grads) {
                const enum wsp_ggml_op_pool op = wsp_ggml_get_op_params_i32(tensor, 0);
                const      int32_t      k0 = wsp_ggml_get_op_params_i32(tensor, 1);
                const      int32_t      k1 = wsp_ggml_get_op_params_i32(tensor, 2);
                const      int32_t      s0 = wsp_ggml_get_op_params_i32(tensor, 3);
                const      int32_t      s1 = wsp_ggml_get_op_params_i32(tensor, 4);
                const      int32_t      p0 = wsp_ggml_get_op_params_i32(tensor, 5);
                const      int32_t      p1 = wsp_ggml_get_op_params_i32(tensor, 6);

                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_pool_2d_back(ctx, grad, src0, op, k0, k1, s0, s1, p0, p1));
            }
        } break;
        case WSP_GGML_OP_WIN_PART:
        case WSP_GGML_OP_WIN_UNPART:
        case WSP_GGML_OP_UNARY: {
            switch (wsp_ggml_get_unary_op(tensor)) {
                case WSP_GGML_UNARY_OP_ABS: {
                    if (src0_needs_grads) {
                        wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_mul(ctx, wsp_ggml_sgn(ctx, src0), grad));
                    }
                } break;
                case WSP_GGML_UNARY_OP_SGN: {
                    // noop
                } break;
                case WSP_GGML_UNARY_OP_NEG: {
                    if (src0_needs_grads) {
                        wsp_ggml_sub_or_set(ctx, cgraph, isrc0, grad);
                    }
                } break;
                case WSP_GGML_UNARY_OP_STEP: {
                    // noop
                } break;
                case WSP_GGML_UNARY_OP_RELU: {
                    if (src0_needs_grads) {
                        wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_mul(ctx, wsp_ggml_step(ctx, src0), grad));
                    }
                } break;
                case WSP_GGML_UNARY_OP_SILU: {
                    if (src0_needs_grads) {
                        wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_silu_back(ctx, grad, src0));
                    }
                } break;
                case WSP_GGML_UNARY_OP_EXP: {
                    if (src0_needs_grads) {
                        wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_mul(ctx, tensor, grad));
                    }
                } break;
                case WSP_GGML_UNARY_OP_EXPM1: {
                    if (src0_needs_grads) {
                        wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_mul(ctx, grad, wsp_ggml_exp(ctx, src0)));
                    }
                } break;
                case WSP_GGML_UNARY_OP_SOFTPLUS: {
                    if (src0_needs_grads) {
                        wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_mul(ctx, grad, wsp_ggml_sigmoid(ctx, src0)));
                    }
                } break;
                default: {
                    fprintf(stderr, "%s: unsupported unary op for backward pass: %s\n",
                        __func__, wsp_ggml_unary_op_name(wsp_ggml_get_unary_op(tensor)));
                    WSP_GGML_ABORT("fatal error");
                } //break;
            }
        } break;
        case WSP_GGML_OP_CROSS_ENTROPY_LOSS: {
            if (src0_needs_grads) {
                wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_cross_entropy_loss_back(ctx, grad, src0, src1));
            }
            WSP_GGML_ASSERT(!src1_needs_grads && "backward pass for labels not implemented");
        } break;
        case WSP_GGML_OP_GLU: {
            switch (wsp_ggml_get_glu_op(tensor)) {
                case WSP_GGML_GLU_OP_SWIGLU: {
                    if (src0_needs_grads) {
                        WSP_GGML_ASSERT(src1 && "backward pass only implemented for split swiglu");
                        wsp_ggml_add_or_set(ctx, cgraph, isrc0, wsp_ggml_silu_back(ctx, wsp_ggml_mul(ctx, grad, src1), src0));
                    }
                    if (src1_needs_grads) {
                        wsp_ggml_add_or_set(ctx, cgraph, isrc1, wsp_ggml_mul(ctx, wsp_ggml_silu(ctx, src0), grad));
                    }
                } break;
                default: {
                    WSP_GGML_ABORT("unsupported glu op for backward pass: %s", wsp_ggml_glu_op_name(wsp_ggml_get_glu_op(tensor)));
                } //break;
            }
        } break;
        case WSP_GGML_OP_NONE: {
            // noop
        } break;
        case WSP_GGML_OP_COUNT:
        default: {
            WSP_GGML_ABORT("%s: unsupported ggml op for backward pass: %s\n", __func__, wsp_ggml_op_name(tensor->op));
        } //break;
    }

    WSP_GGML_ASSERT(!src0_needs_grads || wsp_ggml_are_same_shape(src0, cgraph->grads[isrc0]));
    WSP_GGML_ASSERT(!src1_needs_grads || wsp_ggml_are_same_shape(src1, cgraph->grads[isrc1]));
    WSP_GGML_ASSERT(!src2_needs_grads || wsp_ggml_are_same_shape(src2, cgraph->grads[isrc2]));
}

static size_t wsp_ggml_visit_parents(struct wsp_ggml_cgraph * cgraph, struct wsp_ggml_tensor * node) {
    // check if already visited
    size_t node_hash_pos = wsp_ggml_hash_find(&cgraph->visited_hash_set, node);
    WSP_GGML_ASSERT(node_hash_pos != WSP_GGML_HASHSET_FULL);
    if (!wsp_ggml_bitset_get(cgraph->visited_hash_set.used, node_hash_pos)) {
        // This is the first time we see this node in the current graph.
        cgraph->visited_hash_set.keys[node_hash_pos] = node;
        wsp_ggml_bitset_set(cgraph->visited_hash_set.used, node_hash_pos);
        cgraph->use_counts[node_hash_pos] = 0;
    } else {
        // already visited
        return node_hash_pos;
    }

    for (int i = 0; i < WSP_GGML_MAX_SRC; ++i) {
        const int k =
            (cgraph->order == WSP_GGML_CGRAPH_EVAL_ORDER_LEFT_TO_RIGHT) ? i :
            (cgraph->order == WSP_GGML_CGRAPH_EVAL_ORDER_RIGHT_TO_LEFT) ? (WSP_GGML_MAX_SRC-1-i) :
            /* unknown order, just fall back to using i */ i;

        struct wsp_ggml_tensor * src = node->src[k];
        if (src) {
            size_t src_hash_pos = wsp_ggml_visit_parents(cgraph, src);

            // Update the use count for this operand.
            cgraph->use_counts[src_hash_pos]++;
        }
    }

    if (node->op == WSP_GGML_OP_NONE && !(node->flags & WSP_GGML_TENSOR_FLAG_PARAM)) {
        // reached a leaf node, not part of the gradient graph (e.g. a constant)
        WSP_GGML_ASSERT(cgraph->n_leafs < cgraph->size);

        if (strlen(node->name) == 0) {
            wsp_ggml_format_name(node, "leaf_%d", cgraph->n_leafs);
        }

        cgraph->leafs[cgraph->n_leafs] = node;
        cgraph->n_leafs++;
    } else {
        WSP_GGML_ASSERT(cgraph->n_nodes < cgraph->size);

        if (strlen(node->name) == 0) {
            wsp_ggml_format_name(node, "node_%d", cgraph->n_nodes);
        }

        cgraph->nodes[cgraph->n_nodes] = node;
        cgraph->n_nodes++;
    }

    return node_hash_pos;
}

static void wsp_ggml_build_forward_impl(struct wsp_ggml_cgraph * cgraph, struct wsp_ggml_tensor * tensor, bool expand) {
    if (!expand) {
        // TODO: this branch isn't accessible anymore, maybe move this to wsp_ggml_build_forward_expand
        wsp_ggml_graph_clear(cgraph);
    }

    const int n0 = cgraph->n_nodes;

    wsp_ggml_visit_parents(cgraph, tensor);

    const int n_new = cgraph->n_nodes - n0;
    WSP_GGML_PRINT_DEBUG("%s: visited %d new nodes\n", __func__, n_new);

    if (n_new > 0) {
        // the last added node should always be starting point
        WSP_GGML_ASSERT(cgraph->nodes[cgraph->n_nodes - 1] == tensor);
    }
}

void wsp_ggml_build_forward_expand(struct wsp_ggml_cgraph * cgraph, struct wsp_ggml_tensor * tensor) {
    wsp_ggml_build_forward_impl(cgraph, tensor, true);
}

void wsp_ggml_build_backward_expand(
        struct wsp_ggml_context *  ctx,
        struct wsp_ggml_cgraph  *  cgraph,
        struct wsp_ggml_tensor  ** grad_accs) {
    WSP_GGML_ASSERT(cgraph->n_nodes > 0);
    WSP_GGML_ASSERT(cgraph->grads);
    WSP_GGML_ASSERT(cgraph->grad_accs);

    const int n_nodes_f = cgraph->n_nodes;

    memset(cgraph->grads,     0, cgraph->visited_hash_set.size*sizeof(struct wsp_ggml_tensor *));
    memset(cgraph->grad_accs, 0, cgraph->visited_hash_set.size*sizeof(struct wsp_ggml_tensor *));
    bool * grads_needed = calloc(cgraph->visited_hash_set.size, sizeof(bool));

    {
        bool any_params = false;
        bool any_loss   = false;
        for (int i = 0; i < n_nodes_f; ++i) {
            struct wsp_ggml_tensor * node = cgraph->nodes[i];
            any_params = any_params || (node->flags & WSP_GGML_TENSOR_FLAG_PARAM);
            any_loss   = any_loss   || (node->flags & WSP_GGML_TENSOR_FLAG_LOSS);
        }
        WSP_GGML_ASSERT(any_params && "no trainable parameters found, did you forget to call wsp_ggml_set_param?");
        WSP_GGML_ASSERT(any_loss && "no training loss found, did you forget to call wsp_ggml_set_loss?");
    }

    for (int i = 0; i < n_nodes_f; ++i) {
        struct wsp_ggml_tensor * node = cgraph->nodes[i];

        if (node->type == WSP_GGML_TYPE_I32) {
            continue;
        }

        bool node_needs_grad = (node->flags & WSP_GGML_TENSOR_FLAG_PARAM) || (node->flags & WSP_GGML_TENSOR_FLAG_LOSS);
        bool ignore_src[WSP_GGML_MAX_SRC] = {false};
        switch (node->op) {
            // gradients in node->src[0] for one reason or another have no effect on output gradients
            case WSP_GGML_OP_IM2COL:      // only used for its shape
            case WSP_GGML_OP_IM2COL_BACK: // same as IM2COL
                ignore_src[0] = true;
                break;
            case WSP_GGML_OP_UNARY: {
                const enum wsp_ggml_unary_op uop = wsp_ggml_get_unary_op(node);
                // SGN and STEP unary ops are piecewise constant
                if (uop == WSP_GGML_UNARY_OP_SGN || uop == WSP_GGML_UNARY_OP_STEP) {
                    ignore_src[0] = true;
                }
            } break;

            // gradients in node->src[1] for one reason or another have no effect on output gradients
            case WSP_GGML_OP_CPY:           // gradients in CPY target are irrelevant
            case WSP_GGML_OP_GET_ROWS:      // row indices not differentiable
            case WSP_GGML_OP_GET_ROWS_BACK: // same as for GET_ROWS
            case WSP_GGML_OP_ROPE:          // positions not differentiable
                ignore_src[1] = true;
                break;

            default:
                break;
        }
        for (int j = 0; j < WSP_GGML_MAX_SRC; ++j) {
            if (!node->src[j] || ignore_src[j] || !grads_needed[wsp_ggml_hash_find(&cgraph->visited_hash_set, node->src[j])]) {
                continue;
            }
            WSP_GGML_ASSERT(node->src[j]->type == WSP_GGML_TYPE_F32 || node->src[j]->type == WSP_GGML_TYPE_F16);
            node_needs_grad = true;
            break;
        }
        if (!node_needs_grad) {
            continue;
        }

        // inplace operations are currently not supported
        WSP_GGML_ASSERT(!node->view_src || node->op == WSP_GGML_OP_CPY || node->op == WSP_GGML_OP_VIEW ||
            node->op == WSP_GGML_OP_RESHAPE || node->op == WSP_GGML_OP_PERMUTE || node->op == WSP_GGML_OP_TRANSPOSE);

        const size_t ihash = wsp_ggml_hash_find(&cgraph->visited_hash_set, node);
        WSP_GGML_ASSERT(ihash != WSP_GGML_HASHSET_FULL);
        WSP_GGML_ASSERT(wsp_ggml_bitset_get(cgraph->visited_hash_set.used, ihash));
        if (grad_accs && grad_accs[i]) {
            cgraph->grad_accs[ihash] = grad_accs[i];
            cgraph->grads[ihash]     = cgraph->grad_accs[ihash];
        } else if (node->flags & WSP_GGML_TENSOR_FLAG_LOSS) {
            // loss tensors always need a gradient accumulator
            cgraph->grad_accs[ihash] = wsp_ggml_new_tensor(ctx, WSP_GGML_TYPE_F32, WSP_GGML_MAX_DIMS, node->ne);
            cgraph->grads[ihash]     = cgraph->grad_accs[ihash];
        }
        grads_needed[ihash] = true;
    }

    for (int i = n_nodes_f - 1; i >= 0; --i) {
        // inplace operations to add gradients are not created by wsp_ggml_compute_backward except for gradient accumulation
        // use allocator to automatically make inplace operations
        wsp_ggml_compute_backward(ctx, cgraph, i, grads_needed);
    }

    free(grads_needed);
}

static void * incr_ptr_aligned(void ** p, size_t size, size_t align) {
    void * ptr = *p;
    ptr = (void *) WSP_GGML_PAD((uintptr_t) ptr, align);
    *p = (void *) ((char *) ptr + size);
    return ptr;
}

static size_t wsp_ggml_graph_nbytes(size_t size, bool grads) {
    size_t hash_size = wsp_ggml_hash_size(size * 2);
    void * p = 0;
    incr_ptr_aligned(&p, sizeof(struct wsp_ggml_cgraph), 1);
    incr_ptr_aligned(&p, size * sizeof(struct wsp_ggml_tensor *), sizeof(struct wsp_ggml_tensor *)); // nodes
    incr_ptr_aligned(&p, size * sizeof(struct wsp_ggml_tensor *), sizeof(struct wsp_ggml_tensor *)); // leafs
    incr_ptr_aligned(&p, hash_size * sizeof(int32_t), sizeof(int32_t)); // use_counts
    incr_ptr_aligned(&p, hash_size * sizeof(struct wsp_ggml_tensor *), sizeof(struct wsp_ggml_tensor *)); // hash keys
    if (grads) {
        incr_ptr_aligned(&p, hash_size * sizeof(struct wsp_ggml_tensor *), sizeof(struct wsp_ggml_tensor *)); // grads
        incr_ptr_aligned(&p, hash_size * sizeof(struct wsp_ggml_tensor *), sizeof(struct wsp_ggml_tensor *)); // grad_accs
    }
    incr_ptr_aligned(&p, wsp_ggml_bitset_size(hash_size) * sizeof(wsp_ggml_bitset_t), sizeof(wsp_ggml_bitset_t));

    size_t nbytes = (size_t) p;
    return nbytes;
}

size_t wsp_ggml_graph_overhead_custom(size_t size, bool grads) {
    return WSP_GGML_OBJECT_SIZE + WSP_GGML_PAD(wsp_ggml_graph_nbytes(size, grads), WSP_GGML_MEM_ALIGN);
}

size_t wsp_ggml_graph_overhead(void) {
    return wsp_ggml_graph_overhead_custom(WSP_GGML_DEFAULT_GRAPH_SIZE, false);
}

struct wsp_ggml_cgraph * wsp_ggml_new_graph_custom(struct wsp_ggml_context * ctx, size_t size, bool grads) {
    const size_t obj_size = wsp_ggml_graph_nbytes(size, grads);
    struct wsp_ggml_object * obj = wsp_ggml_new_object(ctx, WSP_GGML_OBJECT_TYPE_GRAPH, obj_size);
    struct wsp_ggml_cgraph * cgraph = (struct wsp_ggml_cgraph *) ((char *) ctx->mem_buffer + obj->offs);

    // the size of the hash table is doubled since it needs to hold both nodes and leafs
    size_t hash_size = wsp_ggml_hash_size(size * 2);

    void * p = cgraph + 1;

    struct wsp_ggml_tensor ** nodes_ptr      =         incr_ptr_aligned(&p, size      * sizeof(struct wsp_ggml_tensor *), sizeof(struct wsp_ggml_tensor *));
    struct wsp_ggml_tensor ** leafs_ptr      =         incr_ptr_aligned(&p, size      * sizeof(struct wsp_ggml_tensor *), sizeof(struct wsp_ggml_tensor *));
    int32_t             * use_counts_ptr =         incr_ptr_aligned(&p, hash_size * sizeof(int32_t), sizeof(int32_t));
    struct wsp_ggml_tensor ** hash_keys_ptr  =         incr_ptr_aligned(&p, hash_size * sizeof(struct wsp_ggml_tensor *), sizeof(struct wsp_ggml_tensor *));
    struct wsp_ggml_tensor ** grads_ptr      = grads ? incr_ptr_aligned(&p, hash_size * sizeof(struct wsp_ggml_tensor *), sizeof(struct wsp_ggml_tensor *)) : NULL;
    struct wsp_ggml_tensor ** grad_accs_ptr  = grads ? incr_ptr_aligned(&p, hash_size * sizeof(struct wsp_ggml_tensor *), sizeof(struct wsp_ggml_tensor *)) : NULL;

    wsp_ggml_bitset_t * hash_used = incr_ptr_aligned(&p, wsp_ggml_bitset_size(hash_size) * sizeof(wsp_ggml_bitset_t), sizeof(wsp_ggml_bitset_t));

    // check that we allocated the correct amount of memory
    assert(obj_size == (size_t)((char *)p - (char *)cgraph));

    *cgraph = (struct wsp_ggml_cgraph) {
        /*.size         =*/ size,
        /*.n_nodes      =*/ 0,
        /*.n_leafs      =*/ 0,
        /*.nodes        =*/ nodes_ptr,
        /*.grads        =*/ grads_ptr,
        /*.grad_accs    =*/ grad_accs_ptr,
        /*.leafs        =*/ leafs_ptr,
        /*.use_counts   =*/ use_counts_ptr,
        /*.hash_table   =*/ { hash_size, hash_used, hash_keys_ptr },
        /*.order        =*/ WSP_GGML_CGRAPH_EVAL_ORDER_LEFT_TO_RIGHT,
    };

    wsp_ggml_hash_set_reset(&cgraph->visited_hash_set);
    if (grads) {
        memset(cgraph->grads,     0, hash_size*sizeof(struct wsp_ggml_tensor *));
        memset(cgraph->grad_accs, 0, hash_size*sizeof(struct wsp_ggml_tensor *));
    }

    return cgraph;
}

struct wsp_ggml_cgraph * wsp_ggml_new_graph(struct wsp_ggml_context * ctx) {
    return wsp_ggml_new_graph_custom(ctx, WSP_GGML_DEFAULT_GRAPH_SIZE, false);
}

struct wsp_ggml_cgraph wsp_ggml_graph_view(struct wsp_ggml_cgraph * cgraph0, int i0, int i1) {
    struct wsp_ggml_cgraph cgraph = {
        /*.size             =*/ 0,
        /*.n_nodes          =*/ i1 - i0,
        /*.n_leafs          =*/ 0,
        /*.nodes            =*/ cgraph0->nodes + i0,
        /*.grads            =*/ NULL, // gradients would need visited_hash_set
        /*.grad_accs        =*/ NULL,
        /*.leafs            =*/ NULL,
        /*.use_counts       =*/ cgraph0->use_counts,
        /*.visited_hash_set =*/ cgraph0->visited_hash_set,
        /*.order            =*/ cgraph0->order,
    };

    return cgraph;
}

void wsp_ggml_graph_cpy(struct wsp_ggml_cgraph * src, struct wsp_ggml_cgraph * dst) {
    WSP_GGML_ASSERT(dst->size >= src->n_leafs);
    WSP_GGML_ASSERT(dst->size >= src->n_nodes);
    WSP_GGML_ASSERT(dst->visited_hash_set.size >= src->visited_hash_set.size);

    dst->n_leafs = src->n_leafs;
    dst->n_nodes = src->n_nodes;
    dst->order   = src->order;

    for (int i = 0; i < src->n_leafs; ++i) {
        dst->leafs[i] = src->leafs[i];
    }

    for (int i = 0; i < src->n_nodes; ++i) {
        dst->nodes[i] = src->nodes[i];
    }

    for (size_t i = 0; i < src->visited_hash_set.size; ++i) {
        // copy all hashset keys (tensors) that are in use
        if (wsp_ggml_bitset_get(src->visited_hash_set.used, i)) {
            size_t new_hash_pos = wsp_ggml_hash_insert(&dst->visited_hash_set, src->visited_hash_set.keys[i]);
            dst->use_counts[new_hash_pos] = src->use_counts[i];
        }
    }

    if (dst->grads) {
        memset(dst->grads,     0, dst->visited_hash_set.size*sizeof(struct wsp_ggml_tensor *));
        memset(dst->grad_accs, 0, dst->visited_hash_set.size*sizeof(struct wsp_ggml_tensor *));
    }
    if (src->grads) {
        WSP_GGML_ASSERT(dst->grads     != NULL);
        WSP_GGML_ASSERT(dst->grad_accs != NULL);
        for (int i = 0; i < src->n_nodes; ++i) {
            const size_t igrad_src = wsp_ggml_hash_find(&src->visited_hash_set, src->nodes[i]);
            const size_t igrad_dst = wsp_ggml_hash_find(&dst->visited_hash_set, dst->nodes[i]);

            WSP_GGML_ASSERT(igrad_src != WSP_GGML_HASHSET_FULL);
            WSP_GGML_ASSERT(wsp_ggml_bitset_get(src->visited_hash_set.used, igrad_src));
            WSP_GGML_ASSERT(igrad_dst != WSP_GGML_HASHSET_FULL);
            WSP_GGML_ASSERT(wsp_ggml_bitset_get(dst->visited_hash_set.used, igrad_dst));

            dst->grads[igrad_dst]     = src->grads[igrad_src];
            dst->grad_accs[igrad_dst] = src->grad_accs[igrad_src];
        }
    }
}

struct wsp_ggml_cgraph * wsp_ggml_graph_dup(struct wsp_ggml_context * ctx, struct wsp_ggml_cgraph * cgraph, bool force_grads) {
    struct wsp_ggml_cgraph * result = wsp_ggml_new_graph_custom(ctx, cgraph->size, cgraph->grads || force_grads);
    wsp_ggml_graph_cpy(cgraph, result);
    return result;
}

struct wsp_ggml_tensor * wsp_ggml_set_zero(struct wsp_ggml_tensor * tensor) {
    if (wsp_ggml_is_empty(tensor)) {
        return tensor;
    }
    if (tensor->buffer) {
        wsp_ggml_backend_tensor_memset(tensor, 0, 0, wsp_ggml_nbytes(tensor));
    } else {
        WSP_GGML_ASSERT(tensor->data);
        memset(tensor->data, 0, wsp_ggml_nbytes(tensor));
    }
    return tensor;
}

void wsp_ggml_graph_reset(struct wsp_ggml_cgraph * cgraph) {
    if (!cgraph) {
        return;
    }
    WSP_GGML_ASSERT(cgraph->grads != NULL);

    for (int i = 0; i < cgraph->n_nodes; i++) {
        struct wsp_ggml_tensor * node     = cgraph->nodes[i];
        struct wsp_ggml_tensor * grad_acc = wsp_ggml_graph_get_grad_acc(cgraph, node);

        if (node->op == WSP_GGML_OP_OPT_STEP_ADAMW) {
            // clear momenta
            wsp_ggml_set_zero(node->src[2]);
            wsp_ggml_set_zero(node->src[3]);
        }

        // initial gradients of loss should be 1, 0 otherwise
        if (grad_acc) {
            if (node->flags & WSP_GGML_TENSOR_FLAG_LOSS) {
                WSP_GGML_ASSERT(grad_acc->type == WSP_GGML_TYPE_F32);
                WSP_GGML_ASSERT(wsp_ggml_is_scalar(grad_acc));

                const float onef = 1.0f;
                if (grad_acc->buffer) {
                    wsp_ggml_backend_tensor_set(grad_acc, &onef, 0, sizeof(float));
                } else {
                    WSP_GGML_ASSERT(grad_acc->data);
                    *((float *) grad_acc->data) = onef;
                }
            } else {
                wsp_ggml_set_zero(grad_acc);
            }
        }
    }
}

void wsp_ggml_graph_clear(struct wsp_ggml_cgraph * cgraph) {
    cgraph->n_leafs = 0;
    cgraph->n_nodes = 0;
    wsp_ggml_hash_set_reset(&cgraph->visited_hash_set);
}

int wsp_ggml_graph_size(struct wsp_ggml_cgraph * cgraph) {
    return cgraph->size;
}

struct wsp_ggml_tensor * wsp_ggml_graph_node(struct wsp_ggml_cgraph * cgraph, int i) {
    if (i < 0) {
        WSP_GGML_ASSERT(cgraph->n_nodes + i >= 0);
        return cgraph->nodes[cgraph->n_nodes + i];
    }

    WSP_GGML_ASSERT(i < cgraph->n_nodes);
    return cgraph->nodes[i];
}

struct wsp_ggml_tensor ** wsp_ggml_graph_nodes(struct wsp_ggml_cgraph * cgraph) {
    return cgraph->nodes;
}

int wsp_ggml_graph_n_nodes(struct wsp_ggml_cgraph * cgraph) {
    return cgraph->n_nodes;
}

void wsp_ggml_graph_add_node(struct wsp_ggml_cgraph * cgraph, struct wsp_ggml_tensor * tensor) {
    WSP_GGML_ASSERT(cgraph->size > cgraph->n_nodes);
    cgraph->nodes[cgraph->n_nodes] = tensor;
    cgraph->n_nodes++;
}

struct wsp_ggml_tensor * wsp_ggml_graph_get_tensor(const struct wsp_ggml_cgraph * cgraph, const char * name) {
    for (int i = 0; i < cgraph->n_leafs; i++) {
        struct wsp_ggml_tensor * leaf = cgraph->leafs[i];

        if (strcmp(leaf->name, name) == 0) {
            return leaf;
        }
    }

    for (int i = 0; i < cgraph->n_nodes; i++) {
        struct wsp_ggml_tensor * node = cgraph->nodes[i];

        if (strcmp(node->name, name) == 0) {
            return node;
        }
    }

    return NULL;
}

struct wsp_ggml_tensor * wsp_ggml_graph_get_grad(const struct wsp_ggml_cgraph * cgraph, const struct wsp_ggml_tensor * node) {
    const size_t igrad = wsp_ggml_hash_find(&cgraph->visited_hash_set, node);
    return igrad != WSP_GGML_HASHSET_FULL && wsp_ggml_bitset_get(cgraph->visited_hash_set.used, igrad) && cgraph->grads ? cgraph->grads[igrad] : NULL;
}

struct wsp_ggml_tensor * wsp_ggml_graph_get_grad_acc(const struct wsp_ggml_cgraph * cgraph, const struct wsp_ggml_tensor * node) {
    const size_t igrad = wsp_ggml_hash_find(&cgraph->visited_hash_set, node);
    return igrad != WSP_GGML_HASHSET_FULL && wsp_ggml_bitset_get(cgraph->visited_hash_set.used, igrad) && cgraph->grad_accs ? cgraph->grad_accs[igrad] : NULL;
}

void wsp_ggml_graph_print(const struct wsp_ggml_cgraph * cgraph) {
    WSP_GGML_LOG_INFO("=== GRAPH ===\n");

    WSP_GGML_LOG_INFO("n_nodes = %d\n", cgraph->n_nodes);
    for (int i = 0; i < cgraph->n_nodes; i++) {
        struct wsp_ggml_tensor * node = cgraph->nodes[i];

        WSP_GGML_LOG_INFO(" - %3d: [ %5" PRId64 ", %5" PRId64 ", %5" PRId64 "] %16s %s\n",
                i,
                node->ne[0], node->ne[1], node->ne[2],
                wsp_ggml_op_name(node->op), (node->flags & WSP_GGML_TENSOR_FLAG_PARAM) ? "x" :
                      wsp_ggml_graph_get_grad(cgraph, node) ? "g" : " ");
    }

    WSP_GGML_LOG_INFO("n_leafs = %d\n", cgraph->n_leafs);
    for (int i = 0; i < cgraph->n_leafs; i++) {
        struct wsp_ggml_tensor * node = cgraph->leafs[i];

        WSP_GGML_LOG_INFO(" - %3d: [ %5" PRId64 ", %5" PRId64 "] %8s %16s\n",
                i,
                node->ne[0], node->ne[1],
                wsp_ggml_op_name(node->op),
                wsp_ggml_get_name(node));
    }

    WSP_GGML_LOG_INFO("========================================\n");
}

static int wsp_ggml_node_list_find_tensor(const struct wsp_ggml_cgraph * cgraph,
                                      const int *                idxs,
                                      int                        count,
                                      const struct wsp_ggml_tensor * tensor) {
    WSP_GGML_ASSERT(cgraph && idxs);
    for (int i = 0; i < count; ++i) {
        const int node_idx = idxs[i];

        if (node_idx >= cgraph->n_nodes) {
            return -1;
        }
        if (cgraph->nodes[node_idx] == tensor) {
            return i;
        }
    }
    return -1;
}

bool wsp_ggml_can_fuse_subgraph_ext(const struct wsp_ggml_cgraph * cgraph,
                                const int *                node_idxs,
                                int                        count,
                                const enum wsp_ggml_op *       ops,
                                const int *                outputs,
                                int                        num_outputs) {
    WSP_GGML_ASSERT(outputs && num_outputs > 0);

    for (int i = 0; i < count; ++i) {
        if (node_idxs[i] >= cgraph->n_nodes) {
            return false;
        }

        const struct wsp_ggml_tensor * node = cgraph->nodes[node_idxs[i]];

        if (node->op != ops[i]) {
            return false;
        }

        if (wsp_ggml_node_list_find_tensor(cgraph, outputs, num_outputs, node) != -1) {
            continue;
        }

        if (node->flags & WSP_GGML_TENSOR_FLAG_OUTPUT) {
            return false;
        }

        int subgraph_uses = 0;
        for (int j = i + 1; j < count; ++j) {
            const struct wsp_ggml_tensor * other_node = cgraph->nodes[node_idxs[j]];
            for (int src_idx = 0; src_idx < WSP_GGML_MAX_SRC; src_idx++) {
                if (other_node->src[src_idx] == node) {
                    subgraph_uses++;
                }
            }
        }

        if (subgraph_uses != wsp_ggml_node_get_use_count(cgraph, node_idxs[i])) {
            return false;
        }

        // if node is a view, check if the view_src and all it's parent view_srcs are within the subgraph
        struct wsp_ggml_tensor * view_src = node->view_src;
        while (view_src) {
            if (wsp_ggml_node_list_find_tensor(cgraph, node_idxs, count, view_src) == -1) {
                return false;
            }
            view_src = view_src->view_src;
        }
    }

    return true;
}

// check if node is part of the graph
static bool wsp_ggml_graph_find(const struct wsp_ggml_cgraph * cgraph, const struct wsp_ggml_tensor * node) {
    if (cgraph == NULL) {
        return true;
    }

    for (int i = 0; i < cgraph->n_nodes; i++) {
        if (cgraph->nodes[i] == node) {
            return true;
        }
    }

    return false;
}

static struct wsp_ggml_tensor * wsp_ggml_graph_get_parent(const struct wsp_ggml_cgraph * cgraph, const struct wsp_ggml_tensor * node) {
    for (int i = 0; i < cgraph->n_nodes; i++) {
        struct wsp_ggml_tensor * parent = cgraph->nodes[i];
        struct wsp_ggml_tensor * grad = wsp_ggml_graph_get_grad(cgraph, parent);

        if (grad == node) {
            return parent;
        }
    }

    return NULL;
}

static void wsp_ggml_graph_dump_dot_node_edge(FILE * fp, const struct wsp_ggml_cgraph * gb, struct wsp_ggml_tensor * node, struct wsp_ggml_tensor * parent, const char * label)  {
    struct wsp_ggml_tensor * gparent = wsp_ggml_graph_get_parent(gb, node);
    struct wsp_ggml_tensor * gparent0 = wsp_ggml_graph_get_parent(gb, parent);
    fprintf(fp, "  \"%p\" -> \"%p\" [ arrowhead = %s; style = %s; label = \"%s\"; ]\n",
            gparent0 ? (void *) gparent0 : (void *) parent,
            gparent ? (void *) gparent : (void *) node,
            gparent ? "empty" : "vee",
            gparent ? "dashed" : "solid",
            label);
}

static void wsp_ggml_graph_dump_dot_leaf_edge(FILE * fp, struct wsp_ggml_tensor * node, struct wsp_ggml_tensor * parent, const char * label)  {
    fprintf(fp, "  \"%p\" -> \"%p\" [ label = \"%s\"; ]\n",
            (void *) parent,
            (void *) node,
            label);
}

void wsp_ggml_graph_dump_dot(const struct wsp_ggml_cgraph * gb, const struct wsp_ggml_cgraph * gf, const char * filename) {
    char color[16];

    FILE * fp = wsp_ggml_fopen(filename, "w");
    WSP_GGML_ASSERT(fp);

    fprintf(fp, "digraph G {\n");
    fprintf(fp, "  newrank = true;\n");
    fprintf(fp, "  rankdir = TB;\n");

    for (int i = 0; i < gb->n_nodes; i++) {
        struct wsp_ggml_tensor * node = gb->nodes[i];
        struct wsp_ggml_tensor * grad = wsp_ggml_graph_get_grad(gb, node);

        if (wsp_ggml_graph_get_parent(gb, node) != NULL) {
            continue;
        }

        if (node->flags & WSP_GGML_TENSOR_FLAG_PARAM) {
            snprintf(color, sizeof(color), "yellow");
        } else if (grad) {
            if (wsp_ggml_graph_find(gf, node)) {
                snprintf(color, sizeof(color), "green");
            } else {
                snprintf(color, sizeof(color), "lightblue");
            }
        } else {
            snprintf(color, sizeof(color), "white");
        }

        fprintf(fp, "  \"%p\" [ "
                    "style = filled; fillcolor = %s; shape = record; "
                    "label=\"",
                (void *) node, color);

        if (strlen(node->name) > 0) {
            fprintf(fp, "%s (%s)|", node->name, wsp_ggml_type_name(node->type));
        } else {
            fprintf(fp, "(%s)|", wsp_ggml_type_name(node->type));
        }

        if (wsp_ggml_is_matrix(node)) {
            fprintf(fp, "%d [%" PRId64 ", %" PRId64 "] | <x>%s", i, node->ne[0], node->ne[1], wsp_ggml_op_symbol(node->op));
        } else {
            fprintf(fp, "%d [%" PRId64 ", %" PRId64 ", %" PRId64 "] | <x>%s", i, node->ne[0], node->ne[1], node->ne[2], wsp_ggml_op_symbol(node->op));
        }

        if (grad) {
            fprintf(fp, " | <g>%s\"; ]\n", wsp_ggml_op_symbol(grad->op));
        } else {
            fprintf(fp, "\"; ]\n");
        }
    }

    for (int i = 0; i < gb->n_leafs; i++) {
        struct wsp_ggml_tensor * node = gb->leafs[i];

        snprintf(color, sizeof(color), "pink");

        fprintf(fp, "  \"%p\" [ "
                    "style = filled; fillcolor = %s; shape = record; "
                    "label=\"<x>",
                (void *) node, color);

        if (strlen(node->name) > 0) {
            fprintf(fp, "%s (%s)|", node->name, wsp_ggml_type_name(node->type));
        } else {
            fprintf(fp, "(%s)|", wsp_ggml_type_name(node->type));
        }

        fprintf(fp, "CONST %d [%" PRId64 ", %" PRId64 "]", i, node->ne[0], node->ne[1]);
        if (wsp_ggml_nelements(node) < 5 && node->data != NULL) {
            fprintf(fp, " | (");
            for (int j = 0; j < wsp_ggml_nelements(node); j++) {
                // FIXME: use ggml-backend to obtain the tensor data
                //if (node->type == WSP_GGML_TYPE_I8 || node->type == WSP_GGML_TYPE_I16 || node->type == WSP_GGML_TYPE_I32) {
                //    fprintf(fp, "%d", wsp_ggml_get_i32_1d(node, j));
                //}
                //else if (node->type == WSP_GGML_TYPE_F32 ||
                //         node->type == WSP_GGML_TYPE_F16 ||
                //         node->type == WSP_GGML_TYPE_BF16) {
                //    fprintf(fp, "%.1e", (double)wsp_ggml_get_f32_1d(node, j));
                //}
                //else
                {
                    fprintf(fp, "#");
                }
                if (j < wsp_ggml_nelements(node) - 1) {
                    fprintf(fp, ", ");
                }
            }
            fprintf(fp, ")");
        }
        fprintf(fp, "\"; ]\n");
    }

    for (int i = 0; i < gb->n_nodes; i++) {
        struct wsp_ggml_tensor * node = gb->nodes[i];

        for (int j = 0; j < WSP_GGML_MAX_SRC; j++) {
            if (node->src[j]) {
                char label[16];
                snprintf(label, sizeof(label), "src %d", j);
                wsp_ggml_graph_dump_dot_node_edge(fp, gb, node, node->src[j], label);
            }
        }
    }

    for (int i = 0; i < gb->n_leafs; i++) {
        struct wsp_ggml_tensor * node = gb->leafs[i];

        for (int j = 0; j < WSP_GGML_MAX_SRC; j++) {
            if (node->src[j]) {
                char label[16];
                snprintf(label, sizeof(label), "src %d", j);
                wsp_ggml_graph_dump_dot_leaf_edge(fp, node, node->src[j], label);
            }
        }
    }

    fprintf(fp, "}\n");

    fclose(fp);

    WSP_GGML_LOG_INFO("%s: dot -Tpng %s -o %s.png && open %s.png\n", __func__, filename, filename, filename);
}

////////////////////////////////////////////////////////////////////////////////

void wsp_ggml_set_input(struct wsp_ggml_tensor * tensor) {
    tensor->flags |= WSP_GGML_TENSOR_FLAG_INPUT;
}

void wsp_ggml_set_output(struct wsp_ggml_tensor * tensor) {
    tensor->flags |= WSP_GGML_TENSOR_FLAG_OUTPUT;
}

void wsp_ggml_set_param(struct wsp_ggml_tensor * tensor) {
    WSP_GGML_ASSERT(tensor->op == WSP_GGML_OP_NONE);
    tensor->flags |= WSP_GGML_TENSOR_FLAG_PARAM;
}

void wsp_ggml_set_loss(struct wsp_ggml_tensor * tensor) {
    WSP_GGML_ASSERT(wsp_ggml_is_scalar(tensor));
    WSP_GGML_ASSERT(tensor->type == WSP_GGML_TYPE_F32);
    tensor->flags |= WSP_GGML_TENSOR_FLAG_LOSS;
}

////////////////////////////////////////////////////////////////////////////////

void wsp_ggml_wsp_quantize_init(enum wsp_ggml_type type) {
    wsp_ggml_critical_section_start();

    switch (type) {
        case WSP_GGML_TYPE_IQ2_XXS:
        case WSP_GGML_TYPE_IQ2_XS:
        case WSP_GGML_TYPE_IQ2_S:
        case WSP_GGML_TYPE_IQ1_S:
        case WSP_GGML_TYPE_IQ1_M:   wsp_iq2xs_init_impl(type); break;
        case WSP_GGML_TYPE_IQ3_XXS: wsp_iq3xs_init_impl(256); break;
        case WSP_GGML_TYPE_IQ3_S:   wsp_iq3xs_init_impl(512); break;
        default: // nothing
            break;
    }

    wsp_ggml_critical_section_end();
}

void wsp_ggml_wsp_quantize_free(void) {
    wsp_ggml_critical_section_start();

    wsp_iq2xs_free_impl(WSP_GGML_TYPE_IQ2_XXS);
    wsp_iq2xs_free_impl(WSP_GGML_TYPE_IQ2_XS);
    wsp_iq2xs_free_impl(WSP_GGML_TYPE_IQ1_S);
    wsp_iq3xs_free_impl(256);

    wsp_ggml_critical_section_end();
}

bool wsp_ggml_wsp_quantize_requires_imatrix(enum wsp_ggml_type type) {
    return
        type == WSP_GGML_TYPE_IQ2_XXS ||
        type == WSP_GGML_TYPE_IQ2_XS  ||
        type == WSP_GGML_TYPE_IQ1_S;//   ||
        //type == WSP_GGML_TYPE_IQ1_M;
}

size_t wsp_ggml_wsp_quantize_chunk(
        enum wsp_ggml_type   type,
           const float * src,
                  void * dst,
               int64_t   start,
               int64_t   nrows,
               int64_t   n_per_row,
           const float * imatrix) {
    const int64_t n = (int64_t) nrows * n_per_row;

    if (wsp_ggml_wsp_quantize_requires_imatrix(type)) {
        WSP_GGML_ASSERT(imatrix != NULL);
    }

    WSP_GGML_ASSERT(start % type_traits[type].blck_size == 0);
    WSP_GGML_ASSERT(start % n_per_row == 0);

    wsp_ggml_wsp_quantize_init(type); // this is noop if already initialized

    const size_t start_row = start / n_per_row;
    const size_t row_size  = wsp_ggml_row_size(type, n_per_row);

    size_t result = 0;

    switch (type) {
        case WSP_GGML_TYPE_Q4_0:    result = wsp_quantize_q4_0(src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_Q4_1:    result = wsp_quantize_q4_1(src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_Q5_0:    result = wsp_quantize_q5_0(src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_Q5_1:    result = wsp_quantize_q5_1(src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_Q8_0:    result = wsp_quantize_q8_0(src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_MXFP4:   result = wsp_quantize_mxfp4(src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_Q2_K:    result = wsp_quantize_q2_K(src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_Q3_K:    result = wsp_quantize_q3_K(src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_Q4_K:    result = wsp_quantize_q4_K(src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_Q5_K:    result = wsp_quantize_q5_K(src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_Q6_K:    result = wsp_quantize_q6_K(src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_TQ1_0:   result = wsp_quantize_tq1_0(src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_TQ2_0:   result = wsp_quantize_tq2_0(src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_IQ2_XXS: result = wsp_quantize_iq2_xxs(src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_IQ2_XS:  result = wsp_quantize_iq2_xs (src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_IQ3_XXS: result = wsp_quantize_iq3_xxs(src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_IQ3_S:   result = wsp_quantize_iq3_s  (src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_IQ2_S:   result = wsp_quantize_iq2_s  (src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_IQ1_S:   result = wsp_quantize_iq1_s  (src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_IQ1_M:   result = wsp_quantize_iq1_m  (src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_IQ4_NL:  result = wsp_quantize_iq4_nl (src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_IQ4_XS:  result = wsp_quantize_iq4_xs (src + start, (char *) dst + start_row * row_size, nrows, n_per_row, imatrix); break;
        case WSP_GGML_TYPE_F16:
            {
                size_t elemsize = sizeof(wsp_ggml_fp16_t);
                wsp_ggml_fp32_to_fp16_row(src + start, (wsp_ggml_fp16_t *)dst + start, n);
                result = n * elemsize;
            } break;
        case WSP_GGML_TYPE_BF16:
            {
                size_t elemsize = sizeof(wsp_ggml_bf16_t);
                wsp_ggml_fp32_to_bf16_row_ref(src + start, (wsp_ggml_bf16_t *)dst + start, n);
                result = n * elemsize;
            } break;
        case WSP_GGML_TYPE_F32:
            {
                size_t elemsize = sizeof(float);
                result = n * elemsize;
                memcpy((uint8_t *)dst + start * elemsize, src + start, result);
            } break;
        default:
            assert(false);
    }

    WSP_GGML_ASSERT(result == nrows * row_size);

    return result;
}

////////////////////////////////////////////////////////////////////////////////

void wsp_ggml_log_set(wsp_ggml_log_callback log_callback, void * user_data) {
    g_logger_state.log_callback = log_callback ? log_callback : wsp_ggml_log_callback_default;
    g_logger_state.log_callback_user_data = user_data;
}

void wsp_ggml_threadpool_params_init(struct wsp_ggml_threadpool_params * p, int n_threads) {
    p->n_threads  = n_threads;
    p->prio       = 0;     // default priority (usually means normal or inherited)
    p->poll       = 50;    // hybrid-polling enabled
    p->strict_cpu = false; // no strict placement (all threads share same cpumask)
    p->paused     = false; // threads are ready to go
    memset(p->cpumask, 0, WSP_GGML_MAX_N_THREADS); // all-zero means use the default affinity (usually inherited)
}

struct wsp_ggml_threadpool_params wsp_ggml_threadpool_params_default(int n_threads) {
    struct wsp_ggml_threadpool_params p;
    wsp_ggml_threadpool_params_init(&p, n_threads);
    return p;
}

bool wsp_ggml_threadpool_params_match(const struct wsp_ggml_threadpool_params * p0, const struct wsp_ggml_threadpool_params * p1) {
    if (p0->n_threads      != p1->n_threads  )    return false;
    if (p0->prio           != p1->prio       )    return false;
    if (p0->poll           != p1->poll       )    return false;
    if (p0->strict_cpu     != p1->strict_cpu )    return false;
    return memcmp(p0->cpumask, p1->cpumask, WSP_GGML_MAX_N_THREADS) == 0;
}
