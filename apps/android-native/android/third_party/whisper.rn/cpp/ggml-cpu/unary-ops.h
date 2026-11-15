#pragma once

#include "common.h"

#ifdef __cplusplus
extern "C" {
#endif

void wsp_ggml_compute_forward_abs(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_sgn(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_neg(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_step(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_tanh(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_elu(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_relu(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_sigmoid(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_hardsigmoid(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_exp(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_hardswish(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_sqr(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_sqrt(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_sin(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_cos(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_log(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_expm1(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_softplus(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_floor(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_ceil(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_round(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_trunc(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_xielu(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);

#ifdef __cplusplus
}
#endif
