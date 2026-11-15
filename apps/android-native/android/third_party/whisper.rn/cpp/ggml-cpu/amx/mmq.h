#pragma once
#include "common.h"

size_t wsp_ggml_backend_amx_desired_wsize(const struct wsp_ggml_tensor * dst);

size_t wsp_ggml_backend_amx_get_alloc_size(const struct wsp_ggml_tensor * tensor);

void wsp_ggml_backend_amx_convert_weight(struct wsp_ggml_tensor * tensor, const void * data, size_t offset, size_t size);

void wsp_ggml_backend_amx_mul_mat(const struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * dst);
