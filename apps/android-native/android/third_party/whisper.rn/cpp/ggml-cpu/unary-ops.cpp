#include "unary-ops.h"

static inline float op_abs(float x) {
    return fabsf(x);
}

static inline float op_sgn(float x) {
    return (x > 0.f) ? 1.f : ((x < 0.f) ? -1.f : 0.f);
}

static inline float op_neg(float x) {
    return -x;
}

static inline float op_step(float x) {
    return (x > 0.f) ? 1.f : 0.f;
}

static inline float op_tanh(float x) {
    return tanhf(x);
}

static inline float op_elu(float x) {
    return (x > 0.f) ? x : expm1f(x);
}

static inline float op_relu(float x) {
    return (x > 0.f) ? x : 0.f;
}

static inline float op_sigmoid(float x) {
    return 1.f / (1.f + expf(-x));
}

static inline float op_hardsigmoid(float x) {
    return fminf(1.0f, fmaxf(0.0f, (x + 3.0f) / 6.0f));
}

static inline float op_exp(float x) {
    return expf(x);
}

static inline float op_hardswish(float x) {
    return x * fminf(1.0f, fmaxf(0.0f, (x + 3.0f) / 6.0f));
}

static inline float op_sqr(float x) {
    return x * x;
}

static inline float op_sqrt(float x) {
    return sqrtf(x);
}

static inline float op_xielu(float x, float alpha_n, float alpha_p, float beta, float eps) {
    if (x > 0.0f) {
        return alpha_p * x * x + beta * x;
    } else {
        const float min_x_eps = fminf(x, eps);
        return (expm1f(min_x_eps) - x) * alpha_n + beta * x;
    }
}

static inline float op_sin(float x) {
    return sinf(x);
}

static inline float op_cos(float x) {
    return cosf(x);
}

static inline float op_log(float x) {
    return logf(x);
}

static inline float op_expm1(float x) {
    return expf(x) - 1.0f;
}

static inline float op_softplus(float x) {
    return (x > 20.0f) ? x : logf(1.0f + expf(x));
}

static inline float op_floor(float x) {
    return floorf(x);
}

static inline float op_ceil(float x) {
    return ceilf(x);
}

static inline float op_round(float x) {
    return roundf(x);
}

static inline float op_trunc(float x) {
    return truncf(x);
}

template <float (*op)(float), typename src0_t, typename dst_t>
static inline void vec_unary_op(int64_t n, dst_t * y, const src0_t * x) {
    constexpr auto src0_to_f32 = type_conversion_table<src0_t>::to_f32;
    constexpr auto f32_to_dst  = type_conversion_table<dst_t >::from_f32;

    for (int i = 0; i < n; i++) {
        y[i] = f32_to_dst(op(src0_to_f32(x[i])));
    }
}

template <float (*op)(float), typename src0_t, typename dst_t>
static void apply_unary_op(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    const wsp_ggml_tensor * src0 = dst->src[0];

    WSP_GGML_ASSERT(wsp_ggml_is_contiguous_1(src0) && wsp_ggml_is_contiguous_1(dst) && wsp_ggml_are_same_shape(src0, dst));

    WSP_GGML_TENSOR_UNARY_OP_LOCALS

    WSP_GGML_ASSERT( nb0 == sizeof(dst_t));
    WSP_GGML_ASSERT(nb00 == sizeof(src0_t));

    const auto [ir0, ir1] = get_thread_range(params, src0);

    for (int64_t ir = ir0; ir < ir1; ++ir) {
        const int64_t i03 = ir/(ne02*ne01);
        const int64_t i02 = (ir - i03*ne02*ne01)/ne01;
        const int64_t i01 = (ir - i03*ne02*ne01 - i02*ne01);

        dst_t        * dst_ptr  = (dst_t  *)       ((char *)       dst->data  + i03*nb3  + i02*nb2  + i01*nb1 );
        const src0_t * src0_ptr = (const src0_t *) ((const char *) src0->data + i03*nb03 + i02*nb02 + i01*nb01);

        vec_unary_op<op>(ne0, dst_ptr, src0_ptr);
    }
}

