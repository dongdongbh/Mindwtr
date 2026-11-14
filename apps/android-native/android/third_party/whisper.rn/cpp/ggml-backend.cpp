// Note: porting this file to C++ is a work in progress

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#ifndef NOMINMAX
#   define NOMINMAX
#endif
#include <windows.h>
#endif

#include "ggml-backend.h"
#include "ggml-backend-impl.h"
#include "ggml-alloc.h"
#include "ggml-impl.h"

#include <assert.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <algorithm>
#include <vector>

#ifdef __APPLE__
#include <sys/types.h>
#include <sys/sysctl.h>
#endif


// backend buffer type

const char * wsp_ggml_backend_buft_name(wsp_ggml_backend_buffer_type_t buft) {
    WSP_GGML_ASSERT(buft);
    return buft->iface.get_name(buft);
}

wsp_ggml_backend_buffer_t wsp_ggml_backend_buft_alloc_buffer(wsp_ggml_backend_buffer_type_t buft, size_t size) {
    if (size == 0) {
        // return a dummy buffer for zero-sized allocations
        return wsp_ggml_backend_buffer_init(buft, {}, NULL, 0);
    }

    WSP_GGML_ASSERT(buft);
    return buft->iface.alloc_buffer(buft, size);
}

size_t wsp_ggml_backend_buft_get_alignment(wsp_ggml_backend_buffer_type_t buft) {
    WSP_GGML_ASSERT(buft);
    return buft->iface.get_alignment(buft);
}

size_t wsp_ggml_backend_buft_get_max_size(wsp_ggml_backend_buffer_type_t buft) {
    WSP_GGML_ASSERT(buft);
    // get_max_size is optional, defaults to SIZE_MAX
    if (buft->iface.get_max_size) {
        return buft->iface.get_max_size(buft);
    }
    return SIZE_MAX;
}

size_t wsp_ggml_backend_buft_get_alloc_size(wsp_ggml_backend_buffer_type_t buft, const struct wsp_ggml_tensor * tensor) {
    WSP_GGML_ASSERT(buft);
    // get_alloc_size is optional, defaults to wsp_ggml_nbytes
    if (buft->iface.get_alloc_size) {
        size_t size = buft->iface.get_alloc_size(buft, tensor);
        assert(size >= wsp_ggml_nbytes(tensor));
        return size;
    }
    return wsp_ggml_nbytes(tensor);
}

bool wsp_ggml_backend_buft_is_host(wsp_ggml_backend_buffer_type_t buft) {
    WSP_GGML_ASSERT(buft);
    if (buft->iface.is_host) {
        return buft->iface.is_host(buft);
    }
    return false;
}

wsp_ggml_backend_dev_t wsp_ggml_backend_buft_get_device(wsp_ggml_backend_buffer_type_t buft) {
    WSP_GGML_ASSERT(buft);
    return buft->device;
}

// backend buffer

wsp_ggml_backend_buffer_t wsp_ggml_backend_buffer_init(
               wsp_ggml_backend_buffer_type_t buft,
        struct wsp_ggml_backend_buffer_i      iface,
               void *                     context,
               size_t                     size) {
    wsp_ggml_backend_buffer_t buffer = new wsp_ggml_backend_buffer {
        /* .interface = */ iface,
        /* .buft      = */ buft,
        /* .context   = */ context,
        /* .size      = */ size,
        /* .usage     = */ WSP_GGML_BACKEND_BUFFER_USAGE_ANY
    };

    return buffer;
}

const char * wsp_ggml_backend_buffer_name(wsp_ggml_backend_buffer_t buffer) {
    return wsp_ggml_backend_buft_name(wsp_ggml_backend_buffer_get_type(buffer));
}

void wsp_ggml_backend_buffer_free(wsp_ggml_backend_buffer_t buffer) {
    if (buffer == NULL) {
        return;
    }

    if (buffer->iface.free_buffer != NULL) {
        buffer->iface.free_buffer(buffer);
    }
    delete buffer;
}

size_t wsp_ggml_backend_buffer_get_size(wsp_ggml_backend_buffer_t buffer) {
    WSP_GGML_ASSERT(buffer);
    return buffer->size;
}

void * wsp_ggml_backend_buffer_get_base(wsp_ggml_backend_buffer_t buffer) {
    WSP_GGML_ASSERT(buffer);
    // get_base is optional if the buffer is zero-sized
    if (buffer->size == 0) {
        return NULL;
    }

    void * base = buffer->iface.get_base(buffer);

    WSP_GGML_ASSERT(base != NULL && "backend buffer base cannot be NULL");

    return base;
}

enum wsp_ggml_status wsp_ggml_backend_buffer_init_tensor(wsp_ggml_backend_buffer_t buffer, struct wsp_ggml_tensor * tensor) {
    WSP_GGML_ASSERT(buffer);
    // init_tensor is optional
    if (buffer->iface.init_tensor) {
        return buffer->iface.init_tensor(buffer, tensor);
    }
    return WSP_GGML_STATUS_SUCCESS;
}

void wsp_ggml_backend_buffer_clear(wsp_ggml_backend_buffer_t buffer, uint8_t value) {
    WSP_GGML_ASSERT(buffer);
    // clear is optional if the buffer is zero-sized
    if (buffer->size == 0) {
        return;
    }

    buffer->iface.clear(buffer, value);
}

size_t wsp_ggml_backend_buffer_get_alignment(wsp_ggml_backend_buffer_t buffer) {
    return wsp_ggml_backend_buft_get_alignment(wsp_ggml_backend_buffer_get_type(buffer));
}

size_t wsp_ggml_backend_buffer_get_max_size(wsp_ggml_backend_buffer_t buffer) {
    return wsp_ggml_backend_buft_get_max_size(wsp_ggml_backend_buffer_get_type(buffer));
}

size_t wsp_ggml_backend_buffer_get_alloc_size(wsp_ggml_backend_buffer_t buffer, const struct wsp_ggml_tensor * tensor) {
    return wsp_ggml_backend_buft_get_alloc_size(wsp_ggml_backend_buffer_get_type(buffer), tensor);
}

bool wsp_ggml_backend_buffer_is_host(wsp_ggml_backend_buffer_t buffer) {
    return wsp_ggml_backend_buft_is_host(wsp_ggml_backend_buffer_get_type(buffer));
}

void wsp_ggml_backend_buffer_set_usage(wsp_ggml_backend_buffer_t buffer, enum wsp_ggml_backend_buffer_usage usage) {
    WSP_GGML_ASSERT(buffer);
    buffer->usage = usage;

    // FIXME: add a generic callback to the buffer interface
    if (wsp_ggml_backend_buffer_is_multi_buffer(buffer)) {
        wsp_ggml_backend_multi_buffer_set_usage(buffer, usage);
    }
}

enum wsp_ggml_backend_buffer_usage wsp_ggml_backend_buffer_get_usage(wsp_ggml_backend_buffer_t buffer) {
    WSP_GGML_ASSERT(buffer);
    return buffer->usage;
}

wsp_ggml_backend_buffer_type_t wsp_ggml_backend_buffer_get_type(wsp_ggml_backend_buffer_t buffer) {
    WSP_GGML_ASSERT(buffer);
    return buffer->buft;
}

void wsp_ggml_backend_buffer_reset(wsp_ggml_backend_buffer_t buffer) {
    WSP_GGML_ASSERT(buffer);
    if (buffer->iface.reset) {
        buffer->iface.reset(buffer);
    }
}

bool wsp_ggml_backend_buffer_copy_tensor(const struct wsp_ggml_tensor * src, struct wsp_ggml_tensor * dst) {
    wsp_ggml_backend_buffer_t dst_buf = dst->view_src ? dst->view_src->buffer : dst->buffer;
    if (dst_buf->iface.cpy_tensor) {
        return dst_buf->iface.cpy_tensor(dst_buf, src, dst);
    }
    return false;
}

// backend

wsp_ggml_guid_t wsp_ggml_backend_guid(wsp_ggml_backend_t backend) {
    if (backend == NULL) {
        return NULL;
    }
    return backend->guid;
}

const char * wsp_ggml_backend_name(wsp_ggml_backend_t backend) {
    if (backend == NULL) {
        return "NULL";
    }
    return backend->iface.get_name(backend);
}

void wsp_ggml_backend_free(wsp_ggml_backend_t backend) {
    if (backend == NULL) {
        return;
    }

    backend->iface.free(backend);
}

wsp_ggml_backend_buffer_type_t wsp_ggml_backend_get_default_buffer_type(wsp_ggml_backend_t backend) {
    WSP_GGML_ASSERT(backend);
    return wsp_ggml_backend_dev_buffer_type(backend->device);
}

wsp_ggml_backend_buffer_t wsp_ggml_backend_alloc_buffer(wsp_ggml_backend_t backend, size_t size) {
    return wsp_ggml_backend_buft_alloc_buffer(wsp_ggml_backend_get_default_buffer_type(backend), size);
}

size_t wsp_ggml_backend_get_alignment(wsp_ggml_backend_t backend) {
    return wsp_ggml_backend_buft_get_alignment(wsp_ggml_backend_get_default_buffer_type(backend));
}

size_t wsp_ggml_backend_get_max_size(wsp_ggml_backend_t backend) {
    return wsp_ggml_backend_buft_get_max_size(wsp_ggml_backend_get_default_buffer_type(backend));
}

void wsp_ggml_backend_tensor_set_async(wsp_ggml_backend_t backend, struct wsp_ggml_tensor * tensor, const void * data, size_t offset, size_t size) {
    WSP_GGML_ASSERT(backend);
    WSP_GGML_ASSERT(tensor);
    WSP_GGML_ASSERT(tensor->data != NULL && "tensor not allocated");
    WSP_GGML_ASSERT(offset + size <= wsp_ggml_nbytes(tensor) && "tensor write out of bounds");

    if (backend->iface.set_tensor_async == NULL) {
        wsp_ggml_backend_tensor_set(tensor, data, offset, size);
    } else {
        backend->iface.set_tensor_async(backend, tensor, data, offset, size);
    }
}

void wsp_ggml_backend_tensor_get_async(wsp_ggml_backend_t backend, const struct wsp_ggml_tensor * tensor, void * data, size_t offset, size_t size) {
    WSP_GGML_ASSERT(backend);
    WSP_GGML_ASSERT(tensor);
    WSP_GGML_ASSERT(tensor->data != NULL && "tensor not allocated");
    WSP_GGML_ASSERT(offset + size <= wsp_ggml_nbytes(tensor) && "tensor read out of bounds");

    if (backend->iface.get_tensor_async == NULL) {
        wsp_ggml_backend_tensor_get(tensor, data, offset, size);
    } else {
        backend->iface.get_tensor_async(backend, tensor, data, offset, size);
    }
}

void wsp_ggml_backend_tensor_set(struct wsp_ggml_tensor * tensor, const void * data, size_t offset, size_t size) {
    WSP_GGML_ASSERT(tensor);
    wsp_ggml_backend_buffer_t buf = tensor->view_src ? tensor->view_src->buffer : tensor->buffer;

    if (size == 0) {
        return;
    }

    WSP_GGML_ASSERT(buf != NULL && "tensor buffer not set");
    WSP_GGML_ASSERT(tensor->data != NULL && "tensor not allocated");
    WSP_GGML_ASSERT(offset + size <= wsp_ggml_nbytes(tensor) && "tensor write out of bounds");

    buf->iface.set_tensor(buf, tensor, data, offset, size);
}

void wsp_ggml_backend_tensor_get(const struct wsp_ggml_tensor * tensor, void * data, size_t offset, size_t size) {
    WSP_GGML_ASSERT(tensor);
    wsp_ggml_backend_buffer_t buf = tensor->view_src ? tensor->view_src->buffer : tensor->buffer;

    if (size == 0) {
        return;
    }

    WSP_GGML_ASSERT(buf != NULL && "tensor buffer not set");
    WSP_GGML_ASSERT(tensor->data != NULL && "tensor not allocated");
    WSP_GGML_ASSERT(offset + size <= wsp_ggml_nbytes(tensor) && "tensor read out of bounds");

    buf->iface.get_tensor(buf, tensor, data, offset, size);
}

void wsp_ggml_backend_tensor_memset(struct wsp_ggml_tensor * tensor, uint8_t value, size_t offset, size_t size) {
    WSP_GGML_ASSERT(tensor);
    wsp_ggml_backend_buffer_t buf = tensor->view_src ? tensor->view_src->buffer : tensor->buffer;

    if (size == 0) {
        return;
    }

    WSP_GGML_ASSERT(buf != NULL && "tensor buffer not set");
    WSP_GGML_ASSERT(tensor->data != NULL && "tensor not allocated");
    WSP_GGML_ASSERT(offset + size <= wsp_ggml_nbytes(tensor) && "tensor write out of bounds");
    WSP_GGML_ASSERT(buf->iface.memset_tensor != NULL && "memset not implemented by backend buffer");

    buf->iface.memset_tensor(buf, tensor, value, offset, size);
}

