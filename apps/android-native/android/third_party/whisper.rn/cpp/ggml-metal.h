// Note: this description is outdated
//
// An interface allowing to compute wsp_ggml_cgraph with Metal
//
// This is a fully functional interface that extends ggml with GPU support for Apple devices.
// A similar interface can be created for other GPU backends (e.g. Vulkan, CUDA, etc.)
//
// How it works?
//
// As long as your program can create and evaluate a wsp_ggml_cgraph on the CPU, you can use this
// interface to evaluate the same graph on the GPU. Instead of using wsp_ggml_graph_compute(), you
// use wsp_ggml_metal_graph_compute() (or wsp_ggml_vulkan_graph_compute(), etc.)
//
// You only need to make sure that all memory buffers that you used during the graph creation
// are mapped to the device memory with the wsp_ggml_metal_add_buffer() function. This mapping is
// used during the graph evaluation to determine the arguments of the compute kernels.
//
// Synchronization between device and host memory (for example for input and output tensors)
// is done with the wsp_ggml_metal_set_tensor() and wsp_ggml_metal_get_tensor() functions.
//

#pragma once

#include "ggml.h"
#include "ggml-backend.h"

#include <stddef.h>
#include <stdbool.h>

struct wsp_ggml_tensor;
struct wsp_ggml_cgraph;

#ifdef __cplusplus
extern "C" {
#endif

//
// backend API
// user-code should use only these functions
//

// TODO: remove in the future
WSP_GGML_BACKEND_API wsp_ggml_backend_t wsp_ggml_backend_metal_init(void);

WSP_GGML_BACKEND_API bool wsp_ggml_backend_is_metal(wsp_ggml_backend_t backend);

WSP_GGML_BACKEND_API void wsp_ggml_backend_metal_set_abort_callback(wsp_ggml_backend_t backend, wsp_ggml_abort_callback abort_callback, void * user_data);

// helper to check if the device supports a specific family
// ideally, the user code should be doing these checks
// ref: https://developer.apple.com/metal/Metal-Feature-Set-Tables.pdf
WSP_GGML_BACKEND_API bool wsp_ggml_backend_metal_supports_family(wsp_ggml_backend_t backend, int family);

// capture all command buffers committed the next time `wsp_ggml_backend_graph_compute` is called
WSP_GGML_BACKEND_API void wsp_ggml_backend_metal_capture_next_compute(wsp_ggml_backend_t backend);

WSP_GGML_BACKEND_API wsp_ggml_backend_reg_t wsp_ggml_backend_metal_reg(void);

#ifdef __cplusplus
}
#endif
