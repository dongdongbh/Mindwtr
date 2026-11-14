#pragma once

#include "common.h"

#ifdef __cplusplus
extern "C" {
#endif

void wsp_ggml_compute_forward_add_non_quantized(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_sub(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_mul(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
void wsp_ggml_compute_forward_div(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);

#ifdef __cplusplus
}
#endif