void wsp_ggml_backend_synchronize(wsp_ggml_backend_t backend) {
    WSP_GGML_ASSERT(backend);
    if (backend->iface.synchronize == NULL) {
        return;
    }

    backend->iface.synchronize(backend);
}

wsp_ggml_backend_graph_plan_t wsp_ggml_backend_graph_plan_create(wsp_ggml_backend_t backend, struct wsp_ggml_cgraph * cgraph) {
    WSP_GGML_ASSERT(backend);
    WSP_GGML_ASSERT(backend->iface.graph_plan_create != NULL);

    return backend->iface.graph_plan_create(backend, cgraph);
}

void wsp_ggml_backend_graph_plan_free(wsp_ggml_backend_t backend, wsp_ggml_backend_graph_plan_t plan) {
    WSP_GGML_ASSERT(backend);
    WSP_GGML_ASSERT(backend->iface.graph_plan_free != NULL);

    backend->iface.graph_plan_free(backend, plan);
}

enum wsp_ggml_status wsp_ggml_backend_graph_plan_compute(wsp_ggml_backend_t backend, wsp_ggml_backend_graph_plan_t plan) {
    WSP_GGML_ASSERT(backend);
    WSP_GGML_ASSERT(backend->iface.graph_plan_compute != NULL);

    return backend->iface.graph_plan_compute(backend, plan);
}

enum wsp_ggml_status wsp_ggml_backend_graph_compute(wsp_ggml_backend_t backend, struct wsp_ggml_cgraph * cgraph) {
    enum wsp_ggml_status err = wsp_ggml_backend_graph_compute_async(backend, cgraph);
    wsp_ggml_backend_synchronize(backend);
    return err;
}

enum wsp_ggml_status wsp_ggml_backend_graph_compute_async(wsp_ggml_backend_t backend, struct wsp_ggml_cgraph * cgraph) {
    WSP_GGML_ASSERT(backend);
    return backend->iface.graph_compute(backend, cgraph);
}

bool wsp_ggml_backend_supports_op(wsp_ggml_backend_t backend, const struct wsp_ggml_tensor * op) {
    WSP_GGML_ASSERT(backend);
    return wsp_ggml_backend_dev_supports_op(backend->device, op);
}

bool wsp_ggml_backend_supports_buft(wsp_ggml_backend_t backend, wsp_ggml_backend_buffer_type_t buft) {
    WSP_GGML_ASSERT(backend);
    return wsp_ggml_backend_dev_supports_buft(backend->device, buft);
}

bool wsp_ggml_backend_offload_op(wsp_ggml_backend_t backend, const struct wsp_ggml_tensor * op) {
    WSP_GGML_ASSERT(backend);
    return wsp_ggml_backend_dev_offload_op(backend->device, op);
}

wsp_ggml_backend_dev_t wsp_ggml_backend_get_device(wsp_ggml_backend_t backend) {
    WSP_GGML_ASSERT(backend);
    return backend->device;
}

// backend copy

void wsp_ggml_backend_tensor_copy(struct wsp_ggml_tensor * src, struct wsp_ggml_tensor * dst) {
    WSP_GGML_ASSERT(wsp_ggml_are_same_layout(src, dst) && "cannot copy tensors with different layouts");

    if (src == dst) {
        return;
    }

    if (wsp_ggml_backend_buffer_is_host(src->buffer)) {
        wsp_ggml_backend_tensor_set(dst, src->data, 0, wsp_ggml_nbytes(src));
    } else if (wsp_ggml_backend_buffer_is_host(dst->buffer)) {
        wsp_ggml_backend_tensor_get(src, dst->data, 0, wsp_ggml_nbytes(src));
    } else if (!wsp_ggml_backend_buffer_copy_tensor(src, dst)) {
#ifndef NDEBUG
        WSP_GGML_LOG_DEBUG("%s: warning: slow copy from %s to %s\n", __func__, wsp_ggml_backend_buffer_name(src->buffer), wsp_ggml_backend_buffer_name(dst->buffer));
#endif
        size_t nbytes = wsp_ggml_nbytes(src);
        void * data = malloc(nbytes);
        wsp_ggml_backend_tensor_get(src, data, 0, nbytes);
        wsp_ggml_backend_tensor_set(dst, data, 0, nbytes);
        free(data);
    }
}

void wsp_ggml_backend_tensor_copy_async(wsp_ggml_backend_t backend_src, wsp_ggml_backend_t backend_dst, struct wsp_ggml_tensor * src, struct wsp_ggml_tensor * dst) {
    WSP_GGML_ASSERT(wsp_ggml_are_same_layout(src, dst) && "cannot copy tensors with different layouts");

    if (src == dst) {
        return;
    }

    WSP_GGML_ASSERT(backend_dst);
    if (backend_dst->iface.cpy_tensor_async != NULL) {
        if (backend_dst->iface.cpy_tensor_async(backend_src, backend_dst, src, dst)) {
            return;
        }
    }

    // an async copy would normally happen after all the queued operations on both backends are completed
    // to simulate the same behavior, we need to synchronize both backends first, and do a blocking copy
    wsp_ggml_backend_synchronize(backend_src);
    wsp_ggml_backend_synchronize(backend_dst);
    wsp_ggml_backend_tensor_copy(src, dst);
}

// events

wsp_ggml_backend_event_t wsp_ggml_backend_event_new(wsp_ggml_backend_dev_t device) {
    // null device is allowed for the transition period to the device interface
    if (device == NULL || device->iface.event_new == NULL) {
        return NULL;
    }
    return device->iface.event_new(device);
}

void wsp_ggml_backend_event_free(wsp_ggml_backend_event_t event) {
    if (event == NULL) {
        return;
    }
    event->device->iface.event_free(event->device, event);
}

void wsp_ggml_backend_event_record(wsp_ggml_backend_event_t event, wsp_ggml_backend_t backend) {
    WSP_GGML_ASSERT(backend);
    WSP_GGML_ASSERT(backend->iface.event_record != NULL);

    backend->iface.event_record(backend, event);
}

void wsp_ggml_backend_event_synchronize(wsp_ggml_backend_event_t event) {
    WSP_GGML_ASSERT(event);
    WSP_GGML_ASSERT(event->device->iface.event_synchronize);

    event->device->iface.event_synchronize(event->device, event);
}

void wsp_ggml_backend_event_wait(wsp_ggml_backend_t backend, wsp_ggml_backend_event_t event) {
    WSP_GGML_ASSERT(backend);
    WSP_GGML_ASSERT(backend->iface.event_wait != NULL);

    backend->iface.event_wait(backend, event);
}

static void wsp_ggml_backend_graph_optimize(wsp_ggml_backend_t backend, struct wsp_ggml_cgraph * cgraph) {
    WSP_GGML_ASSERT(backend);
    if (backend->iface.graph_optimize != NULL) {
        backend->iface.graph_optimize(backend, cgraph);
    }
}

// Backend device

const char * wsp_ggml_backend_dev_name(wsp_ggml_backend_dev_t device) {
    WSP_GGML_ASSERT(device);
    return device->iface.get_name(device);
}

const char * wsp_ggml_backend_dev_description(wsp_ggml_backend_dev_t device) {
    WSP_GGML_ASSERT(device);
    return device->iface.get_description(device);
}

void wsp_ggml_backend_dev_memory(wsp_ggml_backend_dev_t device, size_t * free, size_t * total) {
    WSP_GGML_ASSERT(device);
    device->iface.get_memory(device, free, total);
}

enum wsp_ggml_backend_dev_type wsp_ggml_backend_dev_type(wsp_ggml_backend_dev_t device) {
    WSP_GGML_ASSERT(device);
    return device->iface.get_type(device);
}

void wsp_ggml_backend_dev_get_props(wsp_ggml_backend_dev_t device, struct wsp_ggml_backend_dev_props * props) {
    memset(props, 0, sizeof(*props));
    device->iface.get_props(device, props);
}

wsp_ggml_backend_reg_t wsp_ggml_backend_dev_backend_reg(wsp_ggml_backend_dev_t device) {
    WSP_GGML_ASSERT(device);
    return device->reg;
}

wsp_ggml_backend_t wsp_ggml_backend_dev_init(wsp_ggml_backend_dev_t device, const char * params) {
    WSP_GGML_ASSERT(device);
    return device->iface.init_backend(device, params);
}

wsp_ggml_backend_buffer_type_t wsp_ggml_backend_dev_buffer_type(wsp_ggml_backend_dev_t device) {
    WSP_GGML_ASSERT(device);
    return device->iface.get_buffer_type(device);
}

wsp_ggml_backend_buffer_type_t wsp_ggml_backend_dev_host_buffer_type(wsp_ggml_backend_dev_t device) {
    WSP_GGML_ASSERT(device);
    if (device->iface.get_host_buffer_type == NULL) {
        return NULL;
    }

    return device->iface.get_host_buffer_type(device);
}

wsp_ggml_backend_buffer_t wsp_ggml_backend_dev_buffer_from_host_ptr(wsp_ggml_backend_dev_t device, void * ptr, size_t size, size_t max_tensor_size) {
    WSP_GGML_ASSERT(device);
    return device->iface.buffer_from_host_ptr(device, ptr, size, max_tensor_size);
}

bool wsp_ggml_backend_dev_supports_op(wsp_ggml_backend_dev_t device, const struct wsp_ggml_tensor * op) {
    WSP_GGML_ASSERT(device);
    return device->iface.supports_op(device, op);
}

bool wsp_ggml_backend_dev_supports_buft(wsp_ggml_backend_dev_t device, wsp_ggml_backend_buffer_type_t buft) {
    WSP_GGML_ASSERT(device);
    return device->iface.supports_buft(device, buft);
}

bool wsp_ggml_backend_dev_offload_op(wsp_ggml_backend_dev_t device, const struct wsp_ggml_tensor * op) {
    WSP_GGML_ASSERT(device);
    if (device->iface.offload_op != NULL) {
        return device->iface.offload_op(device, op);
    }

    return false;
}

// Backend (reg)

const char * wsp_ggml_backend_reg_name(wsp_ggml_backend_reg_t reg) {
    WSP_GGML_ASSERT(reg);
    return reg->iface.get_name(reg);
}

size_t wsp_ggml_backend_reg_dev_count(wsp_ggml_backend_reg_t reg) {
    WSP_GGML_ASSERT(reg);
    return reg->iface.get_device_count(reg);
}

wsp_ggml_backend_dev_t wsp_ggml_backend_reg_dev_get(wsp_ggml_backend_reg_t reg, size_t index) {
    WSP_GGML_ASSERT(reg);
    return reg->iface.get_device(reg, index);
}

void * wsp_ggml_backend_reg_get_proc_address(wsp_ggml_backend_reg_t reg, const char * name) {
    WSP_GGML_ASSERT(reg);
    if (!reg->iface.get_proc_address) {
        return NULL;
    }
    return reg->iface.get_proc_address(reg, name);
}

// multi-buffer buffer

struct wsp_ggml_backend_multi_buffer_context {
    wsp_ggml_backend_buffer_t * buffers;
    size_t n_buffers;
};

static void wsp_ggml_backend_multi_buffer_free_buffer(wsp_ggml_backend_buffer_t buffer) {
    WSP_GGML_ASSERT(buffer);
    wsp_ggml_backend_multi_buffer_context * ctx = (wsp_ggml_backend_multi_buffer_context *) buffer->context;
    for (size_t i = 0; i < ctx->n_buffers; i++) {
        wsp_ggml_backend_buffer_free(ctx->buffers[i]);
    }

    free(ctx->buffers);
    free(ctx);
}

static void wsp_ggml_backend_multi_buffer_clear(wsp_ggml_backend_buffer_t buffer, uint8_t value) {
    WSP_GGML_ASSERT(buffer);
    wsp_ggml_backend_multi_buffer_context * ctx = (wsp_ggml_backend_multi_buffer_context *) buffer->context;
    for (size_t i = 0; i < ctx->n_buffers; i++) {
        wsp_ggml_backend_buffer_clear(ctx->buffers[i], value);
    }
}

static const struct wsp_ggml_backend_buffer_i wsp_ggml_backend_multi_buffer_i = {
    /* .free_buffer     = */ wsp_ggml_backend_multi_buffer_free_buffer,
    /* .get_base        = */ NULL,
    /* .init_tensor     = */ NULL,
    /* .memset_tensor   = */ NULL,
    /* .set_tensor      = */ NULL,
    /* .get_tensor      = */ NULL,
    /* .cpy_tensor      = */ NULL,
    /* .clear           = */ wsp_ggml_backend_multi_buffer_clear,
    /* .reset           = */ NULL,
};

