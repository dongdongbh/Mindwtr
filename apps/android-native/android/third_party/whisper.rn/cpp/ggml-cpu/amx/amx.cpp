#include "amx.h"
#include "common.h"
#include "mmq.h"
#include "ggml-backend-impl.h"
#include "ggml-backend.h"
#include "ggml-impl.h"
#include "ggml-cpu.h"
#include "traits.h"

#if defined(__linux__)
#include <sys/syscall.h>
#include <unistd.h>
#endif

#include <cstdlib>
#include <cstring>
#include <memory>

#if defined(__AMX_INT8__) && defined(__AVX512VNNI__)

// AMX type_trais
namespace ggml::cpu::amx {
class tensor_traits : public ggml::cpu::tensor_traits {
    bool work_size(int /* n_threads */, const struct wsp_ggml_tensor * op, size_t & size) override {
        size = wsp_ggml_backend_amx_desired_wsize(op);
        return true;
    }

    bool compute_forward(struct wsp_ggml_compute_params * params, struct wsp_ggml_tensor * op) override {
        if (op->op == WSP_GGML_OP_MUL_MAT) {
            wsp_ggml_backend_amx_mul_mat(params, op);
            return true;
        }
        return false;
    }
};

static ggml::cpu::tensor_traits * get_tensor_traits(wsp_ggml_backend_buffer_t, struct wsp_ggml_tensor *) {
    static tensor_traits traits;
    return &traits;
}
}  // namespace ggml::cpu::amx

// AMX buffer interface
static void wsp_ggml_backend_amx_buffer_free_buffer(wsp_ggml_backend_buffer_t buffer) {
    free(buffer->context);
}

static void * wsp_ggml_backend_amx_buffer_get_base(wsp_ggml_backend_buffer_t buffer) {
    return (void *) (buffer->context);
}

static enum wsp_ggml_status wsp_ggml_backend_amx_buffer_init_tensor(wsp_ggml_backend_buffer_t buffer, struct wsp_ggml_tensor * tensor) {
    tensor->extra = (void *) ggml::cpu::amx::get_tensor_traits(buffer, tensor);

    WSP_GGML_UNUSED(buffer);
    return WSP_GGML_STATUS_SUCCESS;
}

static void wsp_ggml_backend_amx_buffer_memset_tensor(wsp_ggml_backend_buffer_t buffer, struct wsp_ggml_tensor * tensor,
                                                  uint8_t value, size_t offset, size_t size) {
    memset((char *) tensor->data + offset, value, size);

    WSP_GGML_UNUSED(buffer);
}

static void wsp_ggml_backend_amx_buffer_set_tensor(wsp_ggml_backend_buffer_t buffer, struct wsp_ggml_tensor * tensor,
                                               const void * data, size_t offset, size_t size) {
    if (qtype_has_amx_kernels(tensor->type)) {
        WSP_GGML_LOG_DEBUG("%s: amx repack tensor %s of type %s\n", __func__, tensor->name, wsp_ggml_type_name(tensor->type));
        wsp_ggml_backend_amx_convert_weight(tensor, data, offset, size);
    } else {
        memcpy((char *) tensor->data + offset, data, size);
    }

    WSP_GGML_UNUSED(buffer);
}

/*
// need to figure what we need to do with buffer->extra.
static void wsp_ggml_backend_amx_buffer_get_tensor(wsp_ggml_backend_buffer_t buffer, const struct wsp_ggml_tensor * tensor, void * data, size_t offset, size_t size) {
    WSP_GGML_ASSERT(!qtype_has_amx_kernels(tensor->type));
    memcpy(data, (const char *)tensor->data + offset, size);

    WSP_GGML_UNUSED(buffer);
}

static bool wsp_ggml_backend_amx_buffer_cpy_tensor(wsp_ggml_backend_buffer_t buffer, const struct wsp_ggml_tensor * src, struct wsp_ggml_tensor * dst) {
    if (wsp_ggml_backend_buffer_is_host(src->buffer)) {
        if (qtype_has_amx_kernels(src->type)) {
            wsp_ggml_backend_amx_convert_weight(dst, src->data, 0, wsp_ggml_nbytes(dst));
        } else {
            memcpy(dst->data, src->data, wsp_ggml_nbytes(src));
        }
        return true;
    }
    return false;

    WSP_GGML_UNUSED(buffer);
}
*/

static void wsp_ggml_backend_amx_buffer_clear(wsp_ggml_backend_buffer_t buffer, uint8_t value) {
    memset(buffer->context, value, buffer->size);
}

static wsp_ggml_backend_buffer_i wsp_ggml_backend_amx_buffer_interface = {
    /* .free_buffer     = */ wsp_ggml_backend_amx_buffer_free_buffer,
    /* .get_base        = */ wsp_ggml_backend_amx_buffer_get_base,
    /* .init_tensor     = */ wsp_ggml_backend_amx_buffer_init_tensor,
    /* .memset_tensor   = */ wsp_ggml_backend_amx_buffer_memset_tensor,
    /* .set_tensor      = */ wsp_ggml_backend_amx_buffer_set_tensor,
    /* .get_tensor      = */ nullptr,
    /* .cpy_tensor      = */ nullptr,
    /* .clear           = */ wsp_ggml_backend_amx_buffer_clear,
    /* .reset           = */ nullptr,
};

