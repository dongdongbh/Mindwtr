#pragma once

#include "ggml.h"
#include "ggml-alloc.h"

#ifdef WSP_GGML_BACKEND_SHARED
#    if defined(_WIN32) && !defined(__MINGW32__)
#        ifdef WSP_GGML_BACKEND_BUILD
#            define WSP_GGML_BACKEND_API __declspec(dllexport) extern
#        else
#            define WSP_GGML_BACKEND_API __declspec(dllimport) extern
#        endif
#    else
#        define WSP_GGML_BACKEND_API __attribute__ ((visibility ("default"))) extern
#    endif
#else
#    define WSP_GGML_BACKEND_API extern
#endif

#ifdef  __cplusplus
extern "C" {
#endif

    typedef struct wsp_ggml_backend_buffer_type * wsp_ggml_backend_buffer_type_t;
    typedef struct wsp_ggml_backend_buffer * wsp_ggml_backend_buffer_t;
    typedef struct wsp_ggml_backend_event * wsp_ggml_backend_event_t;
    typedef struct wsp_ggml_backend * wsp_ggml_backend_t;
    typedef void * wsp_ggml_backend_graph_plan_t;
    typedef struct wsp_ggml_backend_reg * wsp_ggml_backend_reg_t;
    typedef struct wsp_ggml_backend_device * wsp_ggml_backend_dev_t;


    //
    // Backend buffer type
    //

    WSP_GGML_API const char *          wsp_ggml_backend_buft_name          (wsp_ggml_backend_buffer_type_t buft);
    WSP_GGML_API wsp_ggml_backend_buffer_t wsp_ggml_backend_buft_alloc_buffer  (wsp_ggml_backend_buffer_type_t buft, size_t size);
    WSP_GGML_API size_t                wsp_ggml_backend_buft_get_alignment (wsp_ggml_backend_buffer_type_t buft);
    WSP_GGML_API size_t                wsp_ggml_backend_buft_get_max_size  (wsp_ggml_backend_buffer_type_t buft);
    WSP_GGML_API size_t                wsp_ggml_backend_buft_get_alloc_size(wsp_ggml_backend_buffer_type_t buft, const struct wsp_ggml_tensor * tensor);
    WSP_GGML_API bool                  wsp_ggml_backend_buft_is_host       (wsp_ggml_backend_buffer_type_t buft);
    WSP_GGML_API wsp_ggml_backend_dev_t    wsp_ggml_backend_buft_get_device    (wsp_ggml_backend_buffer_type_t buft);

    //
    // Backend buffer
    //

    enum wsp_ggml_backend_buffer_usage {
        WSP_GGML_BACKEND_BUFFER_USAGE_ANY = 0,
        WSP_GGML_BACKEND_BUFFER_USAGE_WEIGHTS = 1,
        WSP_GGML_BACKEND_BUFFER_USAGE_COMPUTE = 2,
    };

    WSP_GGML_API const char *                   wsp_ggml_backend_buffer_name          (wsp_ggml_backend_buffer_t buffer);
    WSP_GGML_API void                           wsp_ggml_backend_buffer_free          (wsp_ggml_backend_buffer_t buffer);
    WSP_GGML_API void *                         wsp_ggml_backend_buffer_get_base      (wsp_ggml_backend_buffer_t buffer);
    WSP_GGML_API size_t                         wsp_ggml_backend_buffer_get_size      (wsp_ggml_backend_buffer_t buffer);
    WSP_GGML_API enum wsp_ggml_status               wsp_ggml_backend_buffer_init_tensor   (wsp_ggml_backend_buffer_t buffer, struct wsp_ggml_tensor * tensor);
    WSP_GGML_API size_t                         wsp_ggml_backend_buffer_get_alignment (wsp_ggml_backend_buffer_t buffer);
    WSP_GGML_API size_t                         wsp_ggml_backend_buffer_get_max_size  (wsp_ggml_backend_buffer_t buffer);
    WSP_GGML_API size_t                         wsp_ggml_backend_buffer_get_alloc_size(wsp_ggml_backend_buffer_t buffer, const struct wsp_ggml_tensor * tensor);
    WSP_GGML_API void                           wsp_ggml_backend_buffer_clear         (wsp_ggml_backend_buffer_t buffer, uint8_t value);
    WSP_GGML_API bool                           wsp_ggml_backend_buffer_is_host       (wsp_ggml_backend_buffer_t buffer);
    WSP_GGML_API void                           wsp_ggml_backend_buffer_set_usage     (wsp_ggml_backend_buffer_t buffer, enum wsp_ggml_backend_buffer_usage usage);
    WSP_GGML_API enum wsp_ggml_backend_buffer_usage wsp_ggml_backend_buffer_get_usage     (wsp_ggml_backend_buffer_t buffer);
    WSP_GGML_API wsp_ggml_backend_buffer_type_t     wsp_ggml_backend_buffer_get_type      (wsp_ggml_backend_buffer_t buffer);
    WSP_GGML_API void                           wsp_ggml_backend_buffer_reset         (wsp_ggml_backend_buffer_t buffer);

    // tensor copy between different backends
    WSP_GGML_API void wsp_ggml_backend_tensor_copy(struct wsp_ggml_tensor * src, struct wsp_ggml_tensor * dst);

    //
    // Backend (stream)
    //

    WSP_GGML_API wsp_ggml_guid_t  wsp_ggml_backend_guid(wsp_ggml_backend_t backend);
    WSP_GGML_API const char * wsp_ggml_backend_name(wsp_ggml_backend_t backend);
    WSP_GGML_API void         wsp_ggml_backend_free(wsp_ggml_backend_t backend);

    WSP_GGML_API wsp_ggml_backend_buffer_type_t wsp_ggml_backend_get_default_buffer_type(wsp_ggml_backend_t backend);
    WSP_GGML_API wsp_ggml_backend_buffer_t      wsp_ggml_backend_alloc_buffer(wsp_ggml_backend_t backend, size_t size);
    WSP_GGML_API size_t                     wsp_ggml_backend_get_alignment(wsp_ggml_backend_t backend);
    WSP_GGML_API size_t                     wsp_ggml_backend_get_max_size(wsp_ggml_backend_t backend);

    WSP_GGML_API void wsp_ggml_backend_tensor_set_async(wsp_ggml_backend_t backend,       struct wsp_ggml_tensor * tensor, const void * data, size_t offset, size_t size);
    WSP_GGML_API void wsp_ggml_backend_tensor_get_async(wsp_ggml_backend_t backend, const struct wsp_ggml_tensor * tensor,       void * data, size_t offset, size_t size);

    // "offset" refers to the offset in tensor->data for setting/getting data
    WSP_GGML_API void wsp_ggml_backend_tensor_set(      struct wsp_ggml_tensor * tensor, const void * data, size_t offset, size_t size);
    WSP_GGML_API void wsp_ggml_backend_tensor_get(const struct wsp_ggml_tensor * tensor,       void * data, size_t offset, size_t size);
    WSP_GGML_API void wsp_ggml_backend_tensor_memset(   struct wsp_ggml_tensor * tensor,     uint8_t value, size_t offset, size_t size);

    WSP_GGML_API void wsp_ggml_backend_synchronize(wsp_ggml_backend_t backend);

    WSP_GGML_API wsp_ggml_backend_graph_plan_t wsp_ggml_backend_graph_plan_create(wsp_ggml_backend_t backend, struct wsp_ggml_cgraph * cgraph);
    WSP_GGML_API void                      wsp_ggml_backend_graph_plan_free  (wsp_ggml_backend_t backend, wsp_ggml_backend_graph_plan_t plan);

    WSP_GGML_API enum wsp_ggml_status wsp_ggml_backend_graph_plan_compute (wsp_ggml_backend_t backend, wsp_ggml_backend_graph_plan_t plan);
    WSP_GGML_API enum wsp_ggml_status wsp_ggml_backend_graph_compute      (wsp_ggml_backend_t backend, struct wsp_ggml_cgraph * cgraph);
    WSP_GGML_API enum wsp_ggml_status wsp_ggml_backend_graph_compute_async(wsp_ggml_backend_t backend, struct wsp_ggml_cgraph * cgraph);

    // NOTE: will be removed, use device version instead
    WSP_GGML_API bool wsp_ggml_backend_supports_op(wsp_ggml_backend_t backend, const struct wsp_ggml_tensor * op);
    WSP_GGML_API bool wsp_ggml_backend_supports_buft(wsp_ggml_backend_t backend, wsp_ggml_backend_buffer_type_t buft);
    WSP_GGML_API bool wsp_ggml_backend_offload_op(wsp_ggml_backend_t backend, const struct wsp_ggml_tensor * op);

    // asynchronous copy
    // the copy is performed after all the currently queued operations in backend_src
    // backend_dst will wait for the copy to complete before performing other operations
    // automatic fallback to sync copy if async is not supported
    WSP_GGML_API void wsp_ggml_backend_tensor_copy_async(wsp_ggml_backend_t backend_src, wsp_ggml_backend_t backend_dst, struct wsp_ggml_tensor * src, struct wsp_ggml_tensor * dst);

    WSP_GGML_API wsp_ggml_backend_dev_t wsp_ggml_backend_get_device(wsp_ggml_backend_t backend);

    //
    // Events
    //

    WSP_GGML_API wsp_ggml_backend_event_t wsp_ggml_backend_event_new(wsp_ggml_backend_dev_t device);
    WSP_GGML_API void                 wsp_ggml_backend_event_free(wsp_ggml_backend_event_t event);
    WSP_GGML_API void                 wsp_ggml_backend_event_record(wsp_ggml_backend_event_t event, wsp_ggml_backend_t backend);
    WSP_GGML_API void                 wsp_ggml_backend_event_synchronize(wsp_ggml_backend_event_t event);
    WSP_GGML_API void                 wsp_ggml_backend_event_wait(wsp_ggml_backend_t backend, wsp_ggml_backend_event_t event);

    //
    // Backend device
    //

    enum wsp_ggml_backend_dev_type {
        // CPU device using system memory
        WSP_GGML_BACKEND_DEVICE_TYPE_CPU,
        // GPU device using dedicated memory
        WSP_GGML_BACKEND_DEVICE_TYPE_GPU,
        // integrated GPU device using host memory
        WSP_GGML_BACKEND_DEVICE_TYPE_IGPU,
        // accelerator devices intended to be used together with the CPU backend (e.g. BLAS or AMX)
        WSP_GGML_BACKEND_DEVICE_TYPE_ACCEL
    };

    // functionality supported by the device
    struct wsp_ggml_backend_dev_caps {
        // asynchronous operations
        bool async;
        // pinned host buffer
        bool host_buffer;
        // creating buffers from host ptr
        bool buffer_from_host_ptr;
        // event synchronization
        bool events;
    };

    // all the device properties
    struct wsp_ggml_backend_dev_props {
        // device name
        const char * name;
        // device description
        const char * description;
        // device free memory in bytes
        size_t memory_free;
        // device total memory in bytes
        size_t memory_total;
        // device type
        enum wsp_ggml_backend_dev_type type;
        // device id
        //   for PCI devices, this should be the PCI bus id formatted as "domain:bus:device.function" (e.g. "0000:01:00.0")
        //   if the id is unknown, this should be NULL
        const char * device_id;
        // device capabilities
        struct wsp_ggml_backend_dev_caps caps;
    };

    WSP_GGML_API const char *                  wsp_ggml_backend_dev_name(wsp_ggml_backend_dev_t device);
    WSP_GGML_API const char *                  wsp_ggml_backend_dev_description(wsp_ggml_backend_dev_t device);
    WSP_GGML_API void                          wsp_ggml_backend_dev_memory(wsp_ggml_backend_dev_t device, size_t * free, size_t * total);
    WSP_GGML_API enum wsp_ggml_backend_dev_type    wsp_ggml_backend_dev_type(wsp_ggml_backend_dev_t device);
    WSP_GGML_API void                          wsp_ggml_backend_dev_get_props(wsp_ggml_backend_dev_t device, struct wsp_ggml_backend_dev_props * props);
    WSP_GGML_API wsp_ggml_backend_reg_t            wsp_ggml_backend_dev_backend_reg(wsp_ggml_backend_dev_t device);
    WSP_GGML_API wsp_ggml_backend_t                wsp_ggml_backend_dev_init(wsp_ggml_backend_dev_t device, const char * params);
    WSP_GGML_API wsp_ggml_backend_buffer_type_t    wsp_ggml_backend_dev_buffer_type(wsp_ggml_backend_dev_t device);
    WSP_GGML_API wsp_ggml_backend_buffer_type_t    wsp_ggml_backend_dev_host_buffer_type(wsp_ggml_backend_dev_t device);
    WSP_GGML_API wsp_ggml_backend_buffer_t         wsp_ggml_backend_dev_buffer_from_host_ptr(wsp_ggml_backend_dev_t device, void * ptr, size_t size, size_t max_tensor_size);

    WSP_GGML_API bool                          wsp_ggml_backend_dev_supports_op(wsp_ggml_backend_dev_t device, const struct wsp_ggml_tensor * op);
    WSP_GGML_API bool                          wsp_ggml_backend_dev_supports_buft(wsp_ggml_backend_dev_t device, wsp_ggml_backend_buffer_type_t buft);
    WSP_GGML_API bool                          wsp_ggml_backend_dev_offload_op(wsp_ggml_backend_dev_t device, const struct wsp_ggml_tensor * op);

    //
    // Backend (reg)
    //

    WSP_GGML_API const char *       wsp_ggml_backend_reg_name(wsp_ggml_backend_reg_t reg);
    WSP_GGML_API size_t             wsp_ggml_backend_reg_dev_count(wsp_ggml_backend_reg_t reg);
    WSP_GGML_API wsp_ggml_backend_dev_t wsp_ggml_backend_reg_dev_get(wsp_ggml_backend_reg_t reg, size_t index);
    WSP_GGML_API void *             wsp_ggml_backend_reg_get_proc_address(wsp_ggml_backend_reg_t reg, const char * name);

    // Common functions that may be obtained using wsp_ggml_backend_reg_get_proc_address

    // Split buffer type for tensor parallelism
    typedef wsp_ggml_backend_buffer_type_t   (*wsp_ggml_backend_split_buffer_type_t)(int main_device, const float * tensor_split);
    // Set the number of threads for the backend
    typedef void                         (*wsp_ggml_backend_set_n_threads_t)(wsp_ggml_backend_t backend, int n_threads);
    // Get additional buffer types provided by the device (returns a NULL-terminated array)
    typedef wsp_ggml_backend_buffer_type_t * (*wsp_ggml_backend_dev_get_extra_bufts_t)(wsp_ggml_backend_dev_t device);
    // Set the abort callback for the backend
    typedef void                         (*wsp_ggml_backend_set_abort_callback_t)(wsp_ggml_backend_t backend, wsp_ggml_abort_callback abort_callback, void * abort_callback_data);
    // Get a list of feature flags supported by the backend (returns a NULL-terminated array)
    struct wsp_ggml_backend_feature {
        const char * name;
        const char * value;
    };
    typedef struct wsp_ggml_backend_feature * (*wsp_ggml_backend_get_features_t)(wsp_ggml_backend_reg_t reg);

    //
    // Backend registry
    //

    WSP_GGML_API void wsp_ggml_backend_register(wsp_ggml_backend_reg_t reg);

    WSP_GGML_API void wsp_ggml_backend_device_register(wsp_ggml_backend_dev_t device);

    // Backend (reg) enumeration
    WSP_GGML_API size_t             wsp_ggml_backend_reg_count(void);
    WSP_GGML_API wsp_ggml_backend_reg_t wsp_ggml_backend_reg_get(size_t index);
    WSP_GGML_API wsp_ggml_backend_reg_t wsp_ggml_backend_reg_by_name(const char * name);

    // Device enumeration
    WSP_GGML_API size_t             wsp_ggml_backend_dev_count(void);
    WSP_GGML_API wsp_ggml_backend_dev_t wsp_ggml_backend_dev_get(size_t index);
    WSP_GGML_API wsp_ggml_backend_dev_t wsp_ggml_backend_dev_by_name(const char * name);
    WSP_GGML_API wsp_ggml_backend_dev_t wsp_ggml_backend_dev_by_type(enum wsp_ggml_backend_dev_type type);

    // Direct backend (stream) initialization
    // = wsp_ggml_backend_dev_init(wsp_ggml_backend_dev_by_name(name), params)
    WSP_GGML_API wsp_ggml_backend_t wsp_ggml_backend_init_by_name(const char * name, const char * params);
    // = wsp_ggml_backend_dev_init(wsp_ggml_backend_dev_by_type(type), params)
    WSP_GGML_API wsp_ggml_backend_t wsp_ggml_backend_init_by_type(enum wsp_ggml_backend_dev_type type, const char * params);
    // = wsp_ggml_backend_dev_init(wsp_ggml_backend_dev_by_type(GPU) OR wsp_ggml_backend_dev_by_type(CPU), NULL)
    WSP_GGML_API wsp_ggml_backend_t wsp_ggml_backend_init_best(void);

    // Load a backend from a dynamic library and register it
    WSP_GGML_API wsp_ggml_backend_reg_t wsp_ggml_backend_load(const char * path);
    // Unload a backend if loaded dynamically and unregister it
    WSP_GGML_API void               wsp_ggml_backend_unload(wsp_ggml_backend_reg_t reg);
    // Load all known backends from dynamic libraries
    WSP_GGML_API void               wsp_ggml_backend_load_all(void);
    WSP_GGML_API void               wsp_ggml_backend_load_all_from_path(const char * dir_path);

    //
    // Backend scheduler
    //

    // The backend scheduler allows for multiple backend devices to be used together
    // Handles compute buffer allocation, assignment of tensors to backends, and copying of tensors between backends
    // The backends are selected based on:
    // - the backend that supports the operation
    // - the location of the pre-allocated tensors (e.g. the weights)
    /*
      Example usage:

        // operations that use tensors allocated in a buffer with USAGE_WEIGHTS will be assigned
        // preferrably to run on the same backend as the buffer
        wsp_ggml_backend_buffer_set_usage(buf_weights, WSP_GGML_BACKEND_BUFFER_USAGE_WEIGHTS);

        sched = wsp_ggml_backend_sched_new({backend_gpu, backend_gpu2, backend_cpu}, NULL, num_backends, WSP_GGML_DEFAULT_GRAPH_SIZE, false, true);

        // initialize buffers from a max size graph (optional)
        reserve_graph = build_graph(sched, max_batch_size);

        // manually assign nodes to a backend (optional, should not be needed in most cases)
        struct wsp_ggml_tensor * node = wsp_ggml_mul_mat(ctx, ...);
        wsp_ggml_backend_sched_set_tensor_backend(sched, node, backend_gpu);

        wsp_ggml_backend_sched_reserve(sched, reserve_graph);

        // compute
        graph = build_graph(sched); // the graph and its tensors are single-use in terms of allocation, multi-use in terms of computation
        for (int i = 0; i < 10; ++i) {
            wsp_ggml_backend_sched_graph_compute(sched, graph); // on the first iteration the graph is allocated automatically
        }

        // if there are graph inputs:
        graph = build_graph(sched); // get a new graph that is not allocated (the metadata for the old graph is freed once wsp_ggml_free is called)
        wsp_ggml_backend_sched_reset(sched); // clear the allocation of the previous graph
        wsp_ggml_backend_sched_alloc_graph(sched, graph); // explicitly allocate the new graph but do not execute it
        wsp_ggml_backend_tensor_set(input_tensor, ...); // copy data to the newly allocated graph tensors
        wsp_ggml_backend_sched_graph_compute(sched, graph); // execute the graph

        // as an alternative to the above it is also possible to assign the inputs to a dedicated context and
        // allocate them statically via wsp_ggml_backend_alloc_ctx_tensors
    }
    */

    typedef struct wsp_ggml_backend_sched * wsp_ggml_backend_sched_t;

    // Evaluation callback for each node in the graph (set with wsp_ggml_backend_sched_set_eval_callback)
    // when ask == true, the scheduler wants to know if the user wants to observe this node
    // this allows the scheduler to batch nodes together in order to evaluate them in a single call
    //
    // when ask == false, the scheduler is passing the node tensor to the user for observation
    // if the user returns false, the scheduler will cancel the graph compute
    //
    typedef bool (*wsp_ggml_backend_sched_eval_callback)(struct wsp_ggml_tensor * t, bool ask, void * user_data);

    // Initialize a backend scheduler, backends with low index are given priority over backends with high index
    WSP_GGML_API wsp_ggml_backend_sched_t wsp_ggml_backend_sched_new(wsp_ggml_backend_t * backends, wsp_ggml_backend_buffer_type_t * bufts, int n_backends, size_t graph_size, bool parallel, bool op_offload);
    WSP_GGML_API void                 wsp_ggml_backend_sched_free(wsp_ggml_backend_sched_t sched);

    // Initialize backend buffers from a measure graph
    WSP_GGML_API bool                 wsp_ggml_backend_sched_reserve(wsp_ggml_backend_sched_t sched, struct wsp_ggml_cgraph * measure_graph); // returns success

    WSP_GGML_API int                  wsp_ggml_backend_sched_get_n_backends(wsp_ggml_backend_sched_t sched);
    WSP_GGML_API wsp_ggml_backend_t       wsp_ggml_backend_sched_get_backend(wsp_ggml_backend_sched_t sched, int i);

    // Get the number of splits of the last graph
    WSP_GGML_API int                  wsp_ggml_backend_sched_get_n_splits(wsp_ggml_backend_sched_t sched);
    WSP_GGML_API int                  wsp_ggml_backend_sched_get_n_copies(wsp_ggml_backend_sched_t sched);

    WSP_GGML_API wsp_ggml_backend_buffer_type_t wsp_ggml_backend_sched_get_buffer_type(wsp_ggml_backend_sched_t sched, wsp_ggml_backend_t backend);
    WSP_GGML_API size_t                     wsp_ggml_backend_sched_get_buffer_size(wsp_ggml_backend_sched_t sched, wsp_ggml_backend_t backend);

    WSP_GGML_API void                 wsp_ggml_backend_sched_set_tensor_backend(wsp_ggml_backend_sched_t sched, struct wsp_ggml_tensor * node, wsp_ggml_backend_t backend);
    WSP_GGML_API wsp_ggml_backend_t       wsp_ggml_backend_sched_get_tensor_backend(wsp_ggml_backend_sched_t sched, struct wsp_ggml_tensor * node);

    // Split graph without allocating it
    WSP_GGML_API void                 wsp_ggml_backend_sched_split_graph(wsp_ggml_backend_sched_t sched, struct wsp_ggml_cgraph * graph);

    // Allocate and compute graph on the backend scheduler
    WSP_GGML_API bool                 wsp_ggml_backend_sched_alloc_graph(wsp_ggml_backend_sched_t sched, struct wsp_ggml_cgraph * graph); // returns success
    WSP_GGML_API enum wsp_ggml_status     wsp_ggml_backend_sched_graph_compute(wsp_ggml_backend_sched_t sched, struct wsp_ggml_cgraph * graph);
    WSP_GGML_API enum wsp_ggml_status     wsp_ggml_backend_sched_graph_compute_async(wsp_ggml_backend_sched_t sched, struct wsp_ggml_cgraph * graph);
    WSP_GGML_API void                 wsp_ggml_backend_sched_synchronize(wsp_ggml_backend_sched_t sched);

    // Reset all assignments and allocators - must be called before changing the node backends or allocating a new graph.
    // This in effect deallocates all tensors that were previously allocated and leaves them with dangling pointers.
    // The correct way to use this API is to discard the deallocated tensors and create new ones.
    WSP_GGML_API void                 wsp_ggml_backend_sched_reset(wsp_ggml_backend_sched_t sched);

    // Set a callback to be called for each resulting node during graph compute
    WSP_GGML_API void                 wsp_ggml_backend_sched_set_eval_callback(wsp_ggml_backend_sched_t sched, wsp_ggml_backend_sched_eval_callback callback, void * user_data);

    //
    // Utils
    //

    struct wsp_ggml_backend_graph_copy {
        wsp_ggml_backend_buffer_t buffer;
        struct wsp_ggml_context * ctx_allocated;
        struct wsp_ggml_context * ctx_unallocated;
        struct wsp_ggml_cgraph * graph;
    };

    // Copy a graph to a different backend
    WSP_GGML_API struct wsp_ggml_backend_graph_copy wsp_ggml_backend_graph_copy(wsp_ggml_backend_t backend, struct wsp_ggml_cgraph * graph);
    WSP_GGML_API void                           wsp_ggml_backend_graph_copy_free(struct wsp_ggml_backend_graph_copy copy);

    typedef bool (*wsp_ggml_backend_eval_callback)(int node_index, struct wsp_ggml_tensor * t1, struct wsp_ggml_tensor * t2, void * user_data);

    // Compare the output of two backends
    WSP_GGML_API bool wsp_ggml_backend_compare_graph_backend(wsp_ggml_backend_t backend1, wsp_ggml_backend_t backend2, struct wsp_ggml_cgraph * graph, wsp_ggml_backend_eval_callback callback, void * user_data, struct wsp_ggml_tensor * test_node);

    // Tensor initialization
    WSP_GGML_API enum wsp_ggml_status wsp_ggml_backend_tensor_alloc(wsp_ggml_backend_buffer_t buffer, struct wsp_ggml_tensor * tensor, void * addr);
    WSP_GGML_API enum wsp_ggml_status wsp_ggml_backend_view_init(struct wsp_ggml_tensor * tensor);

    // CPU buffer types are always available
    WSP_GGML_API wsp_ggml_backend_buffer_t      wsp_ggml_backend_cpu_buffer_from_ptr(void * ptr, size_t size);
    WSP_GGML_API wsp_ggml_backend_buffer_type_t wsp_ggml_backend_cpu_buffer_type(void);

#ifdef  __cplusplus
}
#endif
