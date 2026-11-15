#pragma once

#include "ggml.h"

#ifdef  __cplusplus
extern "C" {
#endif

typedef struct wsp_ggml_backend_buffer_type * wsp_ggml_backend_buffer_type_t;
typedef struct      wsp_ggml_backend_buffer * wsp_ggml_backend_buffer_t;
typedef struct             wsp_ggml_backend * wsp_ggml_backend_t;

// Tensor allocator
struct wsp_ggml_tallocr {
    wsp_ggml_backend_buffer_t buffer;
    void * base;
    size_t alignment;
    size_t offset;
};

WSP_GGML_API struct wsp_ggml_tallocr wsp_ggml_tallocr_new(wsp_ggml_backend_buffer_t buffer);
WSP_GGML_API enum wsp_ggml_status    wsp_ggml_tallocr_alloc(struct wsp_ggml_tallocr * talloc, struct wsp_ggml_tensor * tensor);

// Graph allocator
/*
  Example usage:
    wsp_ggml_gallocr_t galloc = wsp_ggml_gallocr_new(wsp_ggml_backend_cpu_buffer_type());

    // optional: create a worst-case graph and reserve the buffers to avoid reallocations
    wsp_ggml_gallocr_reserve(galloc, build_graph(max_batch));

    // allocate the graph
    struct wsp_ggml_cgraph * graph = build_graph(batch);
    wsp_ggml_gallocr_alloc_graph(galloc, graph);

    printf("compute buffer size: %zu bytes\n", wsp_ggml_gallocr_get_buffer_size(galloc, 0));

    // evaluate the graph
    wsp_ggml_backend_graph_compute(backend, graph);
*/

// special tensor flags for use with the graph allocator:
//   wsp_ggml_set_input(): all input tensors are allocated at the beginning of the graph in non-overlapping addresses
//   wsp_ggml_set_output(): output tensors are never freed and never overwritten

typedef struct wsp_ggml_gallocr * wsp_ggml_gallocr_t;

WSP_GGML_API wsp_ggml_gallocr_t wsp_ggml_gallocr_new(wsp_ggml_backend_buffer_type_t buft);
WSP_GGML_API wsp_ggml_gallocr_t wsp_ggml_gallocr_new_n(wsp_ggml_backend_buffer_type_t * bufts, int n_bufs);
WSP_GGML_API void           wsp_ggml_gallocr_free(wsp_ggml_gallocr_t galloc);

// pre-allocate buffers from a measure graph - does not allocate or modify the graph
// call with a worst-case graph to avoid buffer reallocations
// not strictly required for single buffer usage: wsp_ggml_gallocr_alloc_graph will reallocate the buffers automatically if needed
// returns false if the buffer allocation failed
WSP_GGML_API bool wsp_ggml_gallocr_reserve(wsp_ggml_gallocr_t galloc, struct wsp_ggml_cgraph * graph);
WSP_GGML_API bool wsp_ggml_gallocr_reserve_n(
    wsp_ggml_gallocr_t galloc,
    struct wsp_ggml_cgraph * graph,
    const int * node_buffer_ids,
    const int * leaf_buffer_ids);

// automatic reallocation if the topology changes when using a single buffer
// returns false if using multiple buffers and a re-allocation is needed (call wsp_ggml_gallocr_reserve_n first to set the node buffers)
WSP_GGML_API bool wsp_ggml_gallocr_alloc_graph(wsp_ggml_gallocr_t galloc, struct wsp_ggml_cgraph * graph);

WSP_GGML_API size_t wsp_ggml_gallocr_get_buffer_size(wsp_ggml_gallocr_t galloc, int buffer_id);

// Utils
// Create a buffer and allocate all the tensors in a wsp_ggml_context
WSP_GGML_API struct wsp_ggml_backend_buffer * wsp_ggml_backend_alloc_ctx_tensors_from_buft(struct wsp_ggml_context * ctx, wsp_ggml_backend_buffer_type_t buft);
WSP_GGML_API struct wsp_ggml_backend_buffer * wsp_ggml_backend_alloc_ctx_tensors(struct wsp_ggml_context * ctx, wsp_ggml_backend_t backend);

#ifdef  __cplusplus
}
#endif