wsp_ggml_backend_buffer_t wsp_ggml_backend_multi_buffer_alloc_buffer(wsp_ggml_backend_buffer_t * buffers, size_t n_buffers) {
    wsp_ggml_backend_multi_buffer_context * ctx = (wsp_ggml_backend_multi_buffer_context *) malloc(sizeof(struct wsp_ggml_backend_multi_buffer_context));
    ctx->n_buffers = n_buffers;
    ctx->buffers = (wsp_ggml_backend_buffer_t *) malloc(n_buffers * sizeof(wsp_ggml_backend_buffer_t));

    WSP_GGML_ASSERT(ctx->buffers != NULL);

    size_t total_size = 0;
    for (size_t i = 0; i < n_buffers; i++) {
        ctx->buffers[i] = buffers[i];
        total_size += wsp_ggml_backend_buffer_get_size(buffers[i]);
    }

    return wsp_ggml_backend_buffer_init(buffers[0]->buft, wsp_ggml_backend_multi_buffer_i, ctx, total_size);
}

bool wsp_ggml_backend_buffer_is_multi_buffer(wsp_ggml_backend_buffer_t buffer) {
    WSP_GGML_ASSERT(buffer);
    return buffer->iface.free_buffer == wsp_ggml_backend_multi_buffer_free_buffer;
}

void wsp_ggml_backend_multi_buffer_set_usage(wsp_ggml_backend_buffer_t buffer, enum wsp_ggml_backend_buffer_usage usage) {
    WSP_GGML_ASSERT(buffer);
    WSP_GGML_ASSERT(wsp_ggml_backend_buffer_is_multi_buffer(buffer));
    wsp_ggml_backend_multi_buffer_context * ctx = (wsp_ggml_backend_multi_buffer_context *) buffer->context;
    for (size_t i = 0; i < ctx->n_buffers; i++) {
        wsp_ggml_backend_buffer_set_usage(ctx->buffers[i], usage);
    }
}

// creates a copy of the tensor with the same memory layout
static struct wsp_ggml_tensor * wsp_ggml_dup_tensor_layout(struct wsp_ggml_context * ctx, const struct wsp_ggml_tensor * tensor) {
    struct wsp_ggml_tensor * dup = wsp_ggml_dup_tensor(ctx, tensor);
    for (int i = 0; i < WSP_GGML_MAX_DIMS; i++) {
        dup->nb[i] = tensor->nb[i];
    }
    return dup;
}

static bool wsp_ggml_is_view_op(enum wsp_ggml_op op) {
    return op == WSP_GGML_OP_VIEW || op == WSP_GGML_OP_RESHAPE || op == WSP_GGML_OP_PERMUTE || op == WSP_GGML_OP_TRANSPOSE;
}

// scheduler

#ifndef WSP_GGML_SCHED_MAX_BACKENDS
#define WSP_GGML_SCHED_MAX_BACKENDS 16
#endif

#ifndef WSP_GGML_SCHED_MAX_SPLIT_INPUTS
#define WSP_GGML_SCHED_MAX_SPLIT_INPUTS 30
#endif

#ifndef WSP_GGML_SCHED_MAX_COPIES
#define WSP_GGML_SCHED_MAX_COPIES 4
#endif

struct wsp_ggml_backend_sched_split {
    int backend_id;
    int i_start;
    int i_end;
    struct wsp_ggml_tensor * inputs[WSP_GGML_SCHED_MAX_SPLIT_INPUTS];
    int n_inputs;
    // graph view of this split
    struct wsp_ggml_cgraph graph;
};

struct wsp_ggml_backend_sched {
    bool is_reset; // true if the scheduler has been reset since the last graph split
    bool is_alloc;

    int n_backends;

    wsp_ggml_backend_t backends[WSP_GGML_SCHED_MAX_BACKENDS];
    wsp_ggml_backend_buffer_type_t bufts[WSP_GGML_SCHED_MAX_BACKENDS];
    wsp_ggml_gallocr_t galloc;

    // hash map of the nodes in the graph
    struct wsp_ggml_hash_set  hash_set;
    int                 * hv_tensor_backend_ids; // [hash_set.size]
    struct wsp_ggml_tensor ** hv_tensor_copies;      // [hash_set.size][n_backends][n_copies]

    int * node_backend_ids; // [graph_size]
    int * leaf_backend_ids; // [graph_size]

    int * prev_node_backend_ids; // [graph_size]
    int * prev_leaf_backend_ids; // [graph_size]

    // copy of the graph with modified inputs
    struct wsp_ggml_cgraph graph;

    // graph splits
    struct wsp_ggml_backend_sched_split * splits;
    int n_splits;
    int splits_capacity;

    // pipeline parallelism support
    int n_copies;
    int cur_copy;
    int next_copy;
    wsp_ggml_backend_event_t events[WSP_GGML_SCHED_MAX_BACKENDS][WSP_GGML_SCHED_MAX_COPIES];
    struct wsp_ggml_tensor * graph_inputs[WSP_GGML_SCHED_MAX_SPLIT_INPUTS];
    int n_graph_inputs;

    struct wsp_ggml_context * ctx;

    wsp_ggml_backend_sched_eval_callback callback_eval;
    void * callback_eval_user_data;

    char * context_buffer;
    size_t context_buffer_size;

    bool op_offload;

    int debug;
};

#define hash_id(tensor) wsp_ggml_hash_find_or_insert(&sched->hash_set, tensor)
#define tensor_backend_id(tensor) sched->hv_tensor_backend_ids[hash_id(tensor)]
#define tensor_id_copy(id, backend_id, copy_id) sched->hv_tensor_copies[(id) * sched->n_backends * sched->n_copies + (backend_id) * sched->n_copies + (copy_id)]
#define tensor_copy(tensor, backend_id, copy_id) tensor_id_copy(hash_id(tensor), backend_id, copy_id)

// returns the priority of the backend, lower id is higher priority
static int wsp_ggml_backend_sched_backend_id(wsp_ggml_backend_sched_t sched, wsp_ggml_backend_t backend) {
    for (int i = 0; i < sched->n_backends; i++) {
        if (sched->backends[i] == backend) {
            return i;
        }
    }
    return -1;
}

static int wsp_ggml_backend_sched_backend_from_buffer(wsp_ggml_backend_sched_t sched, const struct wsp_ggml_tensor * tensor, const struct wsp_ggml_tensor * op) {
    wsp_ggml_backend_buffer_t buffer = tensor->view_src ? tensor->view_src->buffer : tensor->buffer;
    if (buffer == NULL) {
        return -1;
    }

    // find highest prio backend that supports the buffer type and the op
    for (int i = 0; i < sched->n_backends; i++) {
        if (wsp_ggml_backend_supports_buft(sched->backends[i], buffer->buft) &&
            wsp_ggml_backend_supports_op(sched->backends[i], op)) {
            return i;
        }
    }

#ifndef NDEBUG
    WSP_GGML_LOG_DEBUG("%s: warning: no backend supports op %s with a weight with buffer type %s used in tensor %s, the weight will need to be copied\n",
        __func__, wsp_ggml_op_desc(tensor), wsp_ggml_backend_buffer_name(buffer), tensor->name);
#endif

    return -1;
}

#if 0
#define WSP_GGML_SCHED_MAX_SPLITS_DEBUG 4096
static char causes[WSP_GGML_DEFAULT_GRAPH_SIZE*16 + WSP_GGML_SCHED_MAX_SPLITS_DEBUG*WSP_GGML_SCHED_MAX_SPLIT_INPUTS][128]; // debug only
#define SET_CAUSE(node, ...) sprintf(causes[hash_id(node)], __VA_ARGS__)
#define GET_CAUSE(node) causes[hash_id(node)]
#else
#define SET_CAUSE(node, ...)
#define GET_CAUSE(node) ""
#endif

// returns the backend that should be used for the node based on the current locations
static int wsp_ggml_backend_sched_backend_id_from_cur(wsp_ggml_backend_sched_t sched, struct wsp_ggml_tensor * tensor) {
    // assign pre-allocated nodes to their backend
    int cur_backend_id = wsp_ggml_backend_sched_backend_from_buffer(sched, tensor, tensor);
    if (cur_backend_id != -1) {
        SET_CAUSE(tensor, "1.dst");
        return cur_backend_id;
    }

    // view_src
    if (tensor->view_src != NULL) {
        cur_backend_id = wsp_ggml_backend_sched_backend_from_buffer(sched, tensor->view_src, tensor);
        if (cur_backend_id != -1) {
            SET_CAUSE(tensor, "1.vsrc");
            return cur_backend_id;
        }
    }

    if (tensor->buffer || (tensor->view_src && tensor->view_src->buffer)) {
        // since the tensor is pre-allocated, it cannot be moved to another backend
        wsp_ggml_backend_buffer_t buffer = tensor->view_src ? tensor->view_src->buffer : tensor->buffer;
        WSP_GGML_ABORT("pre-allocated tensor (%s) in a buffer (%s) that cannot run the operation (%s)", tensor->name, wsp_ggml_backend_buffer_name(buffer), wsp_ggml_op_name(tensor->op));
    }

    // graph input
    if (tensor->flags & WSP_GGML_TENSOR_FLAG_INPUT) {
        cur_backend_id = sched->n_backends - 1; // last backend (assumed CPU)
        SET_CAUSE(tensor, "1.inp");
        return cur_backend_id;
    }

    // operations with weights are preferably run on the same backend as the weights
    for (int i = 0; i < WSP_GGML_MAX_SRC; i++) {
        const struct wsp_ggml_tensor * src = tensor->src[i];
        if (src == NULL) {
            continue;
        }
        // skip ROPE since the rope freqs tensor is too small to choose a backend based on it
        // not an ideal solution
        if (tensor->op != WSP_GGML_OP_ROPE && src->buffer != NULL && src->buffer->usage == WSP_GGML_BACKEND_BUFFER_USAGE_WEIGHTS) {
            int src_backend_id = wsp_ggml_backend_sched_backend_from_buffer(sched, src, tensor);
            // check if a backend with higher prio wants to offload the op
            if (sched->op_offload && src_backend_id == sched->n_backends - 1 && wsp_ggml_backend_buffer_is_host(src->buffer)) {
                for (int b = 0; b < src_backend_id; b++) {
                    if (wsp_ggml_backend_supports_op(sched->backends[b], tensor) && wsp_ggml_backend_offload_op(sched->backends[b], tensor)) {
                        SET_CAUSE(tensor, "1.off");
                        return b;
                    }
                }
            }
            SET_CAUSE(tensor, "1.wgt%d", i);
            return src_backend_id;
        }
    }

    return -1;
}

static char * fmt_size(size_t size) {
    static char buffer[128];
    if (size >= 1024*1024) {
        snprintf(buffer, sizeof(buffer), "%zuM", size/1024/1024);
    } else {
        snprintf(buffer, sizeof(buffer), "%zuK", size/1024);
    }
    return buffer;
}

static void wsp_ggml_backend_sched_print_assignments(wsp_ggml_backend_sched_t sched, struct wsp_ggml_cgraph * graph) {
    int cur_split = 0;
    for (int i = 0; i < graph->n_nodes; i++) {
        if (cur_split < sched->n_splits && i == sched->splits[cur_split].i_start) {
            wsp_ggml_backend_t split_backend = sched->backends[sched->splits[cur_split].backend_id];
            WSP_GGML_LOG_DEBUG("\n## SPLIT #%d: %s # %d inputs", cur_split, wsp_ggml_backend_name(split_backend),
                sched->splits[cur_split].n_inputs);
            for (int j = 0; j < sched->splits[cur_split].n_inputs; j++) {
                if (j == 0) {
                    WSP_GGML_LOG_DEBUG(": ");
                }
                WSP_GGML_LOG_DEBUG("[%s (%5.5s)] ", sched->splits[cur_split].inputs[j]->name,
                    fmt_size(wsp_ggml_nbytes(sched->splits[cur_split].inputs[j])));
            }
            WSP_GGML_LOG_DEBUG("\n");
            cur_split++;
        }
        struct wsp_ggml_tensor * node = graph->nodes[i];
        if (wsp_ggml_is_view_op(node->op)) {
            continue;
        }
        if (sched->debug > 1) {
            wsp_ggml_backend_t tensor_backend = wsp_ggml_backend_sched_get_tensor_backend(sched, node);
            WSP_GGML_LOG_DEBUG("node #%3d (%10.10s): %20.20s (%5.5s) [%5.5s %8.8s] use=%d:", i, wsp_ggml_op_name(node->op), node->name,
                fmt_size(wsp_ggml_nbytes(node)), tensor_backend ? wsp_ggml_backend_name(tensor_backend) : "NULL", GET_CAUSE(node),
                graph->use_counts[wsp_ggml_hash_find(&graph->visited_hash_set, node)]);
            for (int j = 0; j < WSP_GGML_MAX_SRC; j++) {
                struct wsp_ggml_tensor * src = node->src[j];
                if (src == NULL) {
                    continue;
                }
                wsp_ggml_backend_t src_backend = wsp_ggml_backend_sched_get_tensor_backend(sched, src);
                WSP_GGML_LOG_DEBUG(" %20.20s (%5.5s) [%5.5s %8.8s]", src->name,
                    fmt_size(wsp_ggml_nbytes(src)), src_backend ? wsp_ggml_backend_name(src_backend) : "NULL", GET_CAUSE(src));
            }
            WSP_GGML_LOG_DEBUG("\n");
        }
    }
}

