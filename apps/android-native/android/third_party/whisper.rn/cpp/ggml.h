#pragma once

//
// GGML Tensor Library
//
// This documentation is still a work in progress.
// If you wish some specific topics to be covered, feel free to drop a comment:
//
//   https://github.com/ggerganov/whisper.cpp/issues/40
//
// ## Overview
//
// This library implements:
//
//  - a set of tensor operations
//  - automatic differentiation
//  - basic optimization algorithms
//
// The aim of this library is to provide a minimalistic approach for various machine learning tasks. This includes,
// but is not limited to, the following:
//
//  - linear regression
//  - support vector machines
//  - neural networks
//
// The library allows the user to define a certain function using the available tensor operations. This function
// definition is represented internally via a computation graph. Each tensor operation in the function definition
// corresponds to a node in the graph. Having the computation graph defined, the user can choose to compute the
// function's value and/or its gradient with respect to the input variables. Optionally, the function can be optimized
// using one of the available optimization algorithms.
//
// For example, here we define the function: f(x) = a*x^2 + b
//
//   {
//       struct wsp_ggml_init_params params = {
//           .mem_size   = 16*1024*1024,
//           .mem_buffer = NULL,
//       };
//
//       // memory allocation happens here
//       struct wsp_ggml_context * ctx = wsp_ggml_init(params);
//
//       struct wsp_ggml_tensor * x = wsp_ggml_new_tensor_1d(ctx, WSP_GGML_TYPE_F32, 1);
//
//       wsp_ggml_set_param(ctx, x); // x is an input variable
//
//       struct wsp_ggml_tensor * a  = wsp_ggml_new_tensor_1d(ctx, WSP_GGML_TYPE_F32, 1);
//       struct wsp_ggml_tensor * b  = wsp_ggml_new_tensor_1d(ctx, WSP_GGML_TYPE_F32, 1);
//       struct wsp_ggml_tensor * x2 = wsp_ggml_mul(ctx, x, x);
//       struct wsp_ggml_tensor * f  = wsp_ggml_add(ctx, wsp_ggml_mul(ctx, a, x2), b);
//
//       ...
//   }
//
// Notice that the function definition above does not involve any actual computation. The computation is performed only
// when the user explicitly requests it. For example, to compute the function's value at x = 2.0:
//
//   {
//       ...
//
//       struct wsp_ggml_cgraph * gf = wsp_ggml_new_graph(ctx);
//       wsp_ggml_build_forward_expand(gf, f);
//
//       // set the input variable and parameter values
//       wsp_ggml_set_f32(x, 2.0f);
//       wsp_ggml_set_f32(a, 3.0f);
//       wsp_ggml_set_f32(b, 4.0f);
//
//       wsp_ggml_graph_compute_with_ctx(ctx, &gf, n_threads);
//
//       printf("f = %f\n", wsp_ggml_get_f32_1d(f, 0));
//
//       ...
//   }
//
// The actual computation is performed in the wsp_ggml_graph_compute() function.
//
// The wsp_ggml_new_tensor_...() functions create new tensors. They are allocated in the memory buffer provided to the
// wsp_ggml_init() function. You have to be careful not to exceed the memory buffer size. Therefore, you have to know
// in advance how much memory you need for your computation. Alternatively, you can allocate a large enough memory
// and after defining the computation graph, call the wsp_ggml_used_mem() function to find out how much memory was
// actually needed.
//
// The wsp_ggml_set_param() function marks a tensor as an input variable. This is used by the automatic
// differentiation and optimization algorithms.
//
// The described approach allows to define the function graph once and then compute its forward or backward graphs
// multiple times. All computations will use the same memory buffer allocated in the wsp_ggml_init() function. This way
// the user can avoid the memory allocation overhead at runtime.
//
// The library supports multi-dimensional tensors - up to 4 dimensions. The FP16 and FP32 data types are first class
// citizens, but in theory the library can be extended to support FP8 and integer data types.
//
// Each tensor operation produces a new tensor. Initially the library was envisioned to support only the use of unary
// and binary operations. Most of the available operations fall into one of these two categories. With time, it became
// clear that the library needs to support more complex operations. The way to support these operations is not clear
// yet, but a few examples are demonstrated in the following operations:
//
//   - wsp_ggml_permute()
//   - wsp_ggml_conv_1d_1s()
//   - wsp_ggml_conv_1d_2s()
//
// For each tensor operator, the library implements a forward and backward computation function. The forward function
// computes the output tensor value given the input tensor values. The backward function computes the adjoint of the
// input tensors given the adjoint of the output tensor. For a detailed explanation of what this means, take a
// calculus class, or watch the following video:
//
//   What is Automatic Differentiation?
//   https://www.youtube.com/watch?v=wG_nF1awSSY
//
//
// ## Tensor data (struct wsp_ggml_tensor)
//
// The tensors are stored in memory via the wsp_ggml_tensor struct. The structure provides information about the size of
// the tensor, the data type, and the memory buffer where the tensor data is stored. Additionally, it contains
// pointers to the "source" tensors - i.e. the tensors that were used to compute the current tensor. For example:
//
//   {
//       struct wsp_ggml_tensor * c = wsp_ggml_add(ctx, a, b);
//
//       assert(c->src[0] == a);
//       assert(c->src[1] == b);
//   }
//
// The multi-dimensional tensors are stored in row-major order. The wsp_ggml_tensor struct contains fields for the
// number of elements in each dimension ("ne") as well as the number of bytes ("nb", a.k.a. stride). This allows
// to store tensors that are not contiguous in memory, which is useful for operations such as transposition and
// permutation. All tensor operations have to take the stride into account and not assume that the tensor is
// contiguous in memory.
//
// The data of the tensor is accessed via the "data" pointer. For example:
//
//   {
//       const int nx = 2;
//       const int ny = 3;
//
//       struct wsp_ggml_tensor * a = wsp_ggml_new_tensor_2d(ctx, WSP_GGML_TYPE_F32, nx, ny);
//
//       for (int y = 0; y < ny; y++) {
//           for (int x = 0; x < nx; x++) {
//               *(float *) ((char *) a->data + y*a->nb[1] + x*a->nb[0]) = x + y;
//           }
//       }
//
//       ...
//   }
//
// Alternatively, there are helper functions, such as wsp_ggml_get_f32_1d() and wsp_ggml_set_f32_1d() that can be used.
//
// ## The matrix multiplication operator (wsp_ggml_mul_mat)
//
// TODO
//
//
// ## Multi-threading
//
// TODO
//
//
// ## Overview of ggml.c
//
// TODO
//
//
// ## SIMD optimizations
//
// TODO
//
//
// ## Debugging ggml
//
// TODO
//
//

#ifdef WSP_GGML_SHARED
#    if defined(_WIN32) && !defined(__MINGW32__)
#        ifdef WSP_GGML_BUILD
#            define WSP_GGML_API __declspec(dllexport) extern
#        else
#            define WSP_GGML_API __declspec(dllimport) extern
#        endif
#    else
#        define WSP_GGML_API __attribute__ ((visibility ("default"))) extern
#    endif
#else
#    define WSP_GGML_API extern
#endif

// TODO: support for clang
#ifdef __GNUC__
#    define WSP_GGML_DEPRECATED(func, hint) func __attribute__((deprecated(hint)))
#elif defined(_MSC_VER)
#    define WSP_GGML_DEPRECATED(func, hint) __declspec(deprecated(hint)) func
#else
#    define WSP_GGML_DEPRECATED(func, hint) func
#endif

#ifndef __GNUC__
#    define WSP_GGML_ATTRIBUTE_FORMAT(...)
#elif defined(__MINGW32__) && !defined(__clang__)
#    define WSP_GGML_ATTRIBUTE_FORMAT(...) __attribute__((format(gnu_printf, __VA_ARGS__)))
#else
#    define WSP_GGML_ATTRIBUTE_FORMAT(...) __attribute__((format(printf, __VA_ARGS__)))
#endif

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#define WSP_GGML_FILE_MAGIC   0x67676d6c // "ggml"
#define WSP_GGML_FILE_VERSION 2

#define WSP_GGML_QNT_VERSION        2    // bump this on quantization format changes
#define WSP_GGML_QNT_VERSION_FACTOR 1000 // do not change this

#define WSP_GGML_MAX_DIMS           4
#define WSP_GGML_MAX_PARAMS         2048
#define WSP_GGML_MAX_SRC            10
#define WSP_GGML_MAX_N_THREADS      512
#define WSP_GGML_MAX_OP_PARAMS      64

#ifndef WSP_GGML_MAX_NAME
#   define WSP_GGML_MAX_NAME        64
#endif

#define WSP_GGML_DEFAULT_N_THREADS  4
#define WSP_GGML_DEFAULT_GRAPH_SIZE 2048

#if UINTPTR_MAX == 0xFFFFFFFF
    #define WSP_GGML_MEM_ALIGN 4
#else
    #define WSP_GGML_MEM_ALIGN 16
#endif

#define WSP_GGML_EXIT_SUCCESS 0
#define WSP_GGML_EXIT_ABORTED 1

// TODO: convert to enum https://github.com/ggml-org/llama.cpp/pull/16187#discussion_r2388538726
#define WSP_GGML_ROPE_TYPE_NORMAL 0
#define WSP_GGML_ROPE_TYPE_NEOX   2
#define WSP_GGML_ROPE_TYPE_MROPE  8
#define WSP_GGML_ROPE_TYPE_VISION 24
#define WSP_GGML_ROPE_TYPE_IMROPE 40 // binary: 101000

#define WSP_GGML_MROPE_SECTIONS   4

#define WSP_GGML_UNUSED(x) (void)(x)
#ifdef __CUDACC__
template<typename... Args>
__host__ __device__ constexpr inline void wsp_ggml_unused_vars_impl(Args&&...) noexcept {}
#define WSP_GGML_UNUSED_VARS(...) wsp_ggml_unused_vars_impl(__VA_ARGS__)
#else
#define WSP_GGML_UNUSED_VARS(...) do { (void)sizeof((__VA_ARGS__, 0)); } while(0)
#endif // __CUDACC__

#define WSP_GGML_PAD(x, n) (((x) + (n) - 1) & ~((n) - 1))