static const char * wsp_ggml_backend_amx_buffer_type_get_name(wsp_ggml_backend_buffer_type_t buft) {
    return "AMX";

    WSP_GGML_UNUSED(buft);
}

static wsp_ggml_backend_buffer_t wsp_ggml_backend_amx_buffer_type_alloc_buffer(wsp_ggml_backend_buffer_type_t buft, size_t size) {
    void * data = wsp_ggml_aligned_malloc(size);
    if (data == NULL) {
        fprintf(stderr, "%s: failed to allocate buffer of size %zu\n", __func__, size);
        return NULL;
    }

    return wsp_ggml_backend_buffer_init(buft, wsp_ggml_backend_amx_buffer_interface, data, size);
}

static size_t wsp_ggml_backend_amx_buffer_type_get_alignment(wsp_ggml_backend_buffer_type_t buft) {
    return TENSOR_ALIGNMENT;

    WSP_GGML_UNUSED(buft);
}

namespace ggml::cpu::amx {
class extra_buffer_type : ggml::cpu::extra_buffer_type {
    bool supports_op(wsp_ggml_backend_dev_t, const struct wsp_ggml_tensor * op) override {
        // handle only 2d gemm for now
        auto is_contiguous_2d = [](const struct wsp_ggml_tensor * t) {
            return wsp_ggml_is_contiguous(t) && t->ne[3] == 1 && t->ne[2] == 1;
        };

        if (op->op == WSP_GGML_OP_MUL_MAT && is_contiguous_2d(op->src[0]) &&  // src0 must be contiguous
            is_contiguous_2d(op->src[1]) &&                               // src1 must be contiguous
            op->src[0]->buffer && op->src[0]->buffer->buft == wsp_ggml_backend_amx_buffer_type() &&
            op->src[0]->ne[0] % (TILE_K * 2 * 32) == 0 && // TODO: not sure if correct (https://github.com/ggml-org/llama.cpp/pull/16315)
            op->ne[0] % (TILE_N * 2) == 0 &&                              // out_features is 32x
            (qtype_has_amx_kernels(op->src[0]->type) || (op->src[0]->type == WSP_GGML_TYPE_F16))) {
            // src1 must be host buffer
            if (op->src[1]->buffer && !wsp_ggml_backend_buft_is_host(op->src[1]->buffer->buft)) {
                return false;
            }
            // src1 must be float32
            if (op->src[1]->type == WSP_GGML_TYPE_F32) {
                return true;
            }
        }
        return false;
    }

    ggml::cpu::tensor_traits * get_tensor_traits(const struct wsp_ggml_tensor * op) override {
        if (op->op == WSP_GGML_OP_MUL_MAT && op->src[0]->buffer &&
            op->src[0]->buffer->buft == wsp_ggml_backend_amx_buffer_type()) {
            return (ggml::cpu::tensor_traits *) op->src[0]->extra;
        }

        return nullptr;
    }
};
}  // namespace ggml::cpu::amx

static size_t wsp_ggml_backend_amx_buffer_type_get_alloc_size(wsp_ggml_backend_buffer_type_t buft, const wsp_ggml_tensor * tensor) {
    return wsp_ggml_backend_amx_get_alloc_size(tensor);

    WSP_GGML_UNUSED(buft);
}

#define ARCH_GET_XCOMP_PERM     0x1022
#define ARCH_REQ_XCOMP_PERM     0x1023
#define XFEATURE_XTILECFG       17
#define XFEATURE_XTILEDATA      18

static bool wsp_ggml_amx_init() {
#if defined(__linux__)
    if (syscall(SYS_arch_prctl, ARCH_REQ_XCOMP_PERM, XFEATURE_XTILEDATA)) {
        fprintf(stderr, "AMX is not ready to be used!\n");
        return false;
    }
    return true;
#elif defined(_WIN32)
    return true;
#else
    return false;
#endif
}

wsp_ggml_backend_buffer_type_t wsp_ggml_backend_amx_buffer_type() {
    static struct wsp_ggml_backend_buffer_type wsp_ggml_backend_buffer_type_amx = {
        /* .iface = */ {
                        /* .get_name         = */ wsp_ggml_backend_amx_buffer_type_get_name,
                        /* .alloc_buffer     = */ wsp_ggml_backend_amx_buffer_type_alloc_buffer,
                        /* .get_alignment    = */ wsp_ggml_backend_amx_buffer_type_get_alignment,
                        /* .get_max_size     = */ nullptr,  // defaults to SIZE_MAX
                        /* .get_alloc_size   = */ wsp_ggml_backend_amx_buffer_type_get_alloc_size,
                        /* .is_host          = */ nullptr,
                        },
        /* .device  = */ wsp_ggml_backend_reg_dev_get(wsp_ggml_backend_cpu_reg(), 0),
        /* .context = */ new ggml::cpu::amx::extra_buffer_type(),
    };

    if (!wsp_ggml_amx_init()) {
        return nullptr;
    }

    return &wsp_ggml_backend_buffer_type_amx;
}

#endif  // defined(__AMX_INT8__) && defined(__AVX512VNNI__)