static bool wsp_ggml_backend_sched_buffer_supported(wsp_ggml_backend_sched_t sched, struct wsp_ggml_tensor * t, int backend_id) {
    wsp_ggml_backend_buffer_t buf = t->view_src ? t->view_src->buffer : t->buffer;
    wsp_ggml_backend_buffer_type_t buft = NULL;

    if (buf) {
        // the tensor is already allocated
        buft = buf->buft;
    } else {
        // see if the tensor already has a backend assigned, and use the buffer type of that backend
        int tensor_backend_id = tensor_backend_id(t);
        if (tensor_backend_id == -1 && t->view_src) {
            tensor_backend_id = tensor_backend_id(t->view_src);
        }
        if (tensor_backend_id != -1) {
            buft = sched->bufts[tensor_backend_id];
        }
    }

    return buft != NULL && wsp_ggml_backend_supports_buft(sched->backends[backend_id], buft);
}

static void wsp_ggml_backend_sched_set_if_supported(wsp_ggml_backend_sched_t sched, struct wsp_ggml_tensor * node, int cur_backend_id, int * node_backend_id) {
    if (wsp_ggml_backend_supports_op(sched->backends[cur_backend_id], node)) {
        *node_backend_id = cur_backend_id;
        SET_CAUSE(node, "2.sup");
    }
}

// assigns backends to ops and splits the graph into subgraphs that can be computed on the same backend
void wsp_ggml_backend_sched_split_graph(wsp_ggml_backend_sched_t sched, struct wsp_ggml_cgraph * graph) {
    // reset splits
    sched->n_splits = 0;
    sched->n_graph_inputs = 0;
    sched->is_reset = false;

    struct wsp_ggml_init_params params = {
        /* .mem_size =   */ sched->context_buffer_size,
        /* .mem_buffer = */ sched->context_buffer,
        /* .no_alloc =   */ true
    };

    wsp_ggml_free(sched->ctx);

    sched->ctx = wsp_ggml_init(params);
    if (sched->ctx == NULL) {
        WSP_GGML_ABORT("%s: failed to initialize context\n", __func__);
    }

    // pass 1: assign backends to ops with pre-allocated inputs
    for (int i = 0; i < graph->n_leafs; i++) {
        struct wsp_ggml_tensor * leaf = graph->leafs[i];
        int * leaf_backend_id = &tensor_backend_id(leaf);
        // do not overwrite user assignments
        if (*leaf_backend_id == -1) {
            *leaf_backend_id = wsp_ggml_backend_sched_backend_id_from_cur(sched, leaf);
        }
    }

    for (int i = 0; i < graph->n_nodes; i++) {
        struct wsp_ggml_tensor * node = graph->nodes[i];
        int * node_backend_id = &tensor_backend_id(node);
        // do not overwrite user assignments
        if (*node_backend_id == -1) {
            *node_backend_id = wsp_ggml_backend_sched_backend_id_from_cur(sched, node);

#if 0
            // src
            if (node->op == WSP_GGML_OP_NONE) {
                continue;
            }

            for (int j = 0; j < WSP_GGML_MAX_SRC; j++) {
                struct wsp_ggml_tensor * src = node->src[j];
                if (src == NULL) {
                    continue;
                }
                int * src_backend_id = &tensor_backend_id(src);
                if (*src_backend_id == -1) {
                    *src_backend_id = wsp_ggml_backend_sched_backend_id_from_cur(sched, src);
                }
            }
#endif
        }
    }

    // pass 2: expand current backend assignments
    // assign the same backend to adjacent nodes
    // expand gpu backends (i.e. non last prio) up and down, ignoring cpu (the lowest priority backend)
    // thus, cpu will never be used unless weights are on cpu, or there are no gpu ops between cpu ops
    // ops unsupported by the backend being expanded will be left unassigned so that they can be assigned later when the locations of its inputs are known
    // expand gpu down
    {
        int cur_backend_id = -1;
        for (int i = 0; i < graph->n_nodes; i++) {
            struct wsp_ggml_tensor * node = graph->nodes[i];
            if (wsp_ggml_is_view_op(node->op)) {
                continue;
            }
            int * node_backend_id = &tensor_backend_id(node);
            if (*node_backend_id != -1) {
                if (*node_backend_id == sched->n_backends - 1) {
                    // skip cpu (lowest prio backend)
                    cur_backend_id = -1;
                } else {
                    cur_backend_id = *node_backend_id;
                }
            } else if (cur_backend_id != -1) {
                wsp_ggml_backend_sched_set_if_supported(sched, node, cur_backend_id, node_backend_id);
            }
        }
    }
    // expand gpu up
    {
        int cur_backend_id = -1;
        for (int i = graph->n_nodes - 1; i >= 0; i--) {
            struct wsp_ggml_tensor * node = graph->nodes[i];
            if (wsp_ggml_is_view_op(node->op)) {
                continue;
            }
            int * node_backend_id = &tensor_backend_id(node);
            if (*node_backend_id != -1) {
                if (*node_backend_id == sched->n_backends - 1) {
                    // skip cpu (lowest prio backend)
                    cur_backend_id = -1;
                } else {
                    cur_backend_id = *node_backend_id;
                }
            } else if (cur_backend_id != -1) {
                wsp_ggml_backend_sched_set_if_supported(sched, node, cur_backend_id, node_backend_id);
            }
        }
    }
    // expand rest down
    {
        int cur_backend_id = -1;
        for (int i = 0; i < graph->n_nodes; i++) {
            struct wsp_ggml_tensor * node = graph->nodes[i];
            if (wsp_ggml_is_view_op(node->op)) {
                continue;
            }
            int * node_backend_id = &tensor_backend_id(node);
            if (*node_backend_id != -1) {
                cur_backend_id = *node_backend_id;
            } else if (cur_backend_id != -1) {
                wsp_ggml_backend_sched_set_if_supported(sched, node, cur_backend_id, node_backend_id);
            }
        }
    }
    // expand rest up
    {
        int cur_backend_id = -1;
        for (int i = graph->n_nodes - 1; i >= 0; i--) {
            struct wsp_ggml_tensor * node = graph->nodes[i];
            if (wsp_ggml_is_view_op(node->op)) {
                continue;
            }
            int * node_backend_id = &tensor_backend_id(node);
            if (*node_backend_id != -1) {
                cur_backend_id = *node_backend_id;
            } else if (cur_backend_id != -1) {
                wsp_ggml_backend_sched_set_if_supported(sched, node, cur_backend_id, node_backend_id);
            }
        }
    }

    // pass 3: upgrade nodes to higher prio backends with compatible buffer types
    // if the tensor is already in the same buffer type (*) as another higher priority backend, we should move it there
    // however, we also need to verify that the sources are in compatible buffer types
    // (*) the actual requirement is more relaxed, the buffer type of the backend should be supported by all the users of this tensor further down the graph
    // however, this is slow to verify, so we have a more strict requirement that the buffer type is the same
    // this is not uncommon since multiple backends can use host memory, with the same buffer type (eg. BLAS and CPU)
    // additionally, set remaining unassigned nodes to the backend with the most supported inputs
    // only nodes that could not be assigned during expansion due to the backend not supporting the op should be unassigned at this point
    for (int i = 0; i < graph->n_nodes; i++) {
        struct wsp_ggml_tensor * node = graph->nodes[i];
        if (wsp_ggml_is_view_op(node->op)) {
            continue;
        }
        int * node_backend_id = &tensor_backend_id(node);
        if (*node_backend_id == -1) {
            // unassigned node: find the backend with the most supported inputs
            int n_supported_best = -1;
            for (int b = 0; b < sched->n_backends; b++) {
                if (wsp_ggml_backend_supports_op(sched->backends[b], node)) {
                    int n_supported = 0;
                    for (int j = 0; j < WSP_GGML_MAX_SRC; j++) {
                        struct wsp_ggml_tensor * src = node->src[j];
                        if (src == NULL) {
                            continue;
                        }
                        if ((tensor_backend_id(src) != -1 || tensor_backend_id(src->view_src) != -1) && wsp_ggml_backend_sched_buffer_supported(sched, src, b)) {
                            n_supported++;
                        }
                    }
                    if (n_supported > n_supported_best) {
                        n_supported_best = n_supported;
                        *node_backend_id = b;
                        SET_CAUSE(node, "3.best");
                    }
                }
            }
        } else {
            // assigned node: upgrade to higher prio backend if possible
            for (int b = 0; b < *node_backend_id; b++) {
                if (sched->bufts[b] == sched->bufts[*node_backend_id] && wsp_ggml_backend_supports_op(sched->backends[b], node)) {
                    bool supported = true;
                    for (int j = 0; j < WSP_GGML_MAX_SRC; j++) {
                        struct wsp_ggml_tensor * src = node->src[j];
                        if (src == NULL) {
                            continue;
                        }
                        if (!wsp_ggml_backend_sched_buffer_supported(sched, src, b)) {
                            supported = false;
                            break;
                        }
                    }
                    if (supported) {
                        *node_backend_id = b;
                        SET_CAUSE(node, "3.upg");
                        break;
                    }
                }
            }
        }
    }

    // pass 4: assign backends to remaining src from dst and view_src
    for (int i = 0; i < graph->n_nodes; i++) {
        struct wsp_ggml_tensor * node = graph->nodes[i];
        int * cur_backend_id = &tensor_backend_id(node);
        if (node->view_src != NULL && *cur_backend_id == -1) {
            *cur_backend_id = tensor_backend_id(node->view_src);
            SET_CAUSE(node, "4.vsrc");
        }
        for (int j = 0; j < WSP_GGML_MAX_SRC; j++) {
            struct wsp_ggml_tensor * src = node->src[j];
            if (src == NULL) {
                continue;
            }
            int * src_backend_id = &tensor_backend_id(src);
            if (*src_backend_id == -1) {
                if (src->view_src != NULL) {
                    // views are always on the same backend as the source
                    *src_backend_id = tensor_backend_id(src->view_src);
                    SET_CAUSE(src, "4.vsrc");
                } else {
                    *src_backend_id = *cur_backend_id;
                    SET_CAUSE(src, "4.cur");
                }
            }
        }
        // if the node is still unassigned, assign it to the first backend that supports it
        for (int b = 0; b < sched->n_backends && *cur_backend_id == -1; b++) {
            wsp_ggml_backend_sched_set_if_supported(sched, node, b, cur_backend_id);
        }
        WSP_GGML_ASSERT(*cur_backend_id != -1);
    }

    // pass 5: split graph, find tensors that need to be copied
    {
        int i_split = 0;
        struct wsp_ggml_backend_sched_split * split = &sched->splits[0];
        // find the backend of the first split, skipping view ops
        int i = 0;
        for (; i < graph->n_nodes; i++) {
            struct wsp_ggml_tensor * node = graph->nodes[i];
            if (!wsp_ggml_is_view_op(node->op)) {
                split->backend_id = tensor_backend_id(node);
                break;
            }
        }
        split->i_start = 0;
        split->n_inputs = 0;
        int cur_backend_id = split->backend_id;
        for (; i < graph->n_nodes; i++) {
            struct wsp_ggml_tensor * node = graph->nodes[i];

            if (wsp_ggml_is_view_op(node->op)) {
                continue;
            }

            const int node_backend_id = tensor_backend_id(node);

            WSP_GGML_ASSERT(node_backend_id != -1); // all nodes should be assigned by now, this can happen if there is no CPU fallback

            // check if we should start a new split based on the sources of the current node
            bool need_new_split = false;
            if (node_backend_id == cur_backend_id && split->n_inputs > 0) {
                for (int j = 0; j < WSP_GGML_MAX_SRC; j++) {
                    struct wsp_ggml_tensor * src = node->src[j];
                    if (src == NULL) {
                        continue;
                    }
                    // check if a weight is on a different and incompatible backend
                    // by starting a new split, the memory of the previously offloaded weights can be reused
                    if (src->buffer != NULL && src->buffer->usage == WSP_GGML_BACKEND_BUFFER_USAGE_WEIGHTS) {
                        int src_backend_id = tensor_backend_id(src);
                        if (src_backend_id != cur_backend_id && !wsp_ggml_backend_sched_buffer_supported(sched, src, cur_backend_id)) {
                            need_new_split = true;
                            break;
                        }
                    }
                    // check if the split has too many inputs
                    // FIXME: count the number of inputs instead of only checking when full
                    if (split->n_inputs == WSP_GGML_SCHED_MAX_SPLIT_INPUTS) {
                        const size_t id = hash_id(src);
                        int src_backend_id = sched->hv_tensor_backend_ids[id];
                        bool supported = wsp_ggml_backend_sched_buffer_supported(sched, src, cur_backend_id);
                        if (src_backend_id != cur_backend_id && tensor_id_copy(id, cur_backend_id, 0) == NULL && !supported) {
                            need_new_split = true;
                            break;
                        }
                    }
                }
            }

            if (node_backend_id != cur_backend_id || need_new_split) {
                split->i_end = i;
                i_split++;
                if (i_split >= sched->splits_capacity) {
                    sched->splits_capacity *= 2;
                    sched->splits = (wsp_ggml_backend_sched_split *)
                        realloc(sched->splits, sched->splits_capacity * sizeof(struct wsp_ggml_backend_sched_split));
                    WSP_GGML_ASSERT(sched->splits != NULL);
                }
                split = &sched->splits[i_split];
                split->backend_id = node_backend_id;
                split->i_start = i;
                split->n_inputs = 0;
                cur_backend_id = node_backend_id;
            }

            // find inputs that are not on the same backend
            for (int j = 0; j < WSP_GGML_MAX_SRC; j++) {
                struct wsp_ggml_tensor * src = node->src[j];
                if (src == NULL) {
                    continue;
                }

                size_t src_id = hash_id(src);
                const int src_backend_id = sched->hv_tensor_backend_ids[src_id];
                WSP_GGML_ASSERT(src_backend_id != -1); // all inputs should be assigned by now

                if (src->flags & WSP_GGML_TENSOR_FLAG_INPUT && sched->n_copies > 1) {
                    if (tensor_id_copy(src_id, src_backend_id, 0) == NULL) {
                        wsp_ggml_backend_t backend = sched->backends[src_backend_id];
                        for (int c = 0; c < sched->n_copies; c++) {
                            struct wsp_ggml_tensor * tensor_copy;
                            if (c == sched->cur_copy) {
                                tensor_copy = src; // use the original tensor as the current copy
                            } else {
                                tensor_copy = wsp_ggml_dup_tensor_layout(sched->ctx, src);
                                wsp_ggml_format_name(tensor_copy, "%s#%s#%d", wsp_ggml_backend_name(backend), src->name, c);
                            }
                            if (sched->n_copies > 1) {
                                wsp_ggml_set_input(tensor_copy);
                                wsp_ggml_set_output(tensor_copy); // prevent ggml-alloc from overwriting the tensor
                            }
                            tensor_id_copy(src_id, src_backend_id, c) = tensor_copy;
                            SET_CAUSE(tensor_copy, "4.cpy");
                        }
                        int n_graph_inputs = sched->n_graph_inputs++;
                        WSP_GGML_ASSERT(n_graph_inputs < WSP_GGML_SCHED_MAX_SPLIT_INPUTS);
                        sched->graph_inputs[n_graph_inputs] = src;
                    }
                }

                if (src_backend_id != cur_backend_id && !wsp_ggml_backend_sched_buffer_supported(sched, src, cur_backend_id)) {
                    // create a copy of the input in the split's backend
                    if (tensor_id_copy(src_id, cur_backend_id, 0) == NULL) {
                        wsp_ggml_backend_t backend = sched->backends[cur_backend_id];
                        for (int c = 0; c < sched->n_copies; c++) {
                            struct wsp_ggml_tensor * tensor_copy = wsp_ggml_dup_tensor_layout(sched->ctx, src);
                            wsp_ggml_format_name(tensor_copy, "%s#%s#%d", wsp_ggml_backend_name(backend), src->name, c);
                            if (sched->n_copies > 1) {
                                wsp_ggml_set_input(tensor_copy);
                                wsp_ggml_set_output(tensor_copy); // prevent ggml-alloc from overwriting the tensor
                            }
                            tensor_id_copy(src_id, cur_backend_id, c) = tensor_copy;
                            SET_CAUSE(tensor_copy, "4.cpy");
                        }
                        int n_inputs = split->n_inputs++;
                        WSP_GGML_ASSERT(n_inputs < WSP_GGML_SCHED_MAX_SPLIT_INPUTS);
                        split->inputs[n_inputs] = src;
                    }
                    node->src[j] = tensor_id_copy(src_id, cur_backend_id, sched->cur_copy);
                }
            }
        }
        split->i_end = graph->n_nodes;
        sched->n_splits = i_split + 1;
    }

    if (sched->debug) {
        wsp_ggml_backend_sched_print_assignments(sched, graph);
    }

    // swap node_backend_ids and leaf _backend_ids with prevs
    {
        int * tmp = sched->node_backend_ids;
        sched->node_backend_ids = sched->prev_node_backend_ids;
        sched->prev_node_backend_ids = tmp;

        tmp = sched->leaf_backend_ids;
        sched->leaf_backend_ids = sched->prev_leaf_backend_ids;
        sched->prev_leaf_backend_ids = tmp;
    }

    int graph_size = std::max(graph->n_nodes, graph->n_leafs) + sched->n_splits*WSP_GGML_SCHED_MAX_SPLIT_INPUTS*2*sched->n_copies;
    if (sched->graph.size < graph_size) {
        sched->graph.size = graph_size;
        sched->graph.nodes = (wsp_ggml_tensor **) realloc(sched->graph.nodes, graph_size * sizeof(struct wsp_ggml_tensor *));
        sched->graph.leafs = (wsp_ggml_tensor **) realloc(sched->graph.leafs, graph_size * sizeof(struct wsp_ggml_tensor *));
        WSP_GGML_ASSERT(sched->graph.nodes != NULL);
        WSP_GGML_ASSERT(sched->graph.leafs != NULL);
    }
    sched->graph.n_nodes = 0;
    sched->graph.n_leafs = 0;

    struct wsp_ggml_cgraph * graph_copy = &sched->graph;

    for (int i = 0; i < sched->n_splits; i++) {
        struct wsp_ggml_backend_sched_split * split = &sched->splits[i];
        split->graph = wsp_ggml_graph_view(graph, split->i_start, split->i_end);

        // Optimize this split of the graph. This needs to happen before we make graph_copy,
        // so they are in sync.
        wsp_ggml_backend_graph_optimize(sched->backends[split->backend_id], &split->graph);

        // add inputs to the graph copy so that they are allocated by ggml-alloc at the start of the split
        for (int j = 0; j < split->n_inputs; j++) {
            assert(graph_copy->size > (graph_copy->n_nodes + 1));

            struct wsp_ggml_tensor * input = split->inputs[j];
            const size_t input_id = hash_id(input);
            struct wsp_ggml_tensor * input_cpy = tensor_id_copy(input_id, split->backend_id, sched->cur_copy);

            // add a dependency to the input source so that it is not freed before the copy is done
            struct wsp_ggml_tensor * input_dep = wsp_ggml_view_tensor(sched->ctx, input);
            input_dep->src[0] = input;
            sched->node_backend_ids[graph_copy->n_nodes] = sched->hv_tensor_backend_ids[input_id];
            graph_copy->nodes[graph_copy->n_nodes++] = input_dep;

            // add a dependency to the input copy so that it is allocated at the start of the split
            sched->node_backend_ids[graph_copy->n_nodes] = split->backend_id;
            graph_copy->nodes[graph_copy->n_nodes++] = input_cpy;
        }

        for (int j = split->i_start; j < split->i_end; j++) {
            assert(graph_copy->size > graph_copy->n_nodes);
            sched->node_backend_ids[graph_copy->n_nodes] = tensor_backend_id(graph->nodes[j]);
            graph_copy->nodes[graph_copy->n_nodes++] = graph->nodes[j];
        }
    }

    if (sched->n_copies > 1) {
        // add input copies as leafs so that they are allocated first
        for (int i = 0; i < sched->n_graph_inputs; i++) {
            struct wsp_ggml_tensor * input = sched->graph_inputs[i];
            size_t id = hash_id(input);
            int backend_id = tensor_backend_id(input);
            for (int c = 0; c < sched->n_copies; c++) {
                struct wsp_ggml_tensor * input_cpy = tensor_id_copy(id, backend_id, c);
                sched->leaf_backend_ids[graph_copy->n_leafs] = backend_id;
                assert(graph_copy->size > graph_copy->n_leafs);
                graph_copy->leafs[graph_copy->n_leafs++] = input_cpy;
            }
        }

        for (int i = 0; i < sched->n_splits; i++) {
            struct wsp_ggml_backend_sched_split * split = &sched->splits[i];
            int backend_id = split->backend_id;
            for (int j = 0; j < split->n_inputs; j++) {
                struct wsp_ggml_tensor * input = split->inputs[j];
                size_t id = hash_id(input);
                for (int c = 0; c < sched->n_copies; c++) {
                    struct wsp_ggml_tensor * input_cpy = tensor_id_copy(id, backend_id, c);
                    sched->leaf_backend_ids[graph_copy->n_leafs] = backend_id;
                    assert(graph_copy->size > graph_copy->n_leafs);
                    graph_copy->leafs[graph_copy->n_leafs++] = input_cpy;
                }
            }
        }
    }

    // add leafs from the original graph
    for (int i = 0; i < graph->n_leafs; i++) {
        struct wsp_ggml_tensor * leaf = graph->leafs[i];
        sched->leaf_backend_ids[graph_copy->n_leafs] = tensor_backend_id(leaf);
        assert(graph_copy->size > graph_copy->n_leafs);
        graph_copy->leafs[graph_copy->n_leafs++] = leaf;
    }
}