// TODO: Use the 'traits' lookup table (for type conversion fns), instead of a mass of 'if' conditions with long templates
template <float (*op)(float)>
static void unary_op(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    const wsp_ggml_tensor * src0 = dst->src[0];

    /*  */ if (src0->type == WSP_GGML_TYPE_F32  && dst->type == WSP_GGML_TYPE_F32) { // all f32
        apply_unary_op<op, float, float>(params, dst);
    } else if (src0->type == WSP_GGML_TYPE_F16  && dst->type == WSP_GGML_TYPE_F16) { // all f16
        apply_unary_op<op, wsp_ggml_fp16_t, wsp_ggml_fp16_t>(params, dst);
    } else if (src0->type == WSP_GGML_TYPE_BF16 && dst->type == WSP_GGML_TYPE_BF16) { // all bf16
        apply_unary_op<op, wsp_ggml_bf16_t, wsp_ggml_bf16_t>(params, dst);
    } else if (src0->type == WSP_GGML_TYPE_BF16 && dst->type == WSP_GGML_TYPE_F32) {
        apply_unary_op<op, wsp_ggml_bf16_t, float>(params, dst);
    } else if (src0->type == WSP_GGML_TYPE_F16  && dst->type == WSP_GGML_TYPE_F32) {
        apply_unary_op<op, wsp_ggml_fp16_t, float>(params, dst);
    } else {
        fprintf(stderr, "%s: unsupported types: dst: %s, src0: %s\n", __func__,
            wsp_ggml_type_name(dst->type), wsp_ggml_type_name(src0->type));
        WSP_GGML_ABORT("fatal error");
    }
}

template <float (*op)(float, wsp_ggml_tensor *)>
static void unary_op_params(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    const wsp_ggml_tensor * src0 = dst->src[0];

    /*  */ if (src0->type == WSP_GGML_TYPE_F32  && dst->type == WSP_GGML_TYPE_F32) { // all f32
        apply_unary_op<op, float, float>(params, dst);
    } else if (src0->type == WSP_GGML_TYPE_F16  && dst->type == WSP_GGML_TYPE_F16) { // all f16
        apply_unary_op<op, wsp_ggml_fp16_t, wsp_ggml_fp16_t>(params, dst);
    } else if (src0->type == WSP_GGML_TYPE_BF16 && dst->type == WSP_GGML_TYPE_BF16) { // all bf16
        apply_unary_op<op, wsp_ggml_bf16_t, wsp_ggml_bf16_t>(params, dst);
    } else if (src0->type == WSP_GGML_TYPE_BF16 && dst->type == WSP_GGML_TYPE_F32) {
        apply_unary_op<op, wsp_ggml_bf16_t, float>(params, dst);
    } else if (src0->type == WSP_GGML_TYPE_F16  && dst->type == WSP_GGML_TYPE_F32) {
        apply_unary_op<op, wsp_ggml_fp16_t, float>(params, dst);
    } else {
        fprintf(stderr, "%s: unsupported types: dst: %s, src0: %s\n", __func__,
            wsp_ggml_type_name(dst->type), wsp_ggml_type_name(src0->type));
        WSP_GGML_ABORT("fatal error");
    }
}

// Extend vec_unary_op to support functors
template <typename Op, typename src0_t, typename dst_t>
static inline void vec_unary_op_functor(int64_t n, dst_t * y, const src0_t * x, Op op) {
    constexpr auto src0_to_f32 = type_conversion_table<src0_t>::to_f32;
    constexpr auto f32_to_dst  = type_conversion_table<dst_t >::from_f32;

    for (int i = 0; i < n; i++) {
        y[i] = f32_to_dst(op(src0_to_f32(x[i])));
    }
}

// Extend apply_unary_op to support functors
template <typename Op, typename src0_t, typename dst_t>
static void apply_unary_op_functor(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst, Op op) {
    const wsp_ggml_tensor * src0 = dst->src[0];

    WSP_GGML_ASSERT(wsp_ggml_is_contiguous_1(src0) && wsp_ggml_is_contiguous_1(dst) && wsp_ggml_are_same_shape(src0, dst));

    WSP_GGML_TENSOR_UNARY_OP_LOCALS

    WSP_GGML_ASSERT( nb0 == sizeof(dst_t));
    WSP_GGML_ASSERT(nb00 == sizeof(src0_t));

    const auto [ir0, ir1] = get_thread_range(params, src0);

    for (int64_t ir = ir0; ir < ir1; ++ir) {
        const int64_t i03 = ir/(ne02*ne01);
        const int64_t i02 = (ir - i03*ne02*ne01)/ne01;
        const int64_t i01 = (ir - i03*ne02*ne01 - i02*ne01);

        dst_t        * dst_ptr  = (dst_t  *)       ((char *)       dst->data  + i03*nb3  + i02*nb2  + i01*nb1 );
        const src0_t * src0_ptr = (const src0_t *) ((const char *) src0->data + i03*nb03 + i02*nb02 + i01*nb01);

        vec_unary_op_functor(ne0, dst_ptr, src0_ptr, op);
    }
}