#ifndef NDEBUG
#   define WSP_GGML_UNREACHABLE() do { fprintf(stderr, "statement should be unreachable\n"); abort(); } while(0)
#elif defined(__GNUC__)
#   define WSP_GGML_UNREACHABLE() __builtin_unreachable()
#elif defined(_MSC_VER)
#   define WSP_GGML_UNREACHABLE() __assume(0)
#else
#   define WSP_GGML_UNREACHABLE() ((void) 0)
#endif

#ifdef __cplusplus
#   define WSP_GGML_NORETURN [[noreturn]]
#elif defined(_MSC_VER)
#   define WSP_GGML_NORETURN __declspec(noreturn)
#else
#   define WSP_GGML_NORETURN _Noreturn
#endif

#define WSP_GGML_ABORT(...) wsp_ggml_abort(__FILE__, __LINE__, __VA_ARGS__)
#define WSP_GGML_ASSERT(x) if (!(x)) WSP_GGML_ABORT("WSP_GGML_ASSERT(%s) failed", #x)

// used to copy the number of elements and stride in bytes of tensors into local variables.
// main purpose is to reduce code duplication and improve readability.
//
// example:
//
//    WSP_GGML_TENSOR_LOCALS(int64_t, ne1, src1, ne);
//    WSP_GGML_TENSOR_LOCALS(size_t,  nb1, src1, nb);
//
#define WSP_GGML_TENSOR_LOCALS_1(type, prefix, pointer, array) \
    const type prefix##0 = (pointer) ? (pointer)->array[0] : 0; \
    WSP_GGML_UNUSED(prefix##0);
#define WSP_GGML_TENSOR_LOCALS_2(type, prefix, pointer, array) \
    WSP_GGML_TENSOR_LOCALS_1    (type, prefix, pointer, array) \
    const type prefix##1 = (pointer) ? (pointer)->array[1] : 0; \
    WSP_GGML_UNUSED(prefix##1);
#define WSP_GGML_TENSOR_LOCALS_3(type, prefix, pointer, array) \
    WSP_GGML_TENSOR_LOCALS_2    (type, prefix, pointer, array) \
    const type prefix##2 = (pointer) ? (pointer)->array[2] : 0; \
    WSP_GGML_UNUSED(prefix##2);
#define WSP_GGML_TENSOR_LOCALS(type, prefix, pointer, array) \
    WSP_GGML_TENSOR_LOCALS_3  (type, prefix, pointer, array) \
    const type prefix##3 = (pointer) ? (pointer)->array[3] : 0; \
    WSP_GGML_UNUSED(prefix##3);

#define WSP_GGML_TENSOR_UNARY_OP_LOCALS \
    WSP_GGML_TENSOR_LOCALS(int64_t, ne0, src0, ne) \
    WSP_GGML_TENSOR_LOCALS(size_t,  nb0, src0, nb) \
    WSP_GGML_TENSOR_LOCALS(int64_t, ne,  dst,  ne) \
    WSP_GGML_TENSOR_LOCALS(size_t,  nb,  dst,  nb)

#define WSP_GGML_TENSOR_BINARY_OP_LOCALS \
    WSP_GGML_TENSOR_LOCALS(int64_t, ne0, src0, ne) \
    WSP_GGML_TENSOR_LOCALS(size_t,  nb0, src0, nb) \
    WSP_GGML_TENSOR_LOCALS(int64_t, ne1, src1, ne) \
    WSP_GGML_TENSOR_LOCALS(size_t,  nb1, src1, nb) \
    WSP_GGML_TENSOR_LOCALS(int64_t, ne,  dst,  ne) \
    WSP_GGML_TENSOR_LOCALS(size_t,  nb,  dst,  nb)

#define WSP_GGML_TENSOR_TERNARY_OP_LOCALS \
    WSP_GGML_TENSOR_LOCALS(int64_t, ne0, src0, ne) \
    WSP_GGML_TENSOR_LOCALS(size_t,  nb0, src0, nb) \
    WSP_GGML_TENSOR_LOCALS(int64_t, ne1, src1, ne) \
    WSP_GGML_TENSOR_LOCALS(size_t,  nb1, src1, nb) \
    WSP_GGML_TENSOR_LOCALS(int64_t, ne2, src2, ne) \
    WSP_GGML_TENSOR_LOCALS(size_t,  nb2, src2, nb) \
    WSP_GGML_TENSOR_LOCALS(int64_t, ne,  dst,  ne) \
    WSP_GGML_TENSOR_LOCALS(size_t,  nb,  dst,  nb)

#define WSP_GGML_TENSOR_BINARY_OP_LOCALS01 \
    WSP_GGML_TENSOR_LOCALS(int64_t, ne0, src0, ne) \
    WSP_GGML_TENSOR_LOCALS(size_t,  nb0, src0, nb) \
    WSP_GGML_TENSOR_LOCALS(int64_t, ne1, src1, ne) \
    WSP_GGML_TENSOR_LOCALS(size_t,  nb1, src1, nb)

#ifdef  __cplusplus
extern "C" {
#endif

    // Function type used in fatal error callbacks
    typedef void (*wsp_ggml_abort_callback_t)(const char * error_message);

    // Set the abort callback (passing null will restore original abort functionality: printing a message to stdout)
    // Returns the old callback for chaining
    WSP_GGML_API wsp_ggml_abort_callback_t wsp_ggml_set_abort_callback(wsp_ggml_abort_callback_t callback);

    WSP_GGML_NORETURN WSP_GGML_ATTRIBUTE_FORMAT(3, 4)
    WSP_GGML_API void wsp_ggml_abort(const char * file, int line, const char * fmt, ...);

    enum wsp_ggml_status {
        WSP_GGML_STATUS_ALLOC_FAILED = -2,
        WSP_GGML_STATUS_FAILED = -1,
        WSP_GGML_STATUS_SUCCESS = 0,
        WSP_GGML_STATUS_ABORTED = 1,
    };

    // get wsp_ggml_status name string
    WSP_GGML_API const char * wsp_ggml_status_to_string(enum wsp_ggml_status status);

    // ieee 754-2008 half-precision float16
    // todo: make this not an integral type
    typedef uint16_t wsp_ggml_fp16_t;
    WSP_GGML_API float       wsp_ggml_fp16_to_fp32(wsp_ggml_fp16_t);
    WSP_GGML_API wsp_ggml_fp16_t wsp_ggml_fp32_to_fp16(float);
    WSP_GGML_API void        wsp_ggml_fp16_to_fp32_row(const wsp_ggml_fp16_t *, float *, int64_t);
    WSP_GGML_API void        wsp_ggml_fp32_to_fp16_row(const float *, wsp_ggml_fp16_t *, int64_t);

    // google brain half-precision bfloat16
    typedef struct { uint16_t bits; } wsp_ggml_bf16_t;
    WSP_GGML_API wsp_ggml_bf16_t wsp_ggml_fp32_to_bf16(float);
    WSP_GGML_API float       wsp_ggml_bf16_to_fp32(wsp_ggml_bf16_t);  // consider just doing << 16
    WSP_GGML_API void        wsp_ggml_bf16_to_fp32_row(const wsp_ggml_bf16_t *, float *, int64_t);
    WSP_GGML_API void        wsp_ggml_fp32_to_bf16_row_ref(const float *, wsp_ggml_bf16_t *, int64_t);
    WSP_GGML_API void        wsp_ggml_fp32_to_bf16_row(const float *, wsp_ggml_bf16_t *, int64_t);

    struct wsp_ggml_object;
    struct wsp_ggml_context;
    struct wsp_ggml_cgraph;

    // NOTE: always add types at the end of the enum to keep backward compatibility
    enum wsp_ggml_type {
        WSP_GGML_TYPE_F32     = 0,
        WSP_GGML_TYPE_F16     = 1,
        WSP_GGML_TYPE_Q4_0    = 2,
        WSP_GGML_TYPE_Q4_1    = 3,
        // WSP_GGML_TYPE_Q4_2 = 4, support has been removed
        // WSP_GGML_TYPE_Q4_3 = 5, support has been removed
        WSP_GGML_TYPE_Q5_0    = 6,
        WSP_GGML_TYPE_Q5_1    = 7,
        WSP_GGML_TYPE_Q8_0    = 8,
        WSP_GGML_TYPE_Q8_1    = 9,
        WSP_GGML_TYPE_Q2_K    = 10,
        WSP_GGML_TYPE_Q3_K    = 11,
        WSP_GGML_TYPE_Q4_K    = 12,
        WSP_GGML_TYPE_Q5_K    = 13,
        WSP_GGML_TYPE_Q6_K    = 14,
        WSP_GGML_TYPE_Q8_K    = 15,
        WSP_GGML_TYPE_IQ2_XXS = 16,
        WSP_GGML_TYPE_IQ2_XS  = 17,
        WSP_GGML_TYPE_IQ3_XXS = 18,
        WSP_GGML_TYPE_IQ1_S   = 19,
        WSP_GGML_TYPE_IQ4_NL  = 20,
        WSP_GGML_TYPE_IQ3_S   = 21,
        WSP_GGML_TYPE_IQ2_S   = 22,
        WSP_GGML_TYPE_IQ4_XS  = 23,
        WSP_GGML_TYPE_I8      = 24,
        WSP_GGML_TYPE_I16     = 25,
        WSP_GGML_TYPE_I32     = 26,
        WSP_GGML_TYPE_I64     = 27,
        WSP_GGML_TYPE_F64     = 28,
        WSP_GGML_TYPE_IQ1_M   = 29,
        WSP_GGML_TYPE_BF16    = 30,
        // WSP_GGML_TYPE_Q4_0_4_4 = 31, support has been removed from gguf files
        // WSP_GGML_TYPE_Q4_0_4_8 = 32,
        // WSP_GGML_TYPE_Q4_0_8_8 = 33,
        WSP_GGML_TYPE_TQ1_0   = 34,
        WSP_GGML_TYPE_TQ2_0   = 35,
        // WSP_GGML_TYPE_IQ4_NL_4_4 = 36,
        // WSP_GGML_TYPE_IQ4_NL_4_8 = 37,
        // WSP_GGML_TYPE_IQ4_NL_8_8 = 38,
        WSP_GGML_TYPE_MXFP4   = 39, // MXFP4 (1 block)
        WSP_GGML_TYPE_COUNT   = 40,
    };

    // precision
    enum wsp_ggml_prec {
        WSP_GGML_PREC_DEFAULT =  0, // stored as wsp_ggml_tensor.op_params, 0 by default
        WSP_GGML_PREC_F32     = 10,
    };

    // model file types
    enum wsp_ggml_ftype {
        WSP_GGML_FTYPE_UNKNOWN        = -1,
        WSP_GGML_FTYPE_ALL_F32        = 0,
        WSP_GGML_FTYPE_MOSTLY_F16     = 1,  // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_Q4_0    = 2,  // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_Q4_1    = 3,  // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_Q4_1_SOME_F16 = 4, // tok_embeddings.weight and output.weight are F16
        WSP_GGML_FTYPE_MOSTLY_Q8_0    = 7,  // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_Q5_0    = 8,  // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_Q5_1    = 9,  // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_Q2_K    = 10, // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_Q3_K    = 11, // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_Q4_K    = 12, // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_Q5_K    = 13, // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_Q6_K    = 14, // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_IQ2_XXS = 15, // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_IQ2_XS  = 16, // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_IQ3_XXS = 17, // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_IQ1_S   = 18, // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_IQ4_NL  = 19, // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_IQ3_S   = 20, // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_IQ2_S   = 21, // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_IQ4_XS  = 22, // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_IQ1_M   = 23, // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_BF16    = 24, // except 1d tensors
        WSP_GGML_FTYPE_MOSTLY_MXFP4   = 25, // except 1d tensors
    };

    // available tensor operations:
    enum wsp_ggml_op {
        WSP_GGML_OP_NONE = 0,

        WSP_GGML_OP_DUP,
        WSP_GGML_OP_ADD,
        WSP_GGML_OP_ADD_ID,
        WSP_GGML_OP_ADD1,
        WSP_GGML_OP_ACC,
        WSP_GGML_OP_SUB,
        WSP_GGML_OP_MUL,
        WSP_GGML_OP_DIV,
        WSP_GGML_OP_SQR,
        WSP_GGML_OP_SQRT,
        WSP_GGML_OP_LOG,
        WSP_GGML_OP_SIN,
        WSP_GGML_OP_COS,
        WSP_GGML_OP_SUM,
        WSP_GGML_OP_SUM_ROWS,
        WSP_GGML_OP_CUMSUM,
        WSP_GGML_OP_MEAN,
        WSP_GGML_OP_ARGMAX,
        WSP_GGML_OP_COUNT_EQUAL,
        WSP_GGML_OP_REPEAT,
        WSP_GGML_OP_REPEAT_BACK,
        WSP_GGML_OP_CONCAT,
        WSP_GGML_OP_SILU_BACK,
        WSP_GGML_OP_NORM, // normalize
        WSP_GGML_OP_RMS_NORM,
        WSP_GGML_OP_RMS_NORM_BACK,
        WSP_GGML_OP_GROUP_NORM,
        WSP_GGML_OP_L2_NORM,

        WSP_GGML_OP_MUL_MAT,
        WSP_GGML_OP_MUL_MAT_ID,
        WSP_GGML_OP_OUT_PROD,

        WSP_GGML_OP_SCALE,
        WSP_GGML_OP_SET,
        WSP_GGML_OP_CPY,
        WSP_GGML_OP_CONT,
        WSP_GGML_OP_RESHAPE,
        WSP_GGML_OP_VIEW,
        WSP_GGML_OP_PERMUTE,
        WSP_GGML_OP_TRANSPOSE,
        WSP_GGML_OP_GET_ROWS,
        WSP_GGML_OP_GET_ROWS_BACK,
        WSP_GGML_OP_SET_ROWS,
        WSP_GGML_OP_DIAG,
        WSP_GGML_OP_DIAG_MASK_INF,
        WSP_GGML_OP_DIAG_MASK_ZERO,
        WSP_GGML_OP_SOFT_MAX,
        WSP_GGML_OP_SOFT_MAX_BACK,
        WSP_GGML_OP_ROPE,
        WSP_GGML_OP_ROPE_BACK,
        WSP_GGML_OP_CLAMP,
        WSP_GGML_OP_CONV_TRANSPOSE_1D,
        WSP_GGML_OP_IM2COL,
        WSP_GGML_OP_IM2COL_BACK,
        WSP_GGML_OP_IM2COL_3D,
        WSP_GGML_OP_CONV_2D,
        WSP_GGML_OP_CONV_3D,
        WSP_GGML_OP_CONV_2D_DW,
        WSP_GGML_OP_CONV_TRANSPOSE_2D,
        WSP_GGML_OP_POOL_1D,
        WSP_GGML_OP_POOL_2D,
        WSP_GGML_OP_POOL_2D_BACK,
        WSP_GGML_OP_UPSCALE,
        WSP_GGML_OP_PAD,
        WSP_GGML_OP_PAD_REFLECT_1D,
        WSP_GGML_OP_ROLL,
        WSP_GGML_OP_ARANGE,
        WSP_GGML_OP_TIMESTEP_EMBEDDING,
        WSP_GGML_OP_ARGSORT,
        WSP_GGML_OP_LEAKY_RELU,
        WSP_GGML_OP_TRI,
        WSP_GGML_OP_FILL,

        WSP_GGML_OP_FLASH_ATTN_EXT,
        WSP_GGML_OP_FLASH_ATTN_BACK,
        WSP_GGML_OP_SSM_CONV,
        WSP_GGML_OP_SSM_SCAN,
        WSP_GGML_OP_WIN_PART,
        WSP_GGML_OP_WIN_UNPART,
        WSP_GGML_OP_GET_REL_POS,
        WSP_GGML_OP_ADD_REL_POS,
        WSP_GGML_OP_RWKV_WKV6,
        WSP_GGML_OP_GATED_LINEAR_ATTN,
        WSP_GGML_OP_RWKV_WKV7,
        WSP_GGML_OP_SOLVE_TRI,

        WSP_GGML_OP_UNARY,

        WSP_GGML_OP_MAP_CUSTOM1,
        WSP_GGML_OP_MAP_CUSTOM2,
        WSP_GGML_OP_MAP_CUSTOM3,

        WSP_GGML_OP_CUSTOM,

        WSP_GGML_OP_CROSS_ENTROPY_LOSS,
        WSP_GGML_OP_CROSS_ENTROPY_LOSS_BACK,
        WSP_GGML_OP_OPT_STEP_ADAMW,
        WSP_GGML_OP_OPT_STEP_SGD,

        WSP_GGML_OP_GLU,

        WSP_GGML_OP_COUNT,
    };

    enum wsp_ggml_unary_op {
        WSP_GGML_UNARY_OP_ABS,
        WSP_GGML_UNARY_OP_SGN,
        WSP_GGML_UNARY_OP_NEG,
        WSP_GGML_UNARY_OP_STEP,
        WSP_GGML_UNARY_OP_TANH,
        WSP_GGML_UNARY_OP_ELU,
        WSP_GGML_UNARY_OP_RELU,
        WSP_GGML_UNARY_OP_SIGMOID,
        WSP_GGML_UNARY_OP_GELU,
        WSP_GGML_UNARY_OP_GELU_QUICK,
        WSP_GGML_UNARY_OP_SILU,
        WSP_GGML_UNARY_OP_HARDSWISH,
        WSP_GGML_UNARY_OP_HARDSIGMOID,
        WSP_GGML_UNARY_OP_EXP,
        WSP_GGML_UNARY_OP_EXPM1,
        WSP_GGML_UNARY_OP_SOFTPLUS,
        WSP_GGML_UNARY_OP_GELU_ERF,
        WSP_GGML_UNARY_OP_XIELU,
        WSP_GGML_UNARY_OP_FLOOR,
        WSP_GGML_UNARY_OP_CEIL,
        WSP_GGML_UNARY_OP_ROUND,
        WSP_GGML_UNARY_OP_TRUNC,

        WSP_GGML_UNARY_OP_COUNT,
    };

    enum wsp_ggml_glu_op {
        WSP_GGML_GLU_OP_REGLU,
        WSP_GGML_GLU_OP_GEGLU,
        WSP_GGML_GLU_OP_SWIGLU,
        WSP_GGML_GLU_OP_SWIGLU_OAI,
        WSP_GGML_GLU_OP_GEGLU_ERF,
        WSP_GGML_GLU_OP_GEGLU_QUICK,

        WSP_GGML_GLU_OP_COUNT,
    };

    enum wsp_ggml_object_type {
        WSP_GGML_OBJECT_TYPE_TENSOR,
        WSP_GGML_OBJECT_TYPE_GRAPH,
        WSP_GGML_OBJECT_TYPE_WORK_BUFFER
    };

    enum wsp_ggml_log_level {
        WSP_GGML_LOG_LEVEL_NONE  = 0,
        WSP_GGML_LOG_LEVEL_DEBUG = 1,
        WSP_GGML_LOG_LEVEL_INFO  = 2,
        WSP_GGML_LOG_LEVEL_WARN  = 3,
        WSP_GGML_LOG_LEVEL_ERROR = 4,
        WSP_GGML_LOG_LEVEL_CONT  = 5, // continue previous log
    };

    // this tensor...
    enum wsp_ggml_tensor_flag {
        WSP_GGML_TENSOR_FLAG_INPUT  =  1, // ...is an input for the GGML compute graph
        WSP_GGML_TENSOR_FLAG_OUTPUT =  2, // ...is an output for the GGML compute graph
        WSP_GGML_TENSOR_FLAG_PARAM  =  4, // ...contains trainable parameters
        WSP_GGML_TENSOR_FLAG_LOSS   =  8, // ...defines loss for numerical optimization (multiple loss tensors add up)
    };

    enum wsp_ggml_tri_type {
        WSP_GGML_TRI_TYPE_UPPER_DIAG = 0,
        WSP_GGML_TRI_TYPE_UPPER      = 1,
        WSP_GGML_TRI_TYPE_LOWER_DIAG = 2,
        WSP_GGML_TRI_TYPE_LOWER      = 3
    };

    struct wsp_ggml_init_params {
        // memory pool
        size_t mem_size;   // bytes
        void * mem_buffer; // if NULL, memory will be allocated internally
        bool   no_alloc;   // don't allocate memory for the tensor data
    };

    // n-dimensional tensor
    struct wsp_ggml_tensor {
        enum wsp_ggml_type type;

        struct wsp_ggml_backend_buffer * buffer;

        int64_t ne[WSP_GGML_MAX_DIMS]; // number of elements
        size_t  nb[WSP_GGML_MAX_DIMS]; // stride in bytes:
                                   // nb[0] = wsp_ggml_type_size(type)
                                   // nb[1] = nb[0]   * (ne[0] / wsp_ggml_blck_size(type)) + padding
                                   // nb[i] = nb[i-1] * ne[i-1]

        // compute data
        enum wsp_ggml_op op;

        // op params - allocated as int32_t for alignment
        int32_t op_params[WSP_GGML_MAX_OP_PARAMS / sizeof(int32_t)];

        int32_t flags;

        struct wsp_ggml_tensor * src[WSP_GGML_MAX_SRC];

        // source tensor and offset for views
        struct wsp_ggml_tensor * view_src;
        size_t               view_offs;

        void * data;

        char name[WSP_GGML_MAX_NAME];

        void * extra; // extra things e.g. for ggml-cuda.cu

        char padding[8];
    };

    static const size_t WSP_GGML_TENSOR_SIZE = sizeof(struct wsp_ggml_tensor);

    // Abort callback
    // If not NULL, called before ggml computation
    // If it returns true, the computation is aborted
    typedef bool (*wsp_ggml_abort_callback)(void * data);


    //
    // GUID
    //

    // GUID types
    typedef uint8_t wsp_ggml_guid[16];
    typedef wsp_ggml_guid * wsp_ggml_guid_t;

    WSP_GGML_API bool wsp_ggml_guid_matches(wsp_ggml_guid_t guid_a, wsp_ggml_guid_t guid_b);

    // misc

    WSP_GGML_API const char * wsp_ggml_version(void);
    WSP_GGML_API const char * wsp_ggml_commit(void);

    WSP_GGML_API void    wsp_ggml_time_init(void); // call this once at the beginning of the program
    WSP_GGML_API int64_t wsp_ggml_time_ms(void);
    WSP_GGML_API int64_t wsp_ggml_time_us(void);
    WSP_GGML_API int64_t wsp_ggml_cycles(void);
    WSP_GGML_API int64_t wsp_ggml_cycles_per_ms(void);

    // accepts a UTF-8 path, even on Windows
    WSP_GGML_API FILE *  wsp_ggml_fopen(const char * fname, const char * mode);

    WSP_GGML_API void    wsp_ggml_print_object (const struct wsp_ggml_object * obj);
    WSP_GGML_API void    wsp_ggml_print_objects(const struct wsp_ggml_context * ctx);

    WSP_GGML_API int64_t wsp_ggml_nelements (const struct wsp_ggml_tensor * tensor);
    WSP_GGML_API int64_t wsp_ggml_nrows     (const struct wsp_ggml_tensor * tensor);
    WSP_GGML_API size_t  wsp_ggml_nbytes    (const struct wsp_ggml_tensor * tensor);
    WSP_GGML_API size_t  wsp_ggml_nbytes_pad(const struct wsp_ggml_tensor * tensor); // same as wsp_ggml_nbytes() but padded to WSP_GGML_MEM_ALIGN

    WSP_GGML_API int64_t wsp_ggml_blck_size(enum wsp_ggml_type type);
    WSP_GGML_API size_t  wsp_ggml_type_size(enum wsp_ggml_type type);             // size in bytes for all elements in a block
    WSP_GGML_API size_t  wsp_ggml_row_size (enum wsp_ggml_type type, int64_t ne); // size in bytes for all elements in a row

    WSP_GGML_DEPRECATED(
    WSP_GGML_API double wsp_ggml_type_sizef(enum wsp_ggml_type type), // wsp_ggml_type_size()/wsp_ggml_blck_size() as float
    "use wsp_ggml_row_size() instead");

    WSP_GGML_API const char * wsp_ggml_type_name(enum wsp_ggml_type type);
    WSP_GGML_API const char * wsp_ggml_op_name  (enum wsp_ggml_op   op);
    WSP_GGML_API const char * wsp_ggml_op_symbol(enum wsp_ggml_op   op);

    WSP_GGML_API const char * wsp_ggml_unary_op_name(enum wsp_ggml_unary_op op);
    WSP_GGML_API const char * wsp_ggml_glu_op_name(enum wsp_ggml_glu_op op);
    WSP_GGML_API const char * wsp_ggml_op_desc(const struct wsp_ggml_tensor * t); // unary or op name

    WSP_GGML_API size_t  wsp_ggml_element_size(const struct wsp_ggml_tensor * tensor);

    WSP_GGML_API bool    wsp_ggml_is_quantized(enum wsp_ggml_type type);

    // TODO: temporary until model loading of ggml examples is refactored
    WSP_GGML_API enum wsp_ggml_type wsp_ggml_ftype_to_wsp_ggml_type(enum wsp_ggml_ftype ftype);

    WSP_GGML_API bool wsp_ggml_is_transposed(const struct wsp_ggml_tensor * tensor);
    WSP_GGML_API bool wsp_ggml_is_permuted  (const struct wsp_ggml_tensor * tensor);
    WSP_GGML_API bool wsp_ggml_is_empty     (const struct wsp_ggml_tensor * tensor);
    WSP_GGML_API bool wsp_ggml_is_scalar    (const struct wsp_ggml_tensor * tensor);
    WSP_GGML_API bool wsp_ggml_is_vector    (const struct wsp_ggml_tensor * tensor);
    WSP_GGML_API bool wsp_ggml_is_matrix    (const struct wsp_ggml_tensor * tensor);
    WSP_GGML_API bool wsp_ggml_is_3d        (const struct wsp_ggml_tensor * tensor);
    WSP_GGML_API int  wsp_ggml_n_dims       (const struct wsp_ggml_tensor * tensor); // returns 1 for scalars

    // returns whether the tensor elements can be iterated over with a flattened index (no gaps, no permutation)
    WSP_GGML_API bool wsp_ggml_is_contiguous  (const struct wsp_ggml_tensor * tensor);
    WSP_GGML_API bool wsp_ggml_is_contiguous_0(const struct wsp_ggml_tensor * tensor); // same as wsp_ggml_is_contiguous()
    WSP_GGML_API bool wsp_ggml_is_contiguous_1(const struct wsp_ggml_tensor * tensor); // contiguous for dims >= 1
    WSP_GGML_API bool wsp_ggml_is_contiguous_2(const struct wsp_ggml_tensor * tensor); // contiguous for dims >= 2

    // returns whether the tensor elements are allocated as one contiguous block of memory (no gaps, but permutation ok)
    WSP_GGML_API bool wsp_ggml_is_contiguously_allocated(const struct wsp_ggml_tensor * tensor);

    // true for tensor that is stored in memory as CxWxHxN and has been permuted to WxHxCxN
    WSP_GGML_API bool wsp_ggml_is_contiguous_channels(const struct wsp_ggml_tensor * tensor);

    // true if the elements in dimension 0 are contiguous, or there is just 1 block of elements
    WSP_GGML_API bool wsp_ggml_is_contiguous_rows(const struct wsp_ggml_tensor * tensor);

    WSP_GGML_API bool wsp_ggml_are_same_shape (const struct wsp_ggml_tensor * t0, const struct wsp_ggml_tensor * t1);
    WSP_GGML_API bool wsp_ggml_are_same_stride(const struct wsp_ggml_tensor * t0, const struct wsp_ggml_tensor * t1);

    WSP_GGML_API bool wsp_ggml_can_repeat(const struct wsp_ggml_tensor * t0, const struct wsp_ggml_tensor * t1);

    // use this to compute the memory overhead of a tensor
    WSP_GGML_API size_t wsp_ggml_tensor_overhead(void);

    WSP_GGML_API bool wsp_ggml_validate_row_data(enum wsp_ggml_type type, const void * data, size_t nbytes);

    // main

    WSP_GGML_API struct wsp_ggml_context * wsp_ggml_init (struct wsp_ggml_init_params params);
    WSP_GGML_API void                  wsp_ggml_reset(struct wsp_ggml_context * ctx);
    WSP_GGML_API void                  wsp_ggml_free (struct wsp_ggml_context * ctx);

    WSP_GGML_API size_t  wsp_ggml_used_mem(const struct wsp_ggml_context * ctx);

    WSP_GGML_API bool    wsp_ggml_get_no_alloc(struct wsp_ggml_context * ctx);
    WSP_GGML_API void    wsp_ggml_set_no_alloc(struct wsp_ggml_context * ctx, bool no_alloc);

    WSP_GGML_API void *  wsp_ggml_get_mem_buffer     (const struct wsp_ggml_context * ctx);
    WSP_GGML_API size_t  wsp_ggml_get_mem_size       (const struct wsp_ggml_context * ctx);
    WSP_GGML_API size_t  wsp_ggml_get_max_tensor_size(const struct wsp_ggml_context * ctx);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_new_tensor(
            struct wsp_ggml_context * ctx,
            enum   wsp_ggml_type type,
            int    n_dims,
            const int64_t *ne);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_new_tensor_1d(
            struct wsp_ggml_context * ctx,
            enum   wsp_ggml_type type,
            int64_t ne0);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_new_tensor_2d(
            struct wsp_ggml_context * ctx,
            enum   wsp_ggml_type type,
            int64_t ne0,
            int64_t ne1);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_new_tensor_3d(
            struct wsp_ggml_context * ctx,
            enum   wsp_ggml_type type,
            int64_t ne0,
            int64_t ne1,
            int64_t ne2);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_new_tensor_4d(
            struct wsp_ggml_context * ctx,
            enum   wsp_ggml_type type,
            int64_t ne0,
            int64_t ne1,
            int64_t ne2,
            int64_t ne3);

    WSP_GGML_API void * wsp_ggml_new_buffer(struct wsp_ggml_context * ctx, size_t nbytes);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_dup_tensor (struct wsp_ggml_context * ctx, const struct wsp_ggml_tensor * src);
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_view_tensor(struct wsp_ggml_context * ctx, struct wsp_ggml_tensor * src);

    // Context tensor enumeration and lookup
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_get_first_tensor(const struct wsp_ggml_context * ctx);
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_get_next_tensor (const struct wsp_ggml_context * ctx, struct wsp_ggml_tensor * tensor);
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_get_tensor(struct wsp_ggml_context * ctx, const char * name);

    // Converts a flat index into coordinates
    WSP_GGML_API void wsp_ggml_unravel_index(const struct wsp_ggml_tensor * tensor, int64_t i, int64_t * i0, int64_t * i1, int64_t * i2, int64_t * i3);

    WSP_GGML_API enum wsp_ggml_unary_op wsp_ggml_get_unary_op(const struct wsp_ggml_tensor * tensor);
    WSP_GGML_API enum wsp_ggml_glu_op wsp_ggml_get_glu_op(const struct wsp_ggml_tensor * tensor);

    WSP_GGML_API void *  wsp_ggml_get_data    (const struct wsp_ggml_tensor * tensor);
    WSP_GGML_API float * wsp_ggml_get_data_f32(const struct wsp_ggml_tensor * tensor);

    WSP_GGML_API const char *         wsp_ggml_get_name   (const struct wsp_ggml_tensor * tensor);
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_set_name   (      struct wsp_ggml_tensor * tensor, const char * name);
    WSP_GGML_ATTRIBUTE_FORMAT(2, 3)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_format_name(      struct wsp_ggml_tensor * tensor, const char * fmt, ...);

    // Tensor flags
    WSP_GGML_API void wsp_ggml_set_input(struct wsp_ggml_tensor * tensor);
    WSP_GGML_API void wsp_ggml_set_output(struct wsp_ggml_tensor * tensor);
    WSP_GGML_API void wsp_ggml_set_param(struct wsp_ggml_tensor * tensor);
    WSP_GGML_API void wsp_ggml_set_loss(struct wsp_ggml_tensor * tensor);

    //
    // operations on tensors with backpropagation
    //

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_dup(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    // in-place, returns view(a)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_dup_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_add(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_add_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_add_cast(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            enum   wsp_ggml_type      type);

    // dst[i0, i1, i2] = a[i0, i1, i2] + b[i0, ids[i1, i2]]
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_add_id(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            struct wsp_ggml_tensor  * ids);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_add1(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_add1_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    // dst = a
    // view(dst, nb1, nb2, nb3, offset) += b
    // return dst
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_acc(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            size_t                nb1,
            size_t                nb2,
            size_t                nb3,
            size_t                offset);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_acc_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            size_t                nb1,
            size_t                nb2,
            size_t                nb3,
            size_t                offset);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_sub(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_sub_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_mul(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_mul_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_div(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_div_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_sqr(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_sqr_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_sqrt(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_sqrt_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_log(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_log_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_expm1(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_expm1_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_softplus(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_softplus_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_sin(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_sin_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_cos(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_cos_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    // return scalar
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_sum(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    // sums along rows, with input shape [a,b,c,d] return shape [1,b,c,d]
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_sum_rows(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_cumsum(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a);

    // mean along rows
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_mean(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    // argmax along rows
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_argmax(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    // count number of equal elements in a and b
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_count_equal(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    // if a is the same shape as b, and a is not parameter, return a
    // otherwise, return a new tensor: repeat(a) to fit in b
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_repeat(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    // repeat a to the specified shape
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_repeat_4d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
                       int64_t    ne0,
                       int64_t    ne1,
                       int64_t    ne2,
                       int64_t    ne3);

    // sums repetitions in a into shape of b
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_repeat_back(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b); // sum up values that are adjacent in dims > 0 instead of repeated with same stride

    // concat a and b along dim
    // used in stable-diffusion
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_concat(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            int                   dim);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_abs(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_abs_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_sgn(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_sgn_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_neg(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_neg_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_step(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_step_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_tanh(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_tanh_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_elu(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_elu_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_relu(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_leaky_relu(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a, float negative_slope, bool inplace);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_relu_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_sigmoid(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_sigmoid_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_gelu(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_gelu_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    // GELU using erf (error function) when possible
    // some backends may fallback to approximation based on Abramowitz and Stegun formula
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_gelu_erf(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_gelu_erf_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_gelu_quick(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_gelu_quick_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_silu(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_silu_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    // a - x
    // b - dy
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_silu_back(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    // hardswish(x) = x * relu6(x + 3) / 6
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_hardswish(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    // hardsigmoid(x) = relu6(x + 3) / 6
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_hardsigmoid(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_exp(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_exp_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_floor(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_floor_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_ceil(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_ceil_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_round(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_round_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

     /**
     * Truncates the fractional part of each element in the tensor (towards zero).
     * For example: trunc(3.7) = 3.0, trunc(-2.9) = -2.0
     * Similar to std::trunc in C/C++.
     */

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_trunc(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_trunc_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);



    // xIELU activation function
    // x = x * (c_a(alpha_n) + c_b(alpha_p, beta) * sigmoid(beta * x)) + eps * (x > 0)
    // where c_a = softplus and c_b(a, b) = softplus(a) + b are constraining functions
    // that constrain the positive and negative source alpha values respectively
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_xielu(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            float alpha_n,
            float alpha_p,
            float beta,
            float eps);

    // gated linear unit ops
    // A: n columns, r rows,
    // result is n / 2 columns, r rows,
    // expects gate in second half of row, unless swapped is true
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_glu(
            struct wsp_ggml_context * ctx,
             struct wsp_ggml_tensor * a,
             enum wsp_ggml_glu_op     op,
             bool                 swapped);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_reglu(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_reglu_swapped(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_geglu(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_geglu_swapped(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_swiglu(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_swiglu_swapped(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_geglu_erf(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_geglu_erf_swapped(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_geglu_quick(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_geglu_quick_swapped(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    // A: n columns, r rows,
    // B: n columns, r rows,
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_glu_split(
            struct wsp_ggml_context * ctx,
             struct wsp_ggml_tensor * a,
             struct wsp_ggml_tensor * b,
             enum wsp_ggml_glu_op     op);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_reglu_split(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_geglu_split(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_swiglu_split(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_geglu_erf_split(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_geglu_quick_split(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_swiglu_oai(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            float                 alpha,
            float                 limit);

    // normalize along rows
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_norm(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            float                 eps);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_norm_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            float                 eps);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_rms_norm(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            float                 eps);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_rms_norm_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            float                 eps);

    // group normalize along ne0*ne1*n_groups
    // used in stable-diffusion
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_group_norm(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                   n_groups,
            float                 eps);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_group_norm_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                   n_groups,
            float                 eps);

    // l2 normalize along rows
    // used in rwkv v7
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_l2_norm(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            float                 eps);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_l2_norm_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            float                 eps);

    // a - x
    // b - dy
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_rms_norm_back(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            float                 eps);

    // A: k columns, n rows => [ne03, ne02, n, k]
    // B: k columns, m rows  (i.e. we transpose it internally) => [ne03 * x, ne02 * y, m, k]
    // result is n columns, m rows => [ne03 * x, ne02 * y, m, n]
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_mul_mat(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    // change the precision of a matrix multiplication
    // set to WSP_GGML_PREC_F32 for higher precision (useful for phi-2)
    WSP_GGML_API void wsp_ggml_mul_mat_set_prec(
            struct wsp_ggml_tensor * a,
            enum wsp_ggml_prec       prec);

    // indirect matrix multiplication
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_mul_mat_id(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * as,
            struct wsp_ggml_tensor  * b,
            struct wsp_ggml_tensor  * ids);

    // A: m columns, n rows,
    // B: p columns, n rows,
    // result is m columns, p rows
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_out_prod(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    //
    // operations on tensors without backpropagation
    //

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_scale(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            float                 s);

    // in-place, returns view(a)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_scale_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            float                 s);

    // x = s * a + b
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_scale_bias(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 s,
        float                 b);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_scale_bias_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        float                 s,
        float                 b);

    // b -> view(a,offset,nb1,nb2,3), return modified a
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_set(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            size_t                nb1,
            size_t                nb2,
            size_t                nb3,
            size_t                offset); // in bytes

    // b -> view(a,offset,nb1,nb2,3), return view(a)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_set_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            size_t                nb1,
            size_t                nb2,
            size_t                nb3,
            size_t                offset); // in bytes

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_set_1d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            size_t                offset); // in bytes

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_set_1d_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            size_t                offset); // in bytes

    // b -> view(a,offset,nb1,nb2,3), return modified a
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_set_2d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            size_t                nb1,
            size_t                offset); // in bytes

    // b -> view(a,offset,nb1,nb2,3), return view(a)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_set_2d_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            size_t                nb1,
            size_t                offset); // in bytes

    // a -> b, return view(b)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_cpy(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    // note: casting from f32 to i32 will discard the fractional part
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_cast(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            enum   wsp_ggml_type      type);

    // make contiguous
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_cont(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    // make contiguous, with new shape
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_cont_1d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int64_t               ne0);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_cont_2d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_cont_3d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1,
            int64_t               ne2);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_cont_4d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1,
            int64_t               ne2,
            int64_t               ne3);

    // return view(a), b specifies the new shape
    // TODO: when we start computing gradient, make a copy instead of view
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_reshape(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    // return view(a)
    // TODO: when we start computing gradient, make a copy instead of view
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_reshape_1d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int64_t               ne0);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_reshape_2d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1);

    // return view(a)
    // TODO: when we start computing gradient, make a copy instead of view
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_reshape_3d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1,
            int64_t               ne2);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_reshape_4d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1,
            int64_t               ne2,
            int64_t               ne3);

    // offset in bytes
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_view_1d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int64_t               ne0,
            size_t                offset);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_view_2d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1,
            size_t                nb1, // row stride in bytes
            size_t                offset);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_view_3d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1,
            int64_t               ne2,
            size_t                nb1, // row   stride in bytes
            size_t                nb2, // slice stride in bytes
            size_t                offset);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_view_4d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1,
            int64_t               ne2,
            int64_t               ne3,
            size_t                nb1, // row   stride in bytes
            size_t                nb2, // slice stride in bytes
            size_t                nb3,
            size_t                offset);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_permute(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                   axis0,
            int                   axis1,
            int                   axis2,
            int                   axis3);

    // alias for wsp_ggml_permute(ctx, a, 1, 0, 2, 3)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_transpose(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    // supports 4D a:
    // a     [n_embd, ne1, ne2, ne3]
    // b I32 [n_rows, ne2, ne3, 1]
    //
    // return [n_embd, n_rows, ne2, ne3]
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_get_rows(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,  // data
            struct wsp_ggml_tensor  * b); // row indices

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_get_rows_back(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,  // gradients of wsp_ggml_get_rows result
            struct wsp_ggml_tensor  * b,  // row indices
            struct wsp_ggml_tensor  * c); // data for wsp_ggml_get_rows, only used for its shape

    // a TD  [n_embd, ne1,    ne2,    ne3]
    // b TS  [n_embd, n_rows, ne02,   ne03] | ne02 == ne2, ne03 == ne3
    // c I64 [n_rows, ne11,   ne12,   1]    | c[i] in [0, ne1)
    //
    // undefined behavior if destination rows overlap
    //
    // broadcast:
    //   ne2 % ne11 == 0
    //   ne3 % ne12 == 0
    //
    // return view(a)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_set_rows(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,  // destination
            struct wsp_ggml_tensor  * b,  // source
            struct wsp_ggml_tensor  * c); // row indices

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_diag(
        struct wsp_ggml_context     * ctx,
        struct wsp_ggml_tensor      * a);

    // set elements above the diagonal to -INF
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_diag_mask_inf(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                   n_past);

    // in-place, returns view(a)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_diag_mask_inf_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                   n_past);

    // set elements above the diagonal to 0
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_diag_mask_zero(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                   n_past);

    // in-place, returns view(a)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_diag_mask_zero_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                   n_past);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_soft_max(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    // in-place, returns view(a)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_soft_max_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a);

    // a    [ne0, ne01, ne02, ne03]
    // mask [ne0, ne11, ne12, ne13] | ne11 >= ne01, F16 or F32, optional
    //
    // broadcast:
    //   ne02 % ne12 == 0
    //   ne03 % ne13 == 0
    //
    // fused soft_max(a*scale + mask*(ALiBi slope))
    // max_bias = 0.0f for no ALiBi
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_soft_max_ext(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * mask,
            float                 scale,
            float                 max_bias);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_soft_max_ext_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * mask,
            float                 scale,
            float                 max_bias);

    WSP_GGML_API void wsp_ggml_soft_max_add_sinks(
            struct wsp_ggml_tensor * a,
            struct wsp_ggml_tensor * sinks);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_soft_max_ext_back(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            float                 scale,
            float                 max_bias);

    // in-place, returns view(a)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_soft_max_ext_back_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            float                 scale,
            float                 max_bias);

    // rotary position embedding
    // if (mode & 1) - skip n_past elements (NOT SUPPORTED)
    // if (mode & WSP_GGML_ROPE_TYPE_NEOX) - GPT-NeoX style
    //
    // b is an int32 vector with size a->ne[2], it contains the positions
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_rope(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            int                   n_dims,
            int                   mode);

    // in-place, returns view(a)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_rope_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            int                   n_dims,
            int                   mode);

    // custom RoPE
    // c is freq factors (e.g. phi3-128k), (optional)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_rope_ext(
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
            float                 beta_slow);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_rope_multi(
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
            float                 beta_slow);

    // in-place, returns view(a)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_rope_ext_inplace(
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
            float                 beta_slow);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_rope_multi_inplace(
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
            float                 beta_slow);

    WSP_GGML_DEPRECATED(WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_rope_custom(
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
            float                 beta_slow),
        "use wsp_ggml_rope_ext instead");

    WSP_GGML_DEPRECATED(WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_rope_custom_inplace(
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
            float                 beta_slow),
        "use wsp_ggml_rope_ext_inplace instead");

    // compute correction dims for YaRN RoPE scaling
    WSP_GGML_API void wsp_ggml_rope_yarn_corr_dims(
        int n_dims, int n_ctx_orig, float freq_base, float beta_fast, float beta_slow, float dims[2]);

    // rotary position embedding backward, i.e compute dx from dy
    // a - dy
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_rope_ext_back(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a, // gradients of wsp_ggml_rope result
            struct wsp_ggml_tensor  * b, // positions
            struct wsp_ggml_tensor  * c, // freq factors
            int                   n_dims,
            int                   mode,
            int                   n_ctx_orig,
            float                 freq_base,
            float                 freq_scale,
            float                 ext_factor,
            float                 attn_factor,
            float                 beta_fast,
            float                 beta_slow);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_rope_multi_back(
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
            float                 beta_slow);


    // clamp
    // in-place, returns view(a)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_clamp(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            float                 min,
            float                 max);

    // im2col
    // converts data into a format that effectively results in a convolution when combined with matrix multiplication
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_im2col(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,  // convolution kernel
            struct wsp_ggml_tensor  * b,  // data
            int                   s0, // stride dimension 0
            int                   s1, // stride dimension 1
            int                   p0, // padding dimension 0
            int                   p1, // padding dimension 1
            int                   d0, // dilation dimension 0
            int                   d1, // dilation dimension 1
            bool                  is_2D,
            enum wsp_ggml_type        dst_type);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_im2col_back(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,  // convolution kernel
        struct wsp_ggml_tensor  * b,  // gradient of im2col output
        int64_t             * ne, // shape of im2col input
        int                   s0, // stride dimension 0
        int                   s1, // stride dimension 1
        int                   p0, // padding dimension 0
        int                   p1, // padding dimension 1
        int                   d0, // dilation dimension 0
        int                   d1, // dilation dimension 1
        bool                  is_2D);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_conv_1d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,   // convolution kernel
            struct wsp_ggml_tensor  * b,   // data
            int                   s0,  // stride
            int                   p0,  // padding
            int                   d0); // dilation

    // conv_1d with padding = half
    // alias for wsp_ggml_conv_1d(a, b, s, a->ne[0]/2, d)
    WSP_GGML_API struct wsp_ggml_tensor* wsp_ggml_conv_1d_ph(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,  // convolution kernel
            struct wsp_ggml_tensor  * b,  // data
            int                   s,  // stride
            int                   d); // dilation

    // depthwise
    // TODO: this is very likely wrong for some cases! - needs more testing
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_conv_1d_dw(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,   // convolution kernel
            struct wsp_ggml_tensor  * b,   // data
            int                   s0,  // stride
            int                   p0,  // padding
            int                   d0); // dilation

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_conv_1d_dw_ph(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,   // convolution kernel
            struct wsp_ggml_tensor  * b,   // data
            int                   s0,  // stride
            int                   d0); // dilation

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_conv_transpose_1d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,   // convolution kernel
            struct wsp_ggml_tensor  * b,   // data
            int                   s0,  // stride
            int                   p0,  // padding
            int                   d0); // dilation

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_conv_2d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,   // convolution kernel
            struct wsp_ggml_tensor  * b,   // data
            int                   s0,  // stride dimension 0
            int                   s1,  // stride dimension 1
            int                   p0,  // padding dimension 0
            int                   p1,  // padding dimension 1
            int                   d0,  // dilation dimension 0
            int                   d1); // dilation dimension 1

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_im2col_3d(
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
            enum wsp_ggml_type        dst_type);

    // a: [OC*IC, KD, KH, KW]
    // b: [N*IC, ID, IH, IW]
    // result: [N*OC, OD, OH, OW]
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_conv_3d(
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
        );

    // kernel size is a->ne[0] x a->ne[1]
    // stride is equal to kernel size
    // padding is zero
    // example:
    // a:     16   16    3  768
    // b:   1024 1024    3    1
    // res:   64   64  768    1
    // used in sam
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_conv_2d_sk_p0(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    // kernel size is a->ne[0] x a->ne[1]
    // stride is 1
    // padding is half
    // example:
    // a:      3    3    256  256
    // b:     64   64    256    1
    // res:   64   64    256    1
    // used in sam
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_conv_2d_s1_ph(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b);

    // depthwise (via im2col and mul_mat)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_conv_2d_dw(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,  // convolution kernel
            struct wsp_ggml_tensor  * b,  // data
            int                  s0,  // stride dimension 0
            int                  s1,  // stride dimension 1
            int                  p0,  // padding dimension 0
            int                  p1,  // padding dimension 1
            int                  d0,  // dilation dimension 0
            int                  d1); // dilation dimension 1

    // Depthwise 2D convolution
    // may be faster than wsp_ggml_conv_2d_dw, but not available in all backends
    // a:   KW    KH    1    C    convolution kernel
    // b:   W     H     C    N    input data
    // res: W_out H_out C    N
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_conv_2d_dw_direct(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            int                   stride0,
            int                   stride1,
            int                   pad0,
            int                   pad1,
            int                   dilation0,
            int                   dilation1);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_conv_transpose_2d_p0(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            int                   stride);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_conv_2d_direct(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,   // convolution kernel [KW, KH, IC, OC]
            struct wsp_ggml_tensor  * b,   // input data [W, H, C, N]
            int                   s0,  // stride dimension 0
            int                   s1,  // stride dimension 1
            int                   p0,  // padding dimension 0
            int                   p1,  // padding dimension 1
            int                   d0,  // dilation dimension 0
            int                   d1); // dilation dimension 1

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_conv_3d_direct(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,   // kernel [KW, KH, KD, IC * OC]
            struct wsp_ggml_tensor  * b,   // input  [W, H, D, C * N]
            int                   s0,  // stride
            int                   s1,
            int                   s2,
            int                   p0,  // padding
            int                   p1,
            int                   p2,
            int                   d0,  // dilation
            int                   d1,
            int                   d2,
            int                   n_channels,
            int                   n_batch,
            int                   n_channels_out);

    enum wsp_ggml_op_pool {
        WSP_GGML_OP_POOL_MAX,
        WSP_GGML_OP_POOL_AVG,
        WSP_GGML_OP_POOL_COUNT,
    };

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_pool_1d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            enum wsp_ggml_op_pool     op,
            int                   k0, // kernel size
            int                   s0, // stride
            int                   p0); // padding

    // the result will have 2*p0 padding for the first dimension
    // and 2*p1 padding for the second dimension
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_pool_2d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            enum wsp_ggml_op_pool     op,
            int                   k0,
            int                   k1,
            int                   s0,
            int                   s1,
            float                 p0,
            float                 p1);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_pool_2d_back(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * af, // "a"/input used in forward pass
            enum wsp_ggml_op_pool     op,
            int                   k0,
            int                   k1,
            int                   s0,
            int                   s1,
            float                 p0,
            float                 p1);

    enum wsp_ggml_scale_mode {
        WSP_GGML_SCALE_MODE_NEAREST  = 0,
        WSP_GGML_SCALE_MODE_BILINEAR = 1,
        WSP_GGML_SCALE_MODE_BICUBIC  = 2,

        WSP_GGML_SCALE_MODE_COUNT
    };

    enum wsp_ggml_scale_flag {
        WSP_GGML_SCALE_FLAG_ALIGN_CORNERS = (1 << 8)
    };

    // interpolate
    // multiplies ne0 and ne1 by scale factor
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_upscale(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                   scale_factor,
            enum wsp_ggml_scale_mode  mode);

    // interpolate
    // interpolate scale to specified dimensions
    WSP_GGML_DEPRECATED(WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_upscale_ext(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                   ne0,
            int                   ne1,
            int                   ne2,
            int                   ne3,
            enum wsp_ggml_scale_mode  mode),
        "use wsp_ggml_interpolate instead");

    // Up- or downsamples the input to the specified size.
    // 2D scale modes (eg. bilinear) are applied to the first two dimensions.
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_interpolate(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int64_t               ne0,
            int64_t               ne1,
            int64_t               ne2,
            int64_t               ne3,
            uint32_t              mode); // wsp_ggml_scale_mode [ | wsp_ggml_scale_flag...]

    // pad each dimension with zeros: [x, ..., x] -> [x, ..., x, 0, ..., 0]
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_pad(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                  p0,
            int                  p1,
            int                  p2,
            int                  p3);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_pad_ext(
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
            );

    // pad each dimension with reflection: [a, b, c, d] -> [b, a, b, c, d, c]
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_pad_reflect_1d(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                   p0,
            int                   p1);

    // Move tensor elements by an offset given for each dimension. Elements that
    // are shifted beyond the last position are wrapped around to the beginning.
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_roll(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                   shift0,
            int                   shift1,
            int                   shift2,
            int                   shift3);

    // Convert matrix into a triangular one (upper, strict upper, lower or strict lower) by writing
    // zeroes everywhere outside the masked area
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_tri(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            enum wsp_ggml_tri_type    type);

    // Fill tensor a with constant c
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_fill(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            float                 c);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_fill_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            float                 c);

    // Ref: https://github.com/CompVis/stable-diffusion/blob/main/ldm/modules/diffusionmodules/util.py#L151
    // timesteps: [N,]
    // return: [N, dim]
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_timestep_embedding(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * timesteps,
            int                   dim,
            int                   max_period);

    // sort rows
    enum wsp_ggml_sort_order {
        WSP_GGML_SORT_ORDER_ASC,
        WSP_GGML_SORT_ORDER_DESC,
    };

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_argsort(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            enum wsp_ggml_sort_order  order);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_arange(
            struct wsp_ggml_context * ctx,
            float                 start,
            float                 stop,
            float                 step);

    // top k elements per row
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_top_k(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                   k);

#define WSP_GGML_KQ_MASK_PAD 64

    // q:    [n_embd_k, n_batch,     n_head,    ne3 ]
    // k:    [n_embd_k, n_kv,        n_head_kv, ne3 ]
    // v:    [n_embd_v, n_kv,        n_head_kv, ne3 ] !! not transposed !!
    // mask: [n_kv,     n_batch_pad, ne32,      ne33] !! n_batch_pad = WSP_GGML_PAD(n_batch, WSP_GGML_KQ_MASK_PAD) !!
    // res:  [n_embd_v, n_head,      n_batch,   ne3 ] !! permuted !!
    //
    // broadcast:
    //   n_head % n_head_kv == 0
    //   n_head % ne32      == 0
    //   ne3    % ne33      == 0
    //
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_flash_attn_ext(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * q,
            struct wsp_ggml_tensor  * k,
            struct wsp_ggml_tensor  * v,
            struct wsp_ggml_tensor  * mask,
            float                 scale,
            float                 max_bias,
            float                 logit_softcap);

    WSP_GGML_API void wsp_ggml_flash_attn_ext_set_prec(
            struct wsp_ggml_tensor * a,
            enum wsp_ggml_prec       prec);

    WSP_GGML_API enum wsp_ggml_prec wsp_ggml_flash_attn_ext_get_prec(
            const struct wsp_ggml_tensor * a);

    WSP_GGML_API void wsp_ggml_flash_attn_ext_add_sinks(
            struct wsp_ggml_tensor * a,
            struct wsp_ggml_tensor * sinks);

    // TODO: needs to be adapted to wsp_ggml_flash_attn_ext
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_flash_attn_back(
           struct wsp_ggml_context * ctx,
           struct wsp_ggml_tensor  * q,
           struct wsp_ggml_tensor  * k,
           struct wsp_ggml_tensor  * v,
           struct wsp_ggml_tensor  * d,
           bool                  masked);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_ssm_conv(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * sx,
            struct wsp_ggml_tensor  * c);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_ssm_scan(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * s,
            struct wsp_ggml_tensor  * x,
            struct wsp_ggml_tensor  * dt,
            struct wsp_ggml_tensor  * A,
            struct wsp_ggml_tensor  * B,
            struct wsp_ggml_tensor  * C,
            struct wsp_ggml_tensor  * ids);

    // partition into non-overlapping windows with padding if needed
    // example:
    // a:   768   64   64    1
    // w:    14
    // res: 768   14   14    25
    // used in sam
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_win_part(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                   w);

    // reverse of wsp_ggml_win_part
    // used in sam
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_win_unpart(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                   w0,
            int                   h0,
            int                   w);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_unary(
            struct wsp_ggml_context * ctx,
             struct wsp_ggml_tensor * a,
             enum wsp_ggml_unary_op op);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_unary_inplace(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        enum wsp_ggml_unary_op op);

    // used in sam
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_get_rel_pos(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            int                   qh,
            int                   kh);

    // used in sam
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_add_rel_pos(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * pw,
            struct wsp_ggml_tensor  * ph);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_add_rel_pos_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * pw,
            struct wsp_ggml_tensor  * ph);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_rwkv_wkv6(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * k,
            struct wsp_ggml_tensor  * v,
            struct wsp_ggml_tensor  * r,
            struct wsp_ggml_tensor  * tf,
            struct wsp_ggml_tensor  * td,
            struct wsp_ggml_tensor  * state);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_gated_linear_attn(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * k,
            struct wsp_ggml_tensor  * v,
            struct wsp_ggml_tensor  * q,
            struct wsp_ggml_tensor  * g,
            struct wsp_ggml_tensor  * state,
            float scale);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_rwkv_wkv7(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * r,
            struct wsp_ggml_tensor  * w,
            struct wsp_ggml_tensor  * k,
            struct wsp_ggml_tensor  * v,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * b,
            struct wsp_ggml_tensor  * state);

    /* Solves a specific equation of the form Ax=B, where A is a triangular matrix
    *  without zeroes on the diagonal (i.e. invertible).
    *  B can have any number of columns, but must have the same number of rows as A
    *  If A is [n, n] and B is [n, m], then the result will be [n, m] as well
    *  Has O(n^3) complexity (unlike most matrix ops out there), so use on cases
    *  where n > 100 sparingly, pre-chunk if necessary.
    *
    *  If left = false, solves xA=B instead
    *  If lower = false, assumes upper triangular instead
    *  If uni = true, assumes diagonal of A to be all ones (will override actual values)
    *
    *  TODO: currently only lower, right, non-unitriangular variant is implemented
    */
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_solve_tri(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor  * a,
        struct wsp_ggml_tensor  * b,
        bool                  left,
        bool                  lower,
        bool                  uni);

    // custom operators

    typedef void (*wsp_ggml_custom1_op_t)(struct wsp_ggml_tensor * dst , const struct wsp_ggml_tensor * a, int ith, int nth, void * userdata);
    typedef void (*wsp_ggml_custom2_op_t)(struct wsp_ggml_tensor * dst , const struct wsp_ggml_tensor * a, const struct wsp_ggml_tensor * b, int ith, int nth, void * userdata);
    typedef void (*wsp_ggml_custom3_op_t)(struct wsp_ggml_tensor * dst , const struct wsp_ggml_tensor * a, const struct wsp_ggml_tensor * b, const struct wsp_ggml_tensor * c, int ith, int nth, void * userdata);

#define WSP_GGML_N_TASKS_MAX (-1)
    // n_tasks == WSP_GGML_N_TASKS_MAX means to use max number of tasks

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_map_custom1(
            struct wsp_ggml_context   * ctx,
            struct wsp_ggml_tensor    * a,
            wsp_ggml_custom1_op_t       fun,
            int                     n_tasks,
            void                  * userdata);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_map_custom1_inplace(
            struct wsp_ggml_context   * ctx,
            struct wsp_ggml_tensor    * a,
            wsp_ggml_custom1_op_t       fun,
            int                     n_tasks,
            void                  * userdata);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_map_custom2(
            struct wsp_ggml_context   * ctx,
            struct wsp_ggml_tensor    * a,
            struct wsp_ggml_tensor    * b,
            wsp_ggml_custom2_op_t       fun,
            int                     n_tasks,
            void                  * userdata);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_map_custom2_inplace(
            struct wsp_ggml_context   * ctx,
            struct wsp_ggml_tensor    * a,
            struct wsp_ggml_tensor    * b,
            wsp_ggml_custom2_op_t       fun,
            int                     n_tasks,
            void                  * userdata);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_map_custom3(
            struct wsp_ggml_context   * ctx,
            struct wsp_ggml_tensor    * a,
            struct wsp_ggml_tensor    * b,
            struct wsp_ggml_tensor    * c,
            wsp_ggml_custom3_op_t       fun,
            int                     n_tasks,
            void                  * userdata);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_map_custom3_inplace(
            struct wsp_ggml_context   * ctx,
            struct wsp_ggml_tensor    * a,
            struct wsp_ggml_tensor    * b,
            struct wsp_ggml_tensor    * c,
            wsp_ggml_custom3_op_t       fun,
            int                     n_tasks,
            void                  * userdata);

    typedef void (*wsp_ggml_custom_op_t)(struct wsp_ggml_tensor * dst , int ith, int nth, void * userdata);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_custom_4d(
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
            void                * userdata);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_custom_inplace(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor ** args,
            int                   n_args,
            wsp_ggml_custom_op_t      fun,
            int                   n_tasks,
            void                * userdata);

    // loss function

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_cross_entropy_loss(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,  // logits
            struct wsp_ggml_tensor  * b); // labels

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_cross_entropy_loss_back(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,  // logits
            struct wsp_ggml_tensor  * b,  // labels
            struct wsp_ggml_tensor  * c); // gradients of cross_entropy_loss result

    // AdamW optimizer step
    // Paper: https://arxiv.org/pdf/1711.05101v3.pdf
    // PyTorch: https://pytorch.org/docs/stable/generated/torch.optim.AdamW.html
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_opt_step_adamw(
            struct wsp_ggml_context * ctx,
            struct wsp_ggml_tensor  * a,
            struct wsp_ggml_tensor  * grad,
            struct wsp_ggml_tensor  * m,
            struct wsp_ggml_tensor  * v,
            struct wsp_ggml_tensor  * adamw_params); // parameters such as the learning rate

    // stochastic gradient descent step (with weight decay)
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_opt_step_sgd(
        struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor *  a,
        struct wsp_ggml_tensor *  grad,
        struct wsp_ggml_tensor *  sgd_params); // alpha, weight decay

    //
    // automatic differentiation
    //

    WSP_GGML_API void wsp_ggml_build_forward_expand(struct wsp_ggml_cgraph * cgraph, struct wsp_ggml_tensor * tensor);
    WSP_GGML_API void wsp_ggml_build_backward_expand(
        struct wsp_ggml_context *  ctx,        // context for gradient computation
        struct wsp_ggml_cgraph  *  cgraph,
        struct wsp_ggml_tensor  ** grad_accs);

    // graph allocation in a context
    WSP_GGML_API struct wsp_ggml_cgraph * wsp_ggml_new_graph       (struct wsp_ggml_context * ctx); // size = WSP_GGML_DEFAULT_GRAPH_SIZE, grads = false
    WSP_GGML_API struct wsp_ggml_cgraph * wsp_ggml_new_graph_custom(struct wsp_ggml_context * ctx, size_t size, bool grads);
    WSP_GGML_API struct wsp_ggml_cgraph * wsp_ggml_graph_dup       (struct wsp_ggml_context * ctx, struct wsp_ggml_cgraph * cgraph, bool force_grads);
    WSP_GGML_API void                 wsp_ggml_graph_cpy       (struct wsp_ggml_cgraph * src, struct wsp_ggml_cgraph * dst);
    WSP_GGML_API void                 wsp_ggml_graph_reset     (struct wsp_ggml_cgraph * cgraph); // set regular grads + optimizer momenta to 0, set loss grad to 1
    WSP_GGML_API void                 wsp_ggml_graph_clear     (struct wsp_ggml_cgraph * cgraph);

    WSP_GGML_API int                   wsp_ggml_graph_size   (struct wsp_ggml_cgraph * cgraph);
    WSP_GGML_API struct wsp_ggml_tensor *  wsp_ggml_graph_node   (struct wsp_ggml_cgraph * cgraph, int i); // if i < 0, returns nodes[n_nodes + i]
    WSP_GGML_API struct wsp_ggml_tensor ** wsp_ggml_graph_nodes  (struct wsp_ggml_cgraph * cgraph);
    WSP_GGML_API int                   wsp_ggml_graph_n_nodes(struct wsp_ggml_cgraph * cgraph);

    WSP_GGML_API void   wsp_ggml_graph_add_node(struct wsp_ggml_cgraph * cgraph, struct wsp_ggml_tensor * tensor);

    WSP_GGML_API size_t wsp_ggml_graph_overhead(void);
    WSP_GGML_API size_t wsp_ggml_graph_overhead_custom(size_t size, bool grads);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_graph_get_tensor  (const struct wsp_ggml_cgraph * cgraph, const char * name);
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_graph_get_grad    (const struct wsp_ggml_cgraph * cgraph, const struct wsp_ggml_tensor * node);
    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_graph_get_grad_acc(const struct wsp_ggml_cgraph * cgraph, const struct wsp_ggml_tensor * node);

    // print info and performance information for the graph
    WSP_GGML_API void wsp_ggml_graph_print(const struct wsp_ggml_cgraph * cgraph);

    // dump the graph into a file using the dot format
    WSP_GGML_API void wsp_ggml_graph_dump_dot(const struct wsp_ggml_cgraph * gb, const struct wsp_ggml_cgraph * gf, const char * filename);

    // TODO these functions were sandwiched in the old optimization interface, is there a better place for them?
    typedef void (*wsp_ggml_log_callback)(enum wsp_ggml_log_level level, const char * text, void * user_data);

    // Set callback for all future logging events.
    // If this is not called, or NULL is supplied, everything is output on stderr.
    WSP_GGML_API void wsp_ggml_log_set(wsp_ggml_log_callback log_callback, void * user_data);

    WSP_GGML_API struct wsp_ggml_tensor * wsp_ggml_set_zero(struct wsp_ggml_tensor * tensor);

    //
    // quantization
    //

    // - wsp_ggml_wsp_quantize_init can be called multiple times with the same type
    //   it will only initialize the quantization tables for the first call or after wsp_ggml_wsp_quantize_free
    //   automatically called by wsp_ggml_wsp_quantize_chunk for convenience
    //
    // - wsp_ggml_wsp_quantize_free will free any memory allocated by wsp_ggml_wsp_quantize_init
    //   call this at the end of the program to avoid memory leaks
    //
    // note: these are thread-safe
    //
    WSP_GGML_API void wsp_ggml_wsp_quantize_init(enum wsp_ggml_type type);
    WSP_GGML_API void wsp_ggml_wsp_quantize_free(void);

    // some quantization type cannot be used without an importance matrix
    WSP_GGML_API bool wsp_ggml_wsp_quantize_requires_imatrix(enum wsp_ggml_type type);

    // calls wsp_ggml_wsp_quantize_init internally (i.e. can allocate memory)
    WSP_GGML_API size_t wsp_ggml_wsp_quantize_chunk(
            enum wsp_ggml_type   type,
               const float * src,
                      void * dst,
                   int64_t   start,
                   int64_t   nrows,
                   int64_t   n_per_row,
               const float * imatrix);

#ifdef __cplusplus
    // restrict not standard in C++
#    if defined(__GNUC__)
#        define WSP_GGML_RESTRICT __restrict__
#    elif defined(__clang__)
#        define WSP_GGML_RESTRICT __restrict
#    elif defined(_MSC_VER)
#        define WSP_GGML_RESTRICT __restrict
#    else
#        define WSP_GGML_RESTRICT
#    endif
#else
#    if defined (_MSC_VER) && (__STDC_VERSION__ < 201112L)
#        define WSP_GGML_RESTRICT __restrict
#    else
#        define WSP_GGML_RESTRICT restrict
#    endif
#endif
    typedef void (*wsp_ggml_to_float_t)  (const void  * WSP_GGML_RESTRICT x, float * WSP_GGML_RESTRICT y, int64_t k);
    typedef void (*wsp_ggml_from_float_t)(const float * WSP_GGML_RESTRICT x, void  * WSP_GGML_RESTRICT y, int64_t k);

    struct wsp_ggml_type_traits {
        const char             * type_name;
        int64_t                  blck_size;
        int64_t                  blck_size_interleave; // interleave elements in blocks
        size_t                   type_size;
        bool                     is_quantized;
        wsp_ggml_to_float_t          to_float;
        wsp_ggml_from_float_t        from_float_ref;
    };

    WSP_GGML_API const struct wsp_ggml_type_traits * wsp_ggml_get_type_traits(enum wsp_ggml_type type);

    // ggml threadpool
    // TODO: currently, only a few functions are in the base ggml API, while the rest are in the CPU backend
    // the goal should be to create an API that other backends can use move everything to the ggml base

    // scheduling priorities
    enum wsp_ggml_sched_priority {
        WSP_GGML_SCHED_PRIO_LOW = -1,
        WSP_GGML_SCHED_PRIO_NORMAL,
        WSP_GGML_SCHED_PRIO_MEDIUM,
        WSP_GGML_SCHED_PRIO_HIGH,
        WSP_GGML_SCHED_PRIO_REALTIME
    };

    // threadpool params
    // Use wsp_ggml_threadpool_params_default() or wsp_ggml_threadpool_params_init() to populate the defaults
    struct wsp_ggml_threadpool_params {
        bool                cpumask[WSP_GGML_MAX_N_THREADS]; // mask of cpu cores (all-zeros means use default affinity settings)
        int                 n_threads;                   // number of threads
        enum wsp_ggml_sched_priority prio;                   // thread priority
        uint32_t            poll;                        // polling level (0 - no polling, 100 - aggressive polling)
        bool                strict_cpu;                  // strict cpu placement
        bool                paused;                      // start in paused state
    };

    struct wsp_ggml_threadpool;     // forward declaration, see ggml.c

    typedef struct wsp_ggml_threadpool * wsp_ggml_threadpool_t;

    WSP_GGML_API struct wsp_ggml_threadpool_params wsp_ggml_threadpool_params_default(int n_threads);
    WSP_GGML_API void                          wsp_ggml_threadpool_params_init   (struct wsp_ggml_threadpool_params * p, int n_threads);
    WSP_GGML_API bool                          wsp_ggml_threadpool_params_match  (const struct wsp_ggml_threadpool_params * p0, const struct wsp_ggml_threadpool_params * p1);

#ifdef  __cplusplus
}
#endif