static bool wsp_ggml_backend_sched_alloc_splits(wsp_ggml_backend_sched_t sched) {
    bool backend_ids_changed = false;
    for (int i = 0; i < sched->graph.n_nodes; i++) {
        if (sched->node_backend_ids[i] != sched->prev_node_backend_ids[i] &&
            sched->bufts[sched->node_backend_ids[i]] != sched->bufts[sched->prev_node_backend_ids[i]]) {
            backend_ids_changed = true;
            break;
        }
    }
    if (!backend_ids_changed) {
        for (int i = 0; i < sched->graph.n_leafs; i++) {
            if (sched->leaf_backend_ids[i] != sched->prev_leaf_backend_ids[i] &&
                sched->bufts[sched->leaf_backend_ids[i]] != sched->bufts[sched->prev_leaf_backend_ids[i]]) {
                backend_ids_changed = true;
                break;
            }
        }
    }

    // allocate graph
    if (backend_ids_changed || !wsp_ggml_gallocr_alloc_graph(sched->galloc, &sched->graph)) {
        // the re-allocation may cause the split inputs to be moved to a different address
        // synchronize without wsp_ggml_backend_sched_synchronize to avoid changing cur_copy
        for (int i = 0; i < sched->n_backends; i++) {
            wsp_ggml_backend_synchronize(sched->backends[i]);
        }
#ifndef NDEBUG
        WSP_GGML_LOG_DEBUG("%s: failed to allocate graph, reserving (backend_ids_changed = %d)\n", __func__, backend_ids_changed);
#endif
        wsp_ggml_gallocr_reserve_n(sched->galloc, &sched->graph, sched->node_backend_ids, sched->leaf_backend_ids);
        if (!wsp_ggml_gallocr_alloc_graph(sched->galloc, &sched->graph)) {
            WSP_GGML_LOG_ERROR("%s: failed to allocate graph\n", __func__);
            return false;
        }
    }

    return true;
}

static enum wsp_ggml_status wsp_ggml_backend_sched_compute_splits(wsp_ggml_backend_sched_t sched) {
    WSP_GGML_ASSERT(sched);
    struct wsp_ggml_backend_sched_split * splits = sched->splits;

    wsp_ggml_tensor * prev_ids_tensor = nullptr;
    std::vector<int32_t> ids;
    std::vector<wsp_ggml_bitset_t> used_ids;