// Generic dispatcher for functors
template <typename Op>
static void unary_op_functor(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst, Op op) {
    const wsp_ggml_tensor * src0 = dst->src[0];

    /*  */ if (src0->type == WSP_GGML_TYPE_F32  && dst->type == WSP_GGML_TYPE_F32) { // all f32
        apply_unary_op_functor<Op, float, float>(params, dst, op);
    } else if (src0->type == WSP_GGML_TYPE_F16  && dst->type == WSP_GGML_TYPE_F16) { // all f16
        apply_unary_op_functor<Op, wsp_ggml_fp16_t, wsp_ggml_fp16_t>(params, dst, op);
    } else if (src0->type == WSP_GGML_TYPE_BF16 && dst->type == WSP_GGML_TYPE_BF16) { // all bf16
        apply_unary_op_functor<Op, wsp_ggml_bf16_t, wsp_ggml_bf16_t>(params, dst, op);
    } else if (src0->type == WSP_GGML_TYPE_BF16 && dst->type == WSP_GGML_TYPE_F32) {
        apply_unary_op_functor<Op, wsp_ggml_bf16_t, float>(params, dst, op);
    } else if (src0->type == WSP_GGML_TYPE_F16  && dst->type == WSP_GGML_TYPE_F32) {
        apply_unary_op_functor<Op, wsp_ggml_fp16_t, float>(params, dst, op);
    } else {
        fprintf(stderr, "%s: unsupported types: dst: %s, src0: %s\n", __func__,
            wsp_ggml_type_name(dst->type), wsp_ggml_type_name(src0->type));
        WSP_GGML_ABORT("fatal error");
    }
}

void wsp_ggml_compute_forward_abs(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_abs>(params, dst);
}

void wsp_ggml_compute_forward_sgn(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_sgn>(params, dst);
}

void wsp_ggml_compute_forward_neg(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_neg>(params, dst);
}

void wsp_ggml_compute_forward_step(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_step>(params, dst);
}

void wsp_ggml_compute_forward_tanh(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_tanh>(params, dst);
}

void wsp_ggml_compute_forward_elu(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_elu>(params, dst);
}

void wsp_ggml_compute_forward_relu(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_relu>(params, dst);
}

void wsp_ggml_compute_forward_sigmoid(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_sigmoid>(params, dst);
}

void wsp_ggml_compute_forward_hardsigmoid(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_hardsigmoid>(params, dst);
}

void wsp_ggml_compute_forward_exp(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_exp>(params, dst);
}

void wsp_ggml_compute_forward_hardswish(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_hardswish>(params, dst);
}

void wsp_ggml_compute_forward_sqr(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_sqr>(params, dst);
}

void wsp_ggml_compute_forward_sqrt(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_sqrt>(params, dst);
}

void wsp_ggml_compute_forward_sin(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_sin>(params, dst);
}

void wsp_ggml_compute_forward_cos(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_cos>(params, dst);
}

void wsp_ggml_compute_forward_log(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_log>(params, dst);
}

void wsp_ggml_compute_forward_expm1(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_expm1>(params, dst);
}

void wsp_ggml_compute_forward_softplus(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_softplus>(params, dst);
}

void wsp_ggml_compute_forward_floor(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_floor>(params, dst);
}

void wsp_ggml_compute_forward_ceil(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_ceil>(params, dst);
}

void wsp_ggml_compute_forward_round(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_round>(params, dst);
}

void wsp_ggml_compute_forward_trunc(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    unary_op<op_trunc>(params, dst);
}

void wsp_ggml_compute_forward_xielu(const wsp_ggml_compute_params * params, wsp_ggml_tensor * dst) {
    const float alpha_n = wsp_ggml_get_op_params_f32(dst, 1);
    const float alpha_p = wsp_ggml_get_op_params_f32(dst, 2);
    const float beta = wsp_ggml_get_op_params_f32(dst, 3);
    const float eps = wsp_ggml_get_op_params_f32(dst, 4);

    const auto xielu_op_params = [alpha_n, alpha_p, beta, eps](float f) {
        return op_xielu(f, alpha_n, alpha_p, beta, eps);
    };

    unary_op_functor(params, dst, xielu_op_params);
}