    for (int split_id = 0; split_id < sched->n_splits; split_id++) {
        struct wsp_ggml_backend_sched_split * split = &splits[split_id];
        int split_backend_id = split->backend_id;
        wsp_ggml_backend_t split_backend = sched->backends[split_backend_id];

        // copy the input tensors to the split backend
        for (int input_id = 0; input_id < split->n_inputs; input_id++) {
            wsp_ggml_backend_t input_backend = wsp_ggml_backend_sched_get_tensor_backend(sched, split->inputs[input_id]);
            struct wsp_ggml_tensor * input = split->inputs[input_id];
            struct wsp_ggml_tensor * input_cpy = tensor_copy(input, split_backend_id, sched->cur_copy);

            if (input->flags & WSP_GGML_TENSOR_FLAG_INPUT) {
                // inputs from the user must be copied immediately to prevent the user overwriting the data before the copy is done
                if (sched->events[split_backend_id][sched->cur_copy] != NULL) {
                    wsp_ggml_backend_event_synchronize(sched->events[split_backend_id][sched->cur_copy]);
                } else {
                    wsp_ggml_backend_synchronize(split_backend);
                }
                wsp_ggml_backend_tensor_copy(input, input_cpy);
            } else {
                // wait for the split backend to finish using the input before overwriting it
                if (sched->events[split_backend_id][sched->cur_copy] != NULL) {
                    wsp_ggml_backend_event_wait(split_backend, sched->events[split_backend_id][sched->cur_copy]);
                } else {
                    wsp_ggml_backend_synchronize(split_backend);
                }

                // when offloading MoE weights, we can reduce the amount of data copied by copying only the experts that are used
                wsp_ggml_tensor * node = split->graph.nodes[0];
                if (split->graph.n_nodes > 0 &&
                    wsp_ggml_backend_buffer_get_usage(input->buffer) == WSP_GGML_BACKEND_BUFFER_USAGE_WEIGHTS &&
                    wsp_ggml_backend_buffer_is_host(input->buffer) && (
                    (node->src[0] == input_cpy && node->op == WSP_GGML_OP_MUL_MAT_ID)
                    //|| (node->src[1] == input_cpy && node->op == WSP_GGML_OP_ADD_ID) /* WSP_GGML_OP_ADD_ID weights are small and not worth splitting */
                    )) {

                    const int64_t n_expert   = node->op == WSP_GGML_OP_MUL_MAT_ID ? input->ne[2] : input->ne[1];
                    const size_t expert_size = node->op == WSP_GGML_OP_MUL_MAT_ID ? input->nb[2] : input->nb[1];

                    wsp_ggml_backend_synchronize(input_backend);

                    // get the ids
                    wsp_ggml_tensor * ids_tensor = node->src[2];
                    wsp_ggml_backend_t ids_backend = split_backend;

                    // if the ids tensor is also an input of the split, it may not have been copied yet to the split backend
                    // in that case, we use the original ids tensor
                    for (int i = input_id + 1; i < split->n_inputs; i++) {
                        if (ids_tensor == tensor_copy(split->inputs[i], split_backend_id, sched->cur_copy)) {
                            ids_tensor = split->inputs[i];
                            ids_backend = wsp_ggml_backend_sched_get_tensor_backend(sched, split->inputs[i]);
                            break;
                        }
                    }

                    if (ids_tensor != prev_ids_tensor) {
                        ids.resize(wsp_ggml_nbytes(ids_tensor) / sizeof(int32_t));
                        wsp_ggml_backend_tensor_get_async(ids_backend, ids_tensor, ids.data(), 0, wsp_ggml_nbytes(ids_tensor));
                        wsp_ggml_backend_synchronize(ids_backend);

                        // find the used experts
                        used_ids.clear();
                        used_ids.resize(wsp_ggml_bitset_size(n_expert));
                        for (int64_t i1 = 0; i1 < ids_tensor->ne[1]; i1++) {
                            for (int64_t i0 = 0; i0 < ids_tensor->ne[0]; i0++) {
                                int32_t id = ids[i1 * ids_tensor->nb[1]/sizeof(int32_t) + i0 * ids_tensor->nb[0]/sizeof(int32_t)];
                                WSP_GGML_ASSERT(id >= 0 && id < n_expert);
                                wsp_ggml_bitset_set(used_ids.data(), id);
                            }
                        }

                        prev_ids_tensor = ids_tensor;
                    }

                    // group consecutive experts and copy them together
                    auto copy_experts = [&](int32_t first_id, int32_t last_id) {
                        const size_t expert_offset = first_id * expert_size;
                        const size_t expert_size_copy =  (last_id - first_id + 1) * expert_size;
                        const size_t padding = std::min<size_t>(expert_size, 512);
                        const size_t padding_end = last_id < n_expert - 1 ? padding : 0;

                        wsp_ggml_backend_tensor_set_async(split_backend,
                            input_cpy,
                            (const uint8_t *)input->data + expert_offset, expert_offset,
                            // copy a bit extra at the to ensure there are no NaNs in the padding of the last expert
                            // this is necessary for MMQ in the CUDA backend
                            expert_size_copy + padding_end);
                    };

                    int id = 0;
                    while (!wsp_ggml_bitset_get(used_ids.data(), id)) {
                        id++;
                    }
                    int32_t first_id = id;
                    int32_t last_id = first_id;

                    for (++id; id < n_expert; ++id) {
                        if (!wsp_ggml_bitset_get(used_ids.data(), id)) {
                            continue;
                        }

                        if (id == last_id + 1) {
                            last_id = id;
                            continue;
                        }

                        copy_experts(first_id, last_id);

                        first_id = id;
                        last_id = id;
                    }
                    copy_experts(first_id, last_id);
                } else {
                    // try async copy, but if not possible, we can still use a sync copy without synchronizing the dst backend, since we handle the synchronization here with multiple copies and events
                    // TODO: add public function to facilitate this, since applications do not have direct access to the backend interface
                    if (!split_backend->iface.cpy_tensor_async || !split_backend->iface.cpy_tensor_async(input_backend, split_backend, input, input_cpy)) {
                        wsp_ggml_backend_synchronize(input_backend);
                        if (sched->events[split_backend_id][sched->cur_copy] != NULL) {
                            wsp_ggml_backend_event_synchronize(sched->events[split_backend_id][sched->cur_copy]);
                        } else {
                            wsp_ggml_backend_synchronize(split_backend);
                        }
                        wsp_ggml_backend_tensor_copy(input, input_cpy);
                    }
                }
            }
        }

        if (!sched->callback_eval) {
            enum wsp_ggml_status ec = wsp_ggml_backend_graph_compute_async(split_backend, &split->graph);
            if (ec != WSP_GGML_STATUS_SUCCESS) {
                return ec;
            }
        } else {
            // similar to wsp_ggml_backend_compare_graph_backend
            for (int j0 = 0; j0 < split->graph.n_nodes; j0++) {
                struct wsp_ggml_tensor * t = split->graph.nodes[j0];

                // check if the user needs data from this node
                bool need = sched->callback_eval(t, true, sched->callback_eval_user_data);

                int j1 = j0;

                // determine the range [j0, j1] of nodes that can be computed together
                while (!need && j1 < split->graph.n_nodes - 1) {
                    t = split->graph.nodes[++j1];
                    need = sched->callback_eval(t, true, sched->callback_eval_user_data);
                }

                struct wsp_ggml_cgraph gv = wsp_ggml_graph_view(&split->graph, j0, j1 + 1);

                enum wsp_ggml_status ec = wsp_ggml_backend_graph_compute_async(split_backend, &gv);
                if (ec != WSP_GGML_STATUS_SUCCESS) {
                    return ec;
                }

                // TODO: pass backend to the callback, then the user can decide if they want to synchronize
                wsp_ggml_backend_synchronize(split_backend);

                if (need && !sched->callback_eval(t, false, sched->callback_eval_user_data)) {
                    break;
                }

                j0 = j1;
            }
        }

        // record the event of this copy
        if (split->n_inputs > 0) {
            if (sched->events[split_backend_id][sched->cur_copy] != NULL) {
                wsp_ggml_backend_event_record(sched->events[split_backend_id][sched->cur_copy], split_backend);
            }
        }
    }

    return WSP_GGML_STATUS_SUCCESS;
}

wsp_ggml_backend_sched_t wsp_ggml_backend_sched_new(
        wsp_ggml_backend_t * backends,
        wsp_ggml_backend_buffer_type_t * bufts,
        int n_backends,
        size_t graph_size,
        bool parallel,
        bool op_offload) {
    WSP_GGML_ASSERT(n_backends > 0);
    WSP_GGML_ASSERT(n_backends <= WSP_GGML_SCHED_MAX_BACKENDS);
    WSP_GGML_ASSERT(wsp_ggml_backend_dev_type(wsp_ggml_backend_get_device(backends[n_backends - 1])) == WSP_GGML_BACKEND_DEVICE_TYPE_CPU);

    struct wsp_ggml_backend_sched * sched = (wsp_ggml_backend_sched *) calloc(1, sizeof(struct wsp_ggml_backend_sched));

    const char * WSP_GGML_SCHED_DEBUG = getenv("WSP_GGML_SCHED_DEBUG");
    sched->debug = WSP_GGML_SCHED_DEBUG ? atoi(WSP_GGML_SCHED_DEBUG) : 0;
    sched->n_backends = n_backends;
    sched->n_copies = parallel ? WSP_GGML_SCHED_MAX_COPIES : 1;

    // initialize hash table
    // FIXME: needs to be size*2 to account for leafs (do it in graph_split instead)
    sched->hash_set    = wsp_ggml_hash_set_new(graph_size);
    sched->hv_tensor_backend_ids = (int *) malloc(sched->hash_set.size * sizeof(sched->hv_tensor_backend_ids[0]));
    sched->hv_tensor_copies      = (wsp_ggml_tensor **) malloc(sched->hash_set.size * sched->n_backends * sched->n_copies * sizeof(struct wsp_ggml_tensor *));

    const size_t wsp_ggml_sched_max_splits = graph_size; // at most there is one split for each node in the graph
    const size_t nodes_size = graph_size + wsp_ggml_sched_max_splits*WSP_GGML_SCHED_MAX_SPLIT_INPUTS*2;
    sched->node_backend_ids = (int *) calloc(nodes_size, sizeof(sched->node_backend_ids[0]));
    sched->leaf_backend_ids = (int *) calloc(nodes_size, sizeof(sched->leaf_backend_ids[0]));
    sched->prev_node_backend_ids = (int *) calloc(nodes_size, sizeof(sched->prev_node_backend_ids[0]));
    sched->prev_leaf_backend_ids = (int *) calloc(nodes_size, sizeof(sched->prev_leaf_backend_ids[0]));

    sched->context_buffer_size = wsp_ggml_sched_max_splits*WSP_GGML_SCHED_MAX_SPLIT_INPUTS*2*sizeof(struct wsp_ggml_tensor) + wsp_ggml_graph_overhead_custom(graph_size, false);
    sched->context_buffer = (char *) malloc(sched->context_buffer_size);

    const int initial_splits_capacity = 16;
    sched->splits = (wsp_ggml_backend_sched_split *) calloc(initial_splits_capacity, sizeof(sched->splits[0]));
    sched->splits_capacity = initial_splits_capacity;

    for (int b = 0; b < n_backends; b++) {
        sched->backends[b] = backends[b];
        sched->bufts[b] = bufts ? bufts[b] : wsp_ggml_backend_get_default_buffer_type(backends[b]);
        WSP_GGML_ASSERT(wsp_ggml_backend_supports_buft(backends[b], sched->bufts[b]));

        if (sched->n_copies > 1) {
            for (int c = 0; c < sched->n_copies; c++) {
                sched->events[b][c] = wsp_ggml_backend_event_new(backends[b]->device);
            }
        }
    }

    sched->galloc = wsp_ggml_gallocr_new_n(sched->bufts, n_backends);
    sched->op_offload = op_offload;

    wsp_ggml_backend_sched_reset(sched);

    return sched;
}

void wsp_ggml_backend_sched_free(wsp_ggml_backend_sched_t sched) {
    if (sched == NULL) {
        return;
    }
    for (int b = 0; b < sched->n_backends; b++) {
        for (int c = 0; c < sched->n_copies; c++) {
            wsp_ggml_backend_event_free(sched->events[b][c]);
        }
    }
    wsp_ggml_gallocr_free(sched->galloc);
    wsp_ggml_free(sched->ctx);
    wsp_ggml_hash_set_free(&sched->hash_set);
    free(sched->splits);
    free(sched->hv_tensor_backend_ids);
    free(sched->hv_tensor_copies);
    free(sched->node_backend_ids);
    free(sched->leaf_backend_ids);
    free(sched->prev_node_backend_ids);
    free(sched->prev_leaf_backend_ids);
    free(sched->context_buffer);
    free(sched->graph.nodes);
    free(sched->graph.leafs);
    free(sched);
}

void wsp_ggml_backend_sched_reset(wsp_ggml_backend_sched_t sched) {
    WSP_GGML_ASSERT(sched);
    // reset state for the next run
    if (!sched->is_reset) {
        wsp_ggml_hash_set_reset(&sched->hash_set);
        memset(sched->hv_tensor_backend_ids, -1, sched->hash_set.size * sizeof(sched->hv_tensor_backend_ids[0]));
        memset(sched->hv_tensor_copies,       0, sched->hash_set.size * sched->n_backends * sched->n_copies * sizeof(struct wsp_ggml_tensor *));
        sched->is_reset = true;
    }
    sched->is_alloc = false;
}

bool wsp_ggml_backend_sched_reserve(wsp_ggml_backend_sched_t sched, struct wsp_ggml_cgraph * measure_graph) {
    WSP_GGML_ASSERT(sched);
    WSP_GGML_ASSERT((int)sched->hash_set.size >= measure_graph->n_nodes + measure_graph->n_leafs);

    wsp_ggml_backend_sched_synchronize(sched);

    wsp_ggml_backend_sched_split_graph(sched, measure_graph);

    if (!wsp_ggml_gallocr_reserve_n(sched->galloc, &sched->graph, sched->node_backend_ids, sched->leaf_backend_ids)) {
        return false;
    }

    wsp_ggml_backend_sched_reset(sched);

    return true;
}

bool wsp_ggml_backend_sched_alloc_graph(wsp_ggml_backend_sched_t sched, struct wsp_ggml_cgraph * graph) {
    WSP_GGML_ASSERT(sched);
    WSP_GGML_ASSERT((int)sched->hash_set.size >= graph->n_nodes + graph->n_leafs);
    WSP_GGML_ASSERT(!sched->is_alloc);

    sched->cur_copy = sched->next_copy;
    sched->next_copy = (sched->next_copy + 1) % sched->n_copies;

    wsp_ggml_backend_sched_split_graph(sched, graph);

    if (!wsp_ggml_backend_sched_alloc_splits(sched)) {
        return false;
    }

    sched->is_alloc = true;

    return true;
}

enum wsp_ggml_status wsp_ggml_backend_sched_graph_compute(wsp_ggml_backend_sched_t sched, struct wsp_ggml_cgraph * graph) {
    enum wsp_ggml_status err = wsp_ggml_backend_sched_graph_compute_async(sched, graph);
    wsp_ggml_backend_sched_synchronize(sched);
    return err;
}

enum wsp_ggml_status wsp_ggml_backend_sched_graph_compute_async(wsp_ggml_backend_sched_t sched, struct wsp_ggml_cgraph * graph) {
    WSP_GGML_ASSERT(sched);
    if (!sched->is_reset && !sched->is_alloc) {
        wsp_ggml_backend_sched_reset(sched);
    }

    if (!sched->is_alloc) {
        if (!wsp_ggml_backend_sched_alloc_graph(sched, graph)) {
            return WSP_GGML_STATUS_ALLOC_FAILED;
        }
    }

    return wsp_ggml_backend_sched_compute_splits(sched);
}

void wsp_ggml_backend_sched_synchronize(wsp_ggml_backend_sched_t sched) {
    WSP_GGML_ASSERT(sched);
    for (int i = 0; i < sched->n_backends; i++) {
        wsp_ggml_backend_synchronize(sched->backends[i]);
    }
    if (!sched->is_alloc) {
        // if the graph is not already allocated, always use copy 0 after a synchronization
        // this ensures that during generation the same copy is used every time,
        // which avoids changes in the graph that could cause CUDA or other graphs to be disabled
        sched->next_copy = 0;
    }
}

void wsp_ggml_backend_sched_set_eval_callback(wsp_ggml_backend_sched_t sched, wsp_ggml_backend_sched_eval_callback callback, void * user_data) {
    WSP_GGML_ASSERT(sched);
    sched->callback_eval = callback;
    sched->callback_eval_user_data = user_data;
}

int wsp_ggml_backend_sched_get_n_splits(wsp_ggml_backend_sched_t sched) {
    WSP_GGML_ASSERT(sched);
    return sched->n_splits;
}

int wsp_ggml_backend_sched_get_n_copies(wsp_ggml_backend_sched_t sched) {
    WSP_GGML_ASSERT(sched);
    return sched->n_copies;
}

int wsp_ggml_backend_sched_get_n_backends(wsp_ggml_backend_sched_t sched) {
    WSP_GGML_ASSERT(sched);
    return sched->n_backends;
}

wsp_ggml_backend_t wsp_ggml_backend_sched_get_backend(wsp_ggml_backend_sched_t sched, int i) {
    WSP_GGML_ASSERT(sched);
    WSP_GGML_ASSERT(i >= 0 && i < sched->n_backends);
    return sched->backends[i];
}

wsp_ggml_backend_buffer_type_t wsp_ggml_backend_sched_get_buffer_type(wsp_ggml_backend_sched_t sched, wsp_ggml_backend_t backend) {
    WSP_GGML_ASSERT(sched);
    int backend_index = wsp_ggml_backend_sched_backend_id(sched, backend);
    WSP_GGML_ASSERT(backend_index >= 0 && backend_index < sched->n_backends);

    return sched->bufts[backend_index];
}

size_t wsp_ggml_backend_sched_get_buffer_size(wsp_ggml_backend_sched_t sched, wsp_ggml_backend_t backend) {
    WSP_GGML_ASSERT(sched);
    int backend_index = wsp_ggml_backend_sched_backend_id(sched, backend);
    WSP_GGML_ASSERT(backend_index >= 0 && backend_index < sched->n_backends);

    return wsp_ggml_gallocr_get_buffer_size(sched->galloc, backend_index);
}

void wsp_ggml_backend_sched_set_tensor_backend(wsp_ggml_backend_sched_t sched, struct wsp_ggml_tensor * node, wsp_ggml_backend_t backend) {
    WSP_GGML_ASSERT(sched);
    int backend_index = wsp_ggml_backend_sched_backend_id(sched, backend);
    WSP_GGML_ASSERT(backend_index >= 0 && backend_index < sched->n_backends);
    tensor_backend_id(node) = backend_index;
    SET_CAUSE(node, "usr");
    sched->is_reset = false;
}

wsp_ggml_backend_t wsp_ggml_backend_sched_get_tensor_backend(wsp_ggml_backend_sched_t sched, struct wsp_ggml_tensor * node) {
    WSP_GGML_ASSERT(sched);
    int backend_index = tensor_backend_id(node);
    if (backend_index == -1) {
        return NULL;
    }
    return sched->backends[backend_index];
}

// utils

enum wsp_ggml_status wsp_ggml_backend_view_init(struct wsp_ggml_tensor * tensor) {
    WSP_GGML_ASSERT(tensor);
    WSP_GGML_ASSERT(tensor->buffer == NULL);
    WSP_GGML_ASSERT(tensor->view_src != NULL);
    WSP_GGML_ASSERT(tensor->view_src->buffer != NULL);
    WSP_GGML_ASSERT(tensor->view_src->data != NULL);

    tensor->buffer = tensor->view_src->buffer;
    tensor->data = (char *)tensor->view_src->data + tensor->view_offs;
    return wsp_ggml_backend_buffer_init_tensor(tensor->buffer, tensor);
}

enum wsp_ggml_status wsp_ggml_backend_tensor_alloc(wsp_ggml_backend_buffer_t buffer, struct wsp_ggml_tensor * tensor, void * addr) {
    WSP_GGML_ASSERT(tensor);
    WSP_GGML_ASSERT(tensor->buffer == NULL);
    WSP_GGML_ASSERT(tensor->data == NULL);
    WSP_GGML_ASSERT(tensor->view_src == NULL);
    WSP_GGML_ASSERT(addr >= wsp_ggml_backend_buffer_get_base(buffer));
    WSP_GGML_ASSERT((char *)addr + wsp_ggml_backend_buffer_get_alloc_size(buffer, tensor) <=
                (char *)wsp_ggml_backend_buffer_get_base(buffer) + wsp_ggml_backend_buffer_get_size(buffer));

    tensor->buffer = buffer;
    tensor->data = addr;
    return wsp_ggml_backend_buffer_init_tensor(buffer, tensor);
}

static struct wsp_ggml_tensor * graph_copy_dup_tensor(struct wsp_ggml_hash_set hash_set, struct wsp_ggml_tensor ** node_copies,
    struct wsp_ggml_context * ctx_allocated, struct wsp_ggml_context * ctx_unallocated, struct wsp_ggml_tensor * src) {

    WSP_GGML_ASSERT(src != NULL);
    WSP_GGML_ASSERT(src->data && "graph must be allocated");

    size_t id = wsp_ggml_hash_insert(&hash_set, src);
    if (id == WSP_GGML_HASHSET_ALREADY_EXISTS) {
        return node_copies[wsp_ggml_hash_find(&hash_set, src)];
    }

    struct wsp_ggml_tensor * dst = wsp_ggml_dup_tensor_layout(src->data && !src->view_src ? ctx_allocated : ctx_unallocated, src);
    if (src->view_src != NULL) {
        dst->view_src = graph_copy_dup_tensor(hash_set, node_copies, ctx_allocated, ctx_unallocated, src->view_src);
        dst->view_offs = src->view_offs;
    }
    dst->op = src->op;
    memcpy(dst->op_params, src->op_params, sizeof(dst->op_params));
    wsp_ggml_set_name(dst, src->name);

    // copy src
    for (int i = 0; i < WSP_GGML_MAX_SRC; i++) {
        struct wsp_ggml_tensor * s = src->src[i];
        if (s == NULL) {
            continue;
        }
        dst->src[i] = graph_copy_dup_tensor(hash_set, node_copies, ctx_allocated, ctx_unallocated, s);
    }

    node_copies[id] = dst;
    return dst;
}

static void graph_copy_init_tensor(struct wsp_ggml_hash_set * hash_set, struct wsp_ggml_tensor ** node_copies, bool * node_init, struct wsp_ggml_tensor * src) {
    size_t id = wsp_ggml_hash_find(hash_set, src);
    if (node_init[id]) {
        return;
    }
    node_init[id] = true;

    struct wsp_ggml_tensor * dst = node_copies[id];
    if (dst->view_src != NULL) {
        graph_copy_init_tensor(hash_set, node_copies, node_init, src->view_src);
        enum wsp_ggml_status status = wsp_ggml_backend_view_init(dst);
        WSP_GGML_ASSERT(status == WSP_GGML_STATUS_SUCCESS);
    }
    else {
        wsp_ggml_backend_tensor_copy(src, dst);
    }

    // init src
    for (int i = 0; i < WSP_GGML_MAX_SRC; i++) {
        struct wsp_ggml_tensor * s = src->src[i];
        if (s == NULL) {
            continue;
        }
        graph_copy_init_tensor(hash_set, node_copies, node_init, s);
    }
}

struct wsp_ggml_backend_graph_copy wsp_ggml_backend_graph_copy(wsp_ggml_backend_t backend, struct wsp_ggml_cgraph * graph) {
    WSP_GGML_ASSERT(graph);
    struct wsp_ggml_hash_set hash_set = wsp_ggml_hash_set_new(graph->visited_hash_set.size);
    struct wsp_ggml_tensor ** node_copies = (wsp_ggml_tensor **) calloc(hash_set.size, sizeof(node_copies[0])); // NOLINT
    bool * node_init = (bool *) calloc(hash_set.size, sizeof(node_init[0]));

    struct wsp_ggml_init_params params = {
        /* .mem_size   = */ wsp_ggml_tensor_overhead()*hash_set.size + wsp_ggml_graph_overhead_custom(graph->size, false),
        /* .mem_buffer = */ NULL,
        /* .no_alloc   = */ true
    };

    struct wsp_ggml_context * ctx_allocated = wsp_ggml_init(params);
    struct wsp_ggml_context * ctx_unallocated = wsp_ggml_init(params);

    if (ctx_allocated == NULL || ctx_unallocated == NULL) {
        WSP_GGML_LOG_ERROR("%s: failed to allocate context for graph copy\n", __func__);
        wsp_ggml_hash_set_free(&hash_set);
        free(node_copies);
        free(node_init);
        wsp_ggml_free(ctx_allocated);
        wsp_ggml_free(ctx_unallocated);
        return {
            /* .buffer           = */ NULL,
            /* .ctx_allocated    = */ NULL,
            /* .ctx_unallocated  = */ NULL,
            /* .graph            = */ NULL,
        };
    }

    // dup nodes
    for (int i = 0; i < graph->n_nodes; i++) {
        struct wsp_ggml_tensor * node = graph->nodes[i];
        graph_copy_dup_tensor(hash_set, node_copies, ctx_allocated, ctx_unallocated, node);
    }

    // allocate nodes
    wsp_ggml_backend_buffer_t buffer = wsp_ggml_backend_alloc_ctx_tensors(ctx_allocated, backend);
    if (buffer == NULL) {
        WSP_GGML_LOG_ERROR("%s: failed to allocate buffer for graph copy\n", __func__);
        wsp_ggml_hash_set_free(&hash_set);
        free(node_copies);
        free(node_init);
        wsp_ggml_free(ctx_allocated);
        wsp_ggml_free(ctx_unallocated);
        return {
            /* .buffer           = */ NULL,
            /* .ctx_allocated    = */ NULL,
            /* .ctx_unallocated  = */ NULL,
            /* .graph            = */ NULL,
        };
    }

    //printf("copy buffer size: %zu MB\n", wsp_ggml_backend_buffer_get_size(buffer) / 1024 / 1024);

    // copy data and init views
    for (int i = 0; i < graph->n_nodes; i++) {
        struct wsp_ggml_tensor * node = graph->nodes[i];
        graph_copy_init_tensor(&hash_set, node_copies, node_init, node);
    }

    // build graph copy
    struct wsp_ggml_cgraph * graph_copy = wsp_ggml_new_graph_custom(ctx_allocated, graph->size, false);
    for (int i = 0; i < graph->n_nodes; i++) {
        struct wsp_ggml_tensor * node = graph->nodes[i];
        struct wsp_ggml_tensor * node_copy = node_copies[wsp_ggml_hash_find(&hash_set, node)];
        graph_copy->nodes[i] = node_copy;
    }
    graph_copy->n_nodes = graph->n_nodes;

    wsp_ggml_hash_set_free(&hash_set);
    free(node_copies);
    free(node_init);

    return {
        /* .buffer           = */ buffer,
        /* .ctx_allocated    = */ ctx_allocated,
        /* .ctx_unallocated  = */ ctx_unallocated,
        /* .graph            = */ graph_copy,
    };
}

void wsp_ggml_backend_graph_copy_free(struct wsp_ggml_backend_graph_copy copy) {
    wsp_ggml_backend_buffer_free(copy.buffer);
    wsp_ggml_free(copy.ctx_allocated);
    wsp_ggml_free(copy.ctx_unallocated);
}

bool wsp_ggml_backend_compare_graph_backend(wsp_ggml_backend_t backend1, wsp_ggml_backend_t backend2, struct wsp_ggml_cgraph * graph, wsp_ggml_backend_eval_callback callback, void * user_data, struct wsp_ggml_tensor * test_node) {
    struct wsp_ggml_backend_graph_copy copy = wsp_ggml_backend_graph_copy(backend2, graph);
    if (copy.buffer == NULL) {
        return false;
    }

    struct wsp_ggml_cgraph * g1 = graph;
    struct wsp_ggml_cgraph * g2 = copy.graph;

    assert(g1->n_nodes == g2->n_nodes);

    if (test_node != nullptr) {
        // Compute the whole graph and only test the output for a specific tensor
        wsp_ggml_backend_graph_compute(backend1, g1);
        wsp_ggml_backend_graph_compute(backend2, g2);

        int test_node_idx = -1;
        for (int i = 0; i < g1->n_nodes; i++) {
            struct wsp_ggml_tensor * t1 = g1->nodes[i];
            if (t1 == test_node) {
                test_node_idx = i;
                break;
            }
        }
        WSP_GGML_ASSERT(test_node_idx != -1);

        callback(test_node_idx, g1->nodes[test_node_idx], g2->nodes[test_node_idx], user_data);
    } else {
        for (int i = 0; i < g1->n_nodes; i++) {
            struct wsp_ggml_tensor * t1 = g1->nodes[i];
            struct wsp_ggml_tensor * t2 = g2->nodes[i];

            assert(t1->op == t2->op && wsp_ggml_are_same_layout(t1, t2));

            struct wsp_ggml_cgraph g1v = wsp_ggml_graph_view(g1, i, i + 1);
            struct wsp_ggml_cgraph g2v = wsp_ggml_graph_view(g2, i, i + 1);

            wsp_ggml_backend_graph_compute(backend1, &g1v);
            wsp_ggml_backend_graph_compute(backend2, &g2v);

            if (wsp_ggml_is_view_op(t1->op)) {
                continue;
            }

            // compare results, calculate rms etc
            if (!callback(i, t1, t2, user_data)) {
                break;
            }
        }
    }
    wsp_ggml_backend_graph_copy_free(copy);

    return true;
}

// CPU backend - buffer

static void * wsp_ggml_backend_cpu_buffer_get_base(wsp_ggml_backend_buffer_t buffer) {
    WSP_GGML_ASSERT(buffer);
    uintptr_t data = (uintptr_t)buffer->context;

    // align the buffer
    if (data % TENSOR_ALIGNMENT != 0) {
        data = WSP_GGML_PAD(data, TENSOR_ALIGNMENT);
    }

    return (void *)data;
}

static void wsp_ggml_backend_cpu_buffer_free_buffer(wsp_ggml_backend_buffer_t buffer) {
    WSP_GGML_ASSERT(buffer);
    wsp_ggml_aligned_free(buffer->context, buffer->size);
}

static void wsp_ggml_backend_cpu_buffer_memset_tensor(wsp_ggml_backend_buffer_t buffer, struct wsp_ggml_tensor * tensor, uint8_t value, size_t offset, size_t size) {
    WSP_GGML_ASSERT(tensor);
    memset((char *)tensor->data + offset, value, size);

    WSP_GGML_UNUSED(buffer);
}

static void wsp_ggml_backend_cpu_buffer_set_tensor(wsp_ggml_backend_buffer_t buffer, struct wsp_ggml_tensor * tensor, const void * data, size_t offset, size_t size) {
    WSP_GGML_ASSERT(tensor);
    memcpy((char *)tensor->data + offset, data, size);

    WSP_GGML_UNUSED(buffer);
}

static void wsp_ggml_backend_cpu_buffer_get_tensor(wsp_ggml_backend_buffer_t buffer, const struct wsp_ggml_tensor * tensor, void * data, size_t offset, size_t size) {
    WSP_GGML_ASSERT(tensor);
    memcpy(data, (const char *)tensor->data + offset, size);

    WSP_GGML_UNUSED(buffer);
}

static bool wsp_ggml_backend_cpu_buffer_cpy_tensor(wsp_ggml_backend_buffer_t buffer, const struct wsp_ggml_tensor * src, struct wsp_ggml_tensor * dst) {
    WSP_GGML_ASSERT(src);
    if (wsp_ggml_backend_buffer_is_host(src->buffer)) {
        memcpy(dst->data, src->data, wsp_ggml_nbytes(src));
        return true;
    }
    return false;

    WSP_GGML_UNUSED(buffer);
}

static void wsp_ggml_backend_cpu_buffer_clear(wsp_ggml_backend_buffer_t buffer, uint8_t value) {
    WSP_GGML_ASSERT(buffer);
    memset(buffer->context, value, buffer->size);
}

static const struct wsp_ggml_backend_buffer_i wsp_ggml_backend_cpu_buffer_i = {
    /* .free_buffer     = */ wsp_ggml_backend_cpu_buffer_free_buffer,
    /* .get_base        = */ wsp_ggml_backend_cpu_buffer_get_base,
    /* .init_tensor     = */ NULL, // no initialization required
    /* .memset_tensor   = */ wsp_ggml_backend_cpu_buffer_memset_tensor,
    /* .set_tensor      = */ wsp_ggml_backend_cpu_buffer_set_tensor,
    /* .get_tensor      = */ wsp_ggml_backend_cpu_buffer_get_tensor,
    /* .cpy_tensor      = */ wsp_ggml_backend_cpu_buffer_cpy_tensor,
    /* .clear           = */ wsp_ggml_backend_cpu_buffer_clear,
    /* .reset           = */ NULL,
};

static const struct wsp_ggml_backend_buffer_i wsp_ggml_backend_cpu_buffer_from_ptr_i = {
    /* .free_buffer     = */ NULL, // ptr is not owned by the buffer, so it does not need to be freed
    /* .get_base        = */ wsp_ggml_backend_cpu_buffer_get_base,
    /* .init_tensor     = */ NULL, // no initialization required
    /* .memset_tensor   = */ wsp_ggml_backend_cpu_buffer_memset_tensor,
    /* .set_tensor      = */ wsp_ggml_backend_cpu_buffer_set_tensor,
    /* .get_tensor      = */ wsp_ggml_backend_cpu_buffer_get_tensor,
    /* .cpy_tensor      = */ wsp_ggml_backend_cpu_buffer_cpy_tensor,
    /* .clear           = */ wsp_ggml_backend_cpu_buffer_clear,
    /* .reset           = */ NULL,
};

// CPU backend buffer type

// this buffer type is defined here to make it available to all backends

static const char * wsp_ggml_backend_cpu_buffer_type_get_name(wsp_ggml_backend_buffer_type_t buft) {
    return "CPU";

    WSP_GGML_UNUSED(buft);
}

static wsp_ggml_backend_buffer_t wsp_ggml_backend_cpu_buffer_type_alloc_buffer(wsp_ggml_backend_buffer_type_t buft, size_t size) {
    void * data = wsp_ggml_aligned_malloc(size);

    if (data == NULL) {
        WSP_GGML_LOG_ERROR("%s: failed to allocate buffer of size %zu\n", __func__, size);
        return NULL;
    }

    return wsp_ggml_backend_buffer_init(buft, wsp_ggml_backend_cpu_buffer_i, data, size);
}

static size_t wsp_ggml_backend_cpu_buffer_type_get_alignment(wsp_ggml_backend_buffer_type_t buft) {
    return TENSOR_ALIGNMENT;

    WSP_GGML_UNUSED(buft);
}

static bool wsp_ggml_backend_cpu_buffer_type_is_host(wsp_ggml_backend_buffer_type_t buft) {
    return true;

    WSP_GGML_UNUSED(buft);
}

wsp_ggml_backend_buffer_type_t wsp_ggml_backend_cpu_buffer_type(void) {
    static struct wsp_ggml_backend_buffer_type wsp_ggml_backend_cpu_buffer_type = {
        /* .iface   = */ {
            /* .get_name         = */ wsp_ggml_backend_cpu_buffer_type_get_name,
            /* .alloc_buffer     = */ wsp_ggml_backend_cpu_buffer_type_alloc_buffer,
            /* .get_alignment    = */ wsp_ggml_backend_cpu_buffer_type_get_alignment,
            /* .get_max_size     = */ NULL, // defaults to SIZE_MAX
            /* .get_alloc_size   = */ NULL, // defaults to wsp_ggml_nbytes
            /* .is_host          = */ wsp_ggml_backend_cpu_buffer_type_is_host,
        },
        /* .device  = */ NULL, // FIXME wsp_ggml_backend_reg_dev_get(wsp_ggml_backend_cpu_reg(), 0),
        /* .context = */ NULL,
    };

    return &wsp_ggml_backend_cpu_buffer_type;
}

static const char * wsp_ggml_backend_cpu_buffer_from_ptr_type_get_name(wsp_ggml_backend_buffer_type_t buft) {
    return "CPU_Mapped";

    WSP_GGML_UNUSED(buft);
}

static wsp_ggml_backend_buffer_type_t wsp_ggml_backend_cpu_buffer_from_ptr_type(void) {
    static struct wsp_ggml_backend_buffer_type wsp_ggml_backend_cpu_buffer_type = {
        /* .iface   = */ {
            /* .get_name         = */ wsp_ggml_backend_cpu_buffer_from_ptr_type_get_name,
            /* .alloc_buffer     = */ wsp_ggml_backend_cpu_buffer_type_alloc_buffer,
            /* .get_alignment    = */ wsp_ggml_backend_cpu_buffer_type_get_alignment,
            /* .get_max_size     = */ NULL, // defaults to SIZE_MAX
            /* .get_alloc_size   = */ NULL, // defaults to wsp_ggml_nbytes
            /* .is_host          = */ wsp_ggml_backend_cpu_buffer_type_is_host,
        },
        /* .device  = */ NULL, // FIXME wsp_ggml_backend_reg_dev_get(wsp_ggml_backend_cpu_reg(), 0),
        /* .context = */ NULL,
    };

    return &wsp_ggml_backend_cpu_buffer_type;
}

wsp_ggml_backend_buffer_t wsp_ggml_backend_cpu_buffer_from_ptr(void * ptr, size_t size) {
    WSP_GGML_ASSERT((uintptr_t)ptr % TENSOR_ALIGNMENT == 0 && "buffer pointer must be aligned");
    return wsp_ggml_backend_buffer_init(wsp_ggml_backend_cpu_buffer_from_ptr_type(), wsp_ggml_backend_cpu_buffer_from_ptr_i, ptr, size);
}
