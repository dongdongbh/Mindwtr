#include "ggml-alloc.h"
#include "ggml-backend-impl.h"
#include "ggml.h"
#include "ggml-impl.h"
#include <assert.h>
#include <limits.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX(a, b) ((a) > (b) ? (a) : (b))
#define MAX_FREE_BLOCKS 256

//#define WSP_GGML_ALLOCATOR_DEBUG

//#define AT_PRINTF(...) WSP_GGML_LOG_DEBUG(__VA_ARGS__)
#define AT_PRINTF(...)


static bool wsp_ggml_is_view(const struct wsp_ggml_tensor * t) {
    return t->view_src != NULL;
}

// ops that return true for this function must not use restrict pointers for their backend implementations
bool wsp_ggml_op_can_inplace(enum wsp_ggml_op op) {
    switch (op) {
        case WSP_GGML_OP_SCALE:
        case WSP_GGML_OP_DIAG_MASK_ZERO:
        case WSP_GGML_OP_DIAG_MASK_INF:
        case WSP_GGML_OP_ADD:
        case WSP_GGML_OP_ADD_ID:
        case WSP_GGML_OP_ADD1:
        case WSP_GGML_OP_SUB:
        case WSP_GGML_OP_MUL:
        case WSP_GGML_OP_DIV:
        case WSP_GGML_OP_SQR:
        case WSP_GGML_OP_SQRT:
        case WSP_GGML_OP_LOG:
        case WSP_GGML_OP_UNARY:
        case WSP_GGML_OP_ROPE:
        case WSP_GGML_OP_ROPE_BACK:
        case WSP_GGML_OP_SILU_BACK:
        case WSP_GGML_OP_RMS_NORM:
        case WSP_GGML_OP_RMS_NORM_BACK:
        case WSP_GGML_OP_SOFT_MAX:
        case WSP_GGML_OP_SOFT_MAX_BACK:
            return true;

        default:
            return false;
    }
}

static size_t aligned_offset(const void * buffer, size_t offset, size_t alignment) {
    assert(alignment && !(alignment & (alignment - 1))); // power of 2
    size_t align = (alignment - (((uintptr_t)buffer + offset) % alignment)) % alignment;
    return offset + align;
}

// tallocr

struct wsp_ggml_tallocr wsp_ggml_tallocr_new(wsp_ggml_backend_buffer_t buffer) {
    void * base = wsp_ggml_backend_buffer_get_base(buffer);
    size_t align = wsp_ggml_backend_buffer_get_alignment(buffer);

    assert(align && !(align & (align - 1))); // power of 2

    struct wsp_ggml_tallocr talloc = (struct wsp_ggml_tallocr) {
        /*.buffer    = */ buffer,
        /*.base      = */ base,
        /*.alignment = */ align,
        /*.offset    = */ aligned_offset(base, 0, align),
    };
    return talloc;
}

enum wsp_ggml_status wsp_ggml_tallocr_alloc(struct wsp_ggml_tallocr * talloc, struct wsp_ggml_tensor * tensor) {
    size_t size = wsp_ggml_backend_buffer_get_alloc_size(talloc->buffer, tensor);
    size = WSP_GGML_PAD(size, talloc->alignment);

    if (talloc->offset + size > wsp_ggml_backend_buffer_get_size(talloc->buffer)) {
        WSP_GGML_LOG_ERROR("%s: not enough space in the buffer to allocate %s (needed %zu, available %zu)\n",
                __func__, tensor->name, size, wsp_ggml_backend_buffer_get_size(talloc->buffer) - talloc->offset);
        WSP_GGML_ABORT("not enough space in the buffer");
    }

    void * addr = (char *)wsp_ggml_backend_buffer_get_base(talloc->buffer) + talloc->offset;
    talloc->offset += size;

    assert(((uintptr_t)addr % talloc->alignment) == 0);

    return wsp_ggml_backend_tensor_alloc(talloc->buffer, tensor, addr);
}

// dynamic tensor allocator

#define WSP_GGML_VBUFFER_MAX_CHUNKS 16

// relative memory address within an allocation that can be split into multiple buffers (chunks)
struct buffer_address {
    int chunk;     // index of a backend buffer
    size_t offset; // local memory offset within the buffer
};

static const struct buffer_address WSP_GGML_BUFFER_ADDRESS_INVALID = { -1, SIZE_MAX };

static bool wsp_ggml_buffer_address_less(struct buffer_address a, struct buffer_address b) {
    return a.chunk != b.chunk ? a.chunk < b.chunk : a.offset < b.offset;
}

struct free_block {
    size_t offset;
    size_t size;
};

struct tallocr_chunk {
    struct free_block free_blocks[MAX_FREE_BLOCKS];
    int n_free_blocks;
    size_t max_size;
};

struct wsp_ggml_dyn_tallocr {
    size_t alignment;
    size_t max_chunk_size;
    struct tallocr_chunk * chunks[WSP_GGML_VBUFFER_MAX_CHUNKS];
    int n_chunks;

#ifdef WSP_GGML_ALLOCATOR_DEBUG
    struct {
        const struct wsp_ggml_tensor * tensor;
        struct buffer_address addr;
    } allocated_tensors[1024];
#endif
};

static void wsp_ggml_dyn_tallocr_insert_block(struct tallocr_chunk * chunk, size_t offset, size_t size) {
    WSP_GGML_ASSERT(chunk->n_free_blocks < MAX_FREE_BLOCKS && "out of free blocks");
    // insert the new block in the correct position to keep the array sorted by address (to make merging blocks faster)
    int insert_pos = 0;
    while (insert_pos < chunk->n_free_blocks && chunk->free_blocks[insert_pos].offset < offset) {
        insert_pos++;
    }
    // shift all blocks from insert_pos onward to make room for the new block
    for (int i = chunk->n_free_blocks; i > insert_pos; i--) {
        chunk->free_blocks[i] = chunk->free_blocks[i-1];
    }
    // insert the new block
    chunk->free_blocks[insert_pos].offset = offset;
    chunk->free_blocks[insert_pos].size = size;
    chunk->n_free_blocks++;
}

static void wsp_ggml_dyn_tallocr_remove_block(struct tallocr_chunk * chunk, int idx) {
    // shift all elements after idx by 1 to the left, overwriting the element at idx
    for (int i = idx; i < chunk->n_free_blocks; i++) {
        chunk->free_blocks[i] = chunk->free_blocks[i+1];
    }
    chunk->n_free_blocks--;
}

static int wsp_ggml_dyn_tallocr_new_chunk(struct wsp_ggml_dyn_tallocr * alloc, size_t min_size) {
    if (alloc->n_chunks >= WSP_GGML_VBUFFER_MAX_CHUNKS) {
        return -1;
    }
    struct tallocr_chunk * chunk = calloc(1, sizeof(struct tallocr_chunk));
    chunk->n_free_blocks = 1;
    chunk->free_blocks[0].offset = 0;
    // available space in a chunk is limited to max_chunk_size, but can be higher if:
    // 1. a single tensor exceeds the maximum, and cannot fit any other way
    // 2. we are running out of chunks
    // backends will either manage to allocate the larger size, or report an error.
    chunk->free_blocks[0].size = MAX(min_size, alloc->max_chunk_size);
    if (alloc->n_chunks == WSP_GGML_VBUFFER_MAX_CHUNKS - 1) {
        chunk->free_blocks[0].size = SIZE_MAX/2;
    }
    alloc->chunks[alloc->n_chunks] = chunk;
    alloc->n_chunks++;
    return alloc->n_chunks - 1;
}

#ifdef WSP_GGML_ALLOCATOR_DEBUG
static void add_allocated_tensor(struct wsp_ggml_dyn_tallocr * alloc, struct buffer_address addr, const struct wsp_ggml_tensor * tensor) {
    for (int i = 0; i < 1024; i++) {
        if (alloc->allocated_tensors[i].tensor == NULL) {
            alloc->allocated_tensors[i].tensor = tensor;
            alloc->allocated_tensors[i].addr = addr;
            return;
        }
    }
    WSP_GGML_ABORT("out of allocated_tensors");
}
static void remove_allocated_tensor(struct wsp_ggml_dyn_tallocr * alloc, struct buffer_address addr, const struct wsp_ggml_tensor * tensor) {
    for (int i = 0; i < 1024; i++) {
        if (alloc->allocated_tensors[i].addr.chunk == addr.chunk && alloc->allocated_tensors[i].addr.offset == addr.offset) {
            alloc->allocated_tensors[i].tensor = NULL;
            return;
        }
    }
    WSP_GGML_ABORT("tried to free tensor %s not found\n", tensor->name);
}
#endif

static struct buffer_address wsp_ggml_dyn_tallocr_alloc(struct wsp_ggml_dyn_tallocr * alloc, size_t size, const struct wsp_ggml_tensor * tensor) {
    size = aligned_offset(NULL, size, alloc->alignment);

    AT_PRINTF("%s: allocating %s (%zu bytes) - ", __func__, tensor->name, size);

    int best_fit_chunk = -1;
    int best_fit_block = -1;
    size_t max_avail = 0;

    // find the best fitting free block besides the last block, within any chunk
    for (int c = 0; c < alloc->n_chunks; ++c) {
        struct tallocr_chunk * chunk = alloc->chunks[c];
        size_t best_fit_size = SIZE_MAX;
        for (int i = 0; i < chunk->n_free_blocks - 1; i++) {
            struct free_block * block = &chunk->free_blocks[i];
            max_avail = MAX(max_avail, block->size);
            if (block->size >= size && block->size <= best_fit_size) {
                best_fit_chunk = c;
                best_fit_block = i;
                best_fit_size = block->size;
            }
        }
    }

    if (best_fit_block == -1) {
        // no suitable block found, try the last block (this may grow a chunks size)
        int64_t best_reuse = INT64_MIN;
        for (int c = 0; c < alloc->n_chunks; ++c) {
            struct tallocr_chunk * chunk = alloc->chunks[c];
            if (chunk->n_free_blocks > 0) {
                struct free_block * block = &chunk->free_blocks[chunk->n_free_blocks - 1];
                max_avail = MAX(max_avail, block->size);
                int64_t reuse_factor = chunk->max_size - block->offset - size;
                // reuse_factor < 0 : amount of extra memory that needs to be allocated
                // reuse_factor = 0 : allocated free space exactly matches tensor size
                // reuse_factor > 0 : superfluous memory that will remain unused
                bool better_reuse = best_reuse < 0 && reuse_factor > best_reuse;
                bool better_fit = reuse_factor >= 0 && reuse_factor < best_reuse;
                if (block->size >= size && (better_reuse || better_fit)) {
                    best_fit_chunk = c;
                    best_fit_block = chunk->n_free_blocks - 1;
                    best_reuse = reuse_factor;
                }
            }
        }
    }

    if (best_fit_block == -1) {
        // none of the existing chunks have enough space left
        best_fit_chunk = wsp_ggml_dyn_tallocr_new_chunk(alloc, size);
        best_fit_block = 0;
    }
    if (best_fit_chunk == -1) {
        // since the last chunk always has virtually endless memory, this should never happen
        WSP_GGML_LOG_ERROR("%s: not enough space in the buffer to allocate %zu bytes, largest block available %zu bytes\n",
            __func__, size, max_avail);
        WSP_GGML_ABORT("graph allocation: failed to reserve memory");
    }

    struct tallocr_chunk * chunk = alloc->chunks[best_fit_chunk];
    struct free_block    * block = &chunk->free_blocks[best_fit_block];
    struct buffer_address  addr  = {.chunk = best_fit_chunk, .offset = block->offset };
    block->offset += size;
    block->size -= size;
    if (block->size == 0) {
        // remove block if empty
        wsp_ggml_dyn_tallocr_remove_block(chunk, best_fit_block);
    }

    AT_PRINTF("block %d, offset %zu, chunk %d\n", best_fit_block, addr.offset, addr.chunk);

#ifdef WSP_GGML_ALLOCATOR_DEBUG
    add_allocated_tensor(alloc, addr, tensor);
    size_t cur_max = addr.offset + size;
    if (cur_max > chunk->max_size) {
        // sort allocated_tensors by chunk/offset
        for (int i = 0; i < 1024; i++) {
            for (int j = i + 1; j < 1024; j++) {
                if (wsp_ggml_buffer_address_less(alloc->allocated_tensors[j].addr, alloc->allocated_tensors[i].addr)) {
                    const struct wsp_ggml_tensor * tmp_tensor = alloc->allocated_tensors[i].tensor;
                    struct buffer_address tmp_addr = alloc->allocated_tensors[i].addr;
                    alloc->allocated_tensors[i].tensor = alloc->allocated_tensors[j].tensor;
                    alloc->allocated_tensors[i].addr = alloc->allocated_tensors[j].addr;
                    alloc->allocated_tensors[j].tensor = tmp_tensor;
                    alloc->allocated_tensors[j].addr = tmp_addr;
                }
            }
        }
        WSP_GGML_LOG_DEBUG("max_size[%d] = %.2f MB: tensors: ", addr.chunk, cur_max / 1024.0 / 1024.0);
        for (int i = 0; i < 1024; i++) {
            if (alloc->allocated_tensors[i].tensor) {
                WSP_GGML_LOG_DEBUG("%s [%d: %zx-%zx] (%.2f MB) ", alloc->allocated_tensors[i].tensor->name,
                    alloc->allocated_tensors[i].addr.chunk,
                    alloc->allocated_tensors[i].addr.offset,
                    alloc->allocated_tensors[i].addr.offset + wsp_ggml_nbytes(alloc->allocated_tensors[i].tensor),
                    wsp_ggml_nbytes(alloc->allocated_tensors[i].tensor) / 1024.0 / 1024.0);
            }
        }
        WSP_GGML_LOG_DEBUG("\n");
    }
#endif

    chunk->max_size = MAX(chunk->max_size, addr.offset + size);

    return addr;

    WSP_GGML_UNUSED(tensor);
}

// this is a very naive implementation, but for our case the number of free blocks should be very small
static void wsp_ggml_dyn_tallocr_free_tensor(struct wsp_ggml_dyn_tallocr * alloc, struct buffer_address addr, size_t size, const struct wsp_ggml_tensor * tensor) {
    size = aligned_offset(NULL, size, alloc->alignment);

    AT_PRINTF("%s: freeing %s at {chunk=%d, offset=%zu} (%zu bytes) - n_free_blocks = %d\n",
        __func__, tensor->name, addr.chunk, addr.offset, size, alloc->chunks[addr.chunk]->n_free_blocks);

#ifdef WSP_GGML_ALLOCATOR_DEBUG
    remove_allocated_tensor(alloc, addr, tensor);
#endif

    struct tallocr_chunk * chunk = alloc->chunks[addr.chunk];

    // see if we can merge with an existing block
    for (int i = 0; i < chunk->n_free_blocks; i++) {
        struct free_block * block = &chunk->free_blocks[i];
        // check if ptr is at the end of the block
        if (block->offset + block->size == addr.offset) {
            block->size += size;
            // check if we can merge with the next block
            if (i < chunk->n_free_blocks - 1) {
                struct free_block * next = &chunk->free_blocks[i+1];
                if (block->offset + block->size == next->offset) {
                    block->size += next->size;
                    wsp_ggml_dyn_tallocr_remove_block(chunk, i+1);
                }
            }
            return;
        }
        // check if ptr is at the beginning of the block
        if (addr.offset + size == block->offset) {
            block->offset = addr.offset;
            block->size += size;
            // check if we can merge with the previous block
            if (i > 0) {
                struct free_block * prev = &chunk->free_blocks[i-1];
                if (prev->offset + prev->size == block->offset) {
                    prev->size += block->size;
                    wsp_ggml_dyn_tallocr_remove_block(chunk, i);
                }
            }
            return;
        }
    }
    // otherwise, add a new block
    wsp_ggml_dyn_tallocr_insert_block(chunk, addr.offset, size);

    WSP_GGML_UNUSED(tensor);
}

static void wsp_ggml_dyn_tallocr_reset(struct wsp_ggml_dyn_tallocr * alloc) {
    for (int i = 0; i < WSP_GGML_VBUFFER_MAX_CHUNKS; i++) {
        free(alloc->chunks[i]);
        alloc->chunks[i] = NULL;
    }
    alloc->n_chunks = 0;

#ifdef WSP_GGML_ALLOCATOR_DEBUG
    for (int i = 0; i < 1024; i++) {
        alloc->allocated_tensors[i].tensor = NULL;
    }
#endif
}

static struct wsp_ggml_dyn_tallocr * wsp_ggml_dyn_tallocr_new(size_t alignment, size_t max_buffer_size) {
    struct wsp_ggml_dyn_tallocr * alloc = (struct wsp_ggml_dyn_tallocr *)malloc(sizeof(struct wsp_ggml_dyn_tallocr));

    *alloc = (struct wsp_ggml_dyn_tallocr) {
        /*.alignment      = */ alignment,
        /*.max_chunk_size = */ MIN(max_buffer_size, SIZE_MAX/2), // clamp to avoid overflows
        /*.chunks         = */ {NULL},
        /*.n_chunks       = */ 0,
#ifdef WSP_GGML_ALLOCATOR_DEBUG
        /*.allocated_tensors = */ {{0}},
#endif
    };

    wsp_ggml_dyn_tallocr_reset(alloc);

    return alloc;
}

static void wsp_ggml_dyn_tallocr_free(struct wsp_ggml_dyn_tallocr * alloc) {
    for (int i = 0; i < alloc->n_chunks; ++i) {
        free(alloc->chunks[i]);
    }
    free(alloc);
}

static size_t wsp_ggml_dyn_tallocr_max_size(struct wsp_ggml_dyn_tallocr * alloc, int chunk) {
    return chunk < alloc->n_chunks ? alloc->chunks[chunk]->max_size : 0;
}


// virtual buffer with contiguous memory range, split into multiple backend buffers (chunks)

struct vbuffer {
    wsp_ggml_backend_buffer_t chunks[WSP_GGML_VBUFFER_MAX_CHUNKS];
};

static void wsp_ggml_vbuffer_free(struct vbuffer * buf) {
    if (buf == NULL) {
        return;
    }
    for (int i = 0; i < WSP_GGML_VBUFFER_MAX_CHUNKS; ++i) {
        wsp_ggml_backend_buffer_free(buf->chunks[i]);
    }
    free(buf);
}

static size_t wsp_ggml_vbuffer_chunk_size(struct vbuffer * buf, int chunk) {
    return buf->chunks[chunk] ? wsp_ggml_backend_buffer_get_size(buf->chunks[chunk]) : 0;
}

static size_t wsp_ggml_vbuffer_size(struct vbuffer * buf) {
    size_t size = 0;
    for (int i = 0; i < WSP_GGML_VBUFFER_MAX_CHUNKS && buf->chunks[i]; ++i) {
        size += wsp_ggml_backend_buffer_get_size(buf->chunks[i]);
    }
    return size;
}

static struct vbuffer * wsp_ggml_vbuffer_alloc(wsp_ggml_backend_buffer_type_t buft, const struct wsp_ggml_dyn_tallocr * talloc, enum wsp_ggml_backend_buffer_usage usage) {
    struct vbuffer * buf = (struct vbuffer *)calloc(1, sizeof(struct vbuffer));
    if (buf == NULL) {
        return NULL;
    }

    for (int n = 0; n < talloc->n_chunks; n++) {
        size_t chunk_size = talloc->chunks[n]->max_size;
        buf->chunks[n] = wsp_ggml_backend_buft_alloc_buffer(buft, chunk_size);
        if (buf->chunks[n] == NULL) {
            wsp_ggml_vbuffer_free(buf);
            return NULL;
        }
        wsp_ggml_backend_buffer_set_usage(buf->chunks[n], usage);
    }
    return buf;
}

static void wsp_ggml_vbuffer_tensor_alloc(struct vbuffer * buf, struct wsp_ggml_tensor * tensor, struct buffer_address buf_addr) {
    void * base = wsp_ggml_backend_buffer_get_base(buf->chunks[buf_addr.chunk]);
    void * addr = (char *)base + buf_addr.offset;
    wsp_ggml_backend_tensor_alloc(buf->chunks[buf_addr.chunk], tensor, addr);
}

static void wsp_ggml_vbuffer_reset(struct vbuffer * buf) {
    for (int i = 0; i < WSP_GGML_VBUFFER_MAX_CHUNKS && buf->chunks[i]; ++i) {
        wsp_ggml_backend_buffer_reset(buf->chunks[i]);
    }
}


/////////////////////////////////////

// graph allocator

struct hash_node {
    int n_children;
    int n_views;
    int buffer_id;
    struct buffer_address addr;
    bool allocated;
};

struct tensor_alloc {
    int buffer_id;
    struct buffer_address addr;
    size_t size_max; // 0 = pre-allocated, unused, or view
};

struct leaf_alloc {
    struct tensor_alloc leaf;
};

struct node_alloc {
    struct tensor_alloc dst;
    struct tensor_alloc src[WSP_GGML_MAX_SRC];
};

struct wsp_ggml_gallocr {
    wsp_ggml_backend_buffer_type_t * bufts; // [n_buffers]
    struct vbuffer ** buffers; // [n_buffers]
    struct wsp_ggml_dyn_tallocr ** buf_tallocs; // [n_buffers]
    int n_buffers;

    struct wsp_ggml_hash_set hash_set;
    struct hash_node * hash_values; // [hash_set.size]

    struct node_alloc * node_allocs; // [n_nodes]
    int n_nodes;

    struct leaf_alloc * leaf_allocs; // [n_leafs]
    int n_leafs;
};

wsp_ggml_gallocr_t wsp_ggml_gallocr_new_n(wsp_ggml_backend_buffer_type_t * bufts, int n_bufs) {
    wsp_ggml_gallocr_t galloc = (wsp_ggml_gallocr_t)calloc(1, sizeof(struct wsp_ggml_gallocr));
    WSP_GGML_ASSERT(galloc != NULL);

    galloc->bufts = calloc(n_bufs, sizeof(wsp_ggml_backend_buffer_type_t));
    WSP_GGML_ASSERT(galloc->bufts != NULL);

    galloc->buffers = calloc(n_bufs, sizeof(struct vbuffer *));
    WSP_GGML_ASSERT(galloc->buffers != NULL);

    galloc->buf_tallocs = calloc(n_bufs, sizeof(struct wsp_ggml_dyn_tallocr *));
    WSP_GGML_ASSERT(galloc->buf_tallocs != NULL);

    for (int i = 0; i < n_bufs; i++) {
        galloc->bufts[i] = bufts[i];
        galloc->buffers[i] = NULL;

        // check if the same buffer type is used multiple times and reuse the same allocator
        for (int j = 0; j < i; j++) {
            if (bufts[i] == bufts[j]) {
                galloc->buf_tallocs[i] = galloc->buf_tallocs[j];
                break;
            }
        }

        if (galloc->buf_tallocs[i] == NULL) {
            size_t alignment = wsp_ggml_backend_buft_get_alignment(bufts[i]);
            size_t max_size = wsp_ggml_backend_buft_get_max_size(bufts[i]);
            galloc->buf_tallocs[i] = wsp_ggml_dyn_tallocr_new(alignment, max_size);
        }
    }
    galloc->n_buffers = n_bufs;

    return galloc;
}

wsp_ggml_gallocr_t wsp_ggml_gallocr_new(wsp_ggml_backend_buffer_type_t buft) {
    return wsp_ggml_gallocr_new_n(&buft, 1);
}

void wsp_ggml_gallocr_free(wsp_ggml_gallocr_t galloc) {
    if (galloc == NULL) {
        return;
    }

    for (int i = 0; i < galloc->n_buffers; i++) {
        if (galloc->buffers != NULL) {
            // skip if already freed
            bool freed = false;
            for (int j = 0; j < i; j++) {
                if (galloc->buffers[j] == galloc->buffers[i]) {
                    freed = true;
                    break;
                }
            }
            if (!freed) {
                wsp_ggml_vbuffer_free(galloc->buffers[i]);
            }
        }
        if (galloc->buf_tallocs != NULL) {
            // skip if already freed
            bool freed = false;
            for (int j = 0; j < i; j++) {
                if (galloc->buf_tallocs[j] == galloc->buf_tallocs[i]) {
                    freed = true;
                    break;
                }
            }
            if (!freed) {
                wsp_ggml_dyn_tallocr_free(galloc->buf_tallocs[i]);
            }
        }
    }

    wsp_ggml_hash_set_free(&galloc->hash_set);
    free(galloc->hash_values);
    free(galloc->bufts);
    free(galloc->buffers);
    free(galloc->buf_tallocs);
    free(galloc->node_allocs);
    free(galloc->leaf_allocs);
    free(galloc);
}

typedef struct wsp_ggml_gallocr * wsp_ggml_gallocr_t;

static struct hash_node * wsp_ggml_gallocr_hash_get(wsp_ggml_gallocr_t galloc, struct wsp_ggml_tensor * t) {
    size_t i = wsp_ggml_hash_find_or_insert(&galloc->hash_set, t);
    return &galloc->hash_values[i];
}

static bool wsp_ggml_gallocr_is_own(wsp_ggml_gallocr_t galloc, struct wsp_ggml_tensor * t) {
    return wsp_ggml_gallocr_hash_get(galloc, t)->allocated;
}

static bool wsp_ggml_gallocr_is_allocated(wsp_ggml_gallocr_t galloc, struct wsp_ggml_tensor * t) {
    return t->data != NULL || wsp_ggml_gallocr_hash_get(galloc, t)->allocated;
}

// free the extra space at the end if the new tensor is smaller
static void wsp_ggml_gallocr_free_extra_space(wsp_ggml_gallocr_t galloc, struct wsp_ggml_tensor * node, struct wsp_ggml_tensor * parent) {
    struct hash_node * hn = wsp_ggml_gallocr_hash_get(galloc, node);
    struct hash_node * p_hn = wsp_ggml_gallocr_hash_get(galloc, parent);

    size_t parent_size = wsp_ggml_backend_buft_get_alloc_size(galloc->bufts[p_hn->buffer_id], parent);
    size_t node_size = wsp_ggml_backend_buft_get_alloc_size(galloc->bufts[hn->buffer_id], node);

    WSP_GGML_ASSERT(parent_size >= node_size);

    if (parent_size > node_size) {
        struct wsp_ggml_dyn_tallocr * p_alloc = galloc->buf_tallocs[p_hn->buffer_id];
        struct buffer_address p_addr = p_hn->addr;
        p_addr.offset += node_size;
        size_t extra_size = parent_size - node_size;
        AT_PRINTF("freeing extra %zu bytes from parent %s for %s\n", extra_size, parent->name, node->name);
        wsp_ggml_dyn_tallocr_free_tensor(p_alloc, p_addr, extra_size, parent);
    }
}

static void wsp_ggml_gallocr_allocate_node(wsp_ggml_gallocr_t galloc, struct wsp_ggml_tensor * node, int buffer_id) {
    WSP_GGML_ASSERT(buffer_id >= 0);
    struct hash_node * hn = wsp_ggml_gallocr_hash_get(galloc, node);

    if (!wsp_ggml_gallocr_is_allocated(galloc, node) && !wsp_ggml_is_view(node)) {
        hn->allocated = true;
        assert(hn->addr.offset == 0);

        // try to reuse a parent's buffer (inplace)
        if (wsp_ggml_op_can_inplace(node->op)) {
            for (int i = 0; i < WSP_GGML_MAX_SRC; i++) {
                struct wsp_ggml_tensor * parent = node->src[i];
                if (parent == NULL) {
                    continue;
                }

                // if the node's data is external, then we cannot re-use it
                if (!wsp_ggml_gallocr_is_own(galloc, parent)) {
                    AT_PRINTF("not reusing parent %s for %s as %p is external\n", parent->name, node->name, parent->data);
                    continue;
                }

                // outputs cannot be reused
                if (parent->flags & WSP_GGML_TENSOR_FLAG_OUTPUT || (parent->view_src != NULL && parent->view_src->flags & WSP_GGML_TENSOR_FLAG_OUTPUT)) {
                    AT_PRINTF("not reusing parent %s for %s as it is an output\n", parent->name, node->name);
                    continue;
                }

                if (!wsp_ggml_are_same_layout(node, parent)) {
                    AT_PRINTF("not reusing parent %s for %s as layouts are different\n", parent->name, node->name);
                    continue;
                }

                struct hash_node * p_hn = wsp_ggml_gallocr_hash_get(galloc, parent);
                if (p_hn->n_children == 1 && p_hn->n_views == 0) {
                    if (wsp_ggml_is_view(parent)) {
                        struct wsp_ggml_tensor * view_src = parent->view_src;
                        struct hash_node * view_src_hn = wsp_ggml_gallocr_hash_get(galloc, view_src);
                        if (view_src_hn->n_views == 1 && view_src_hn->n_children == 0 && view_src->data == parent->data) {
                            AT_PRINTF("reusing view parent %s (%s) for %s\n", parent->name, view_src->name, node->name);
                            assert(view_src_hn->addr.chunk == p_hn->addr.chunk && view_src_hn->addr.offset == p_hn->addr.offset);
                            hn->buffer_id = p_hn->buffer_id;
                            hn->addr = p_hn->addr;
                            p_hn->allocated = false; // avoid freeing the parent
                            view_src_hn->allocated = false;
                            wsp_ggml_gallocr_free_extra_space(galloc, node, view_src);
                            return;
                        }
                    } else {
                        AT_PRINTF("reusing parent %s for %s\n", parent->name, node->name);
                        hn->buffer_id = p_hn->buffer_id;
                        hn->addr = p_hn->addr;
                        p_hn->allocated = false; // avoid freeing the parent
                        wsp_ggml_gallocr_free_extra_space(galloc, node, parent);
                        return;
                    }
                }
            }
        }
        // allocate tensor from the buffer
        struct wsp_ggml_dyn_tallocr * alloc = galloc->buf_tallocs[buffer_id];
        wsp_ggml_backend_buffer_type_t buft = galloc->bufts[buffer_id];
        size_t size = wsp_ggml_backend_buft_get_alloc_size(buft, node);
        hn->buffer_id = buffer_id;
        hn->addr = wsp_ggml_dyn_tallocr_alloc(alloc, size, node);
    }
}

static void wsp_ggml_gallocr_free_node(wsp_ggml_gallocr_t galloc, struct wsp_ggml_tensor * node) {
    // graph outputs are never freed
    if (node->flags & WSP_GGML_TENSOR_FLAG_OUTPUT) {
        AT_PRINTF("not freeing output %s\n", node->name);
        return;
    }

    struct hash_node * hn = wsp_ggml_gallocr_hash_get(galloc, node);
    int buffer_id = hn->buffer_id;
    struct wsp_ggml_dyn_tallocr * alloc = galloc->buf_tallocs[buffer_id];
    wsp_ggml_backend_buffer_type_t buft = galloc->bufts[buffer_id];
    size_t size = wsp_ggml_backend_buft_get_alloc_size(buft, node);
    wsp_ggml_dyn_tallocr_free_tensor(alloc, hn->addr, size, node);
    hn->allocated = false;
}

static int get_node_buffer_id(const int * node_buffer_ids, int i) {
    return node_buffer_ids ? node_buffer_ids[i] : 0;
}

static void wsp_ggml_gallocr_alloc_graph_impl(wsp_ggml_gallocr_t galloc, struct wsp_ggml_cgraph * graph, const int * node_buffer_ids, const int * leaf_buffer_ids) {
    // clear hash tables
    wsp_ggml_hash_set_reset(&galloc->hash_set);
    memset(galloc->hash_values, 0, sizeof(struct hash_node) * galloc->hash_set.size);

    // allocate leafs
    // these may be tensors that the application is not using in the graph, but may still want to allocate for other purposes
    for (int i = 0; i < graph->n_leafs; i++) {
        struct wsp_ggml_tensor * leaf = graph->leafs[i];
        wsp_ggml_gallocr_allocate_node(galloc, leaf, get_node_buffer_id(leaf_buffer_ids, i));
    }

    // count number of children and views
    // allocate other graph inputs and leafs first to avoid overwriting them
    for (int i = 0; i < graph->n_nodes; i++) {
        struct wsp_ggml_tensor * node = graph->nodes[i];

        // TODO: better way to add external dependencies
        // WSP_GGML_OP_NONE does not appear normally in the graph nodes, but is used by ggml-backend to add dependencies to
        // control when some tensors are allocated and freed. in this case, the dependencies are in `src`, but the node
        // itself is never used and should not be considered a dependency
        if (wsp_ggml_is_view(node) && node->op != WSP_GGML_OP_NONE) {
            struct wsp_ggml_tensor * view_src = node->view_src;
            wsp_ggml_gallocr_hash_get(galloc, view_src)->n_views += 1;
        }

        if (node->flags & WSP_GGML_TENSOR_FLAG_INPUT) {
            wsp_ggml_gallocr_allocate_node(galloc, graph->nodes[i], get_node_buffer_id(node_buffer_ids, i));
        }

        for (int j = 0; j < WSP_GGML_MAX_SRC; j++) {
            struct wsp_ggml_tensor * src = node->src[j];
            if (src == NULL) {
                continue;
            }

            wsp_ggml_gallocr_hash_get(galloc, src)->n_children += 1;

            // allocate explicit inputs
            if (src->flags & WSP_GGML_TENSOR_FLAG_INPUT) {
                wsp_ggml_gallocr_allocate_node(galloc, src, get_node_buffer_id(node_buffer_ids, i));
            }
        }
    }

    // allocate tensors
    for (int i = 0; i < graph->n_nodes; i++) {
        struct wsp_ggml_tensor * node = graph->nodes[i];
        int buffer_id = get_node_buffer_id(node_buffer_ids, i);

        // allocate parents (only leafs need to be allocated at this point)
        for (int j = 0; j < WSP_GGML_MAX_SRC; j++) {
            struct wsp_ggml_tensor * parent = node->src[j];
            if (parent == NULL) {
                continue;
            }
            wsp_ggml_gallocr_allocate_node(galloc, parent, buffer_id);
        }

        // allocate node
        wsp_ggml_gallocr_allocate_node(galloc, node, buffer_id);

        AT_PRINTF("exec: %s (%s) <= ", wsp_ggml_op_desc(node), node->name);
        for (int j = 0; j < WSP_GGML_MAX_SRC; j++) {
            struct wsp_ggml_tensor * parent = node->src[j];
            if (parent == NULL) {
                continue;
            }
            AT_PRINTF("%s", parent->name);
            if (j < WSP_GGML_MAX_SRC - 1 && node->src[j + 1] != NULL) {
                AT_PRINTF(", ");
            }
        }
        AT_PRINTF("\n");

        // update parents
        for (int j = 0; j < WSP_GGML_MAX_SRC; j++) {
            struct wsp_ggml_tensor * parent = node->src[j];
            if (parent == NULL) {
                continue;
            }
            struct hash_node * p_hn = wsp_ggml_gallocr_hash_get(galloc, parent);
            p_hn->n_children -= 1;

            AT_PRINTF("parent %s: %d children, %d views, allocated: %d\n",
                parent->name, p_hn->n_children, p_hn->n_views, p_hn->allocated);

            if (p_hn->n_children == 0 && p_hn->n_views == 0) {
                if (wsp_ggml_is_view(parent)) {
                    struct wsp_ggml_tensor * view_src = parent->view_src;
                    struct hash_node * view_src_hn = wsp_ggml_gallocr_hash_get(galloc, view_src);
                    view_src_hn->n_views -= 1;
                    AT_PRINTF("view_src %s: %d children, %d views\n",
                        view_src->name, view_src_hn->n_children, view_src_hn->n_views);
                    if (view_src_hn->n_views == 0 && view_src_hn->n_children == 0 && view_src_hn->allocated) {
                        wsp_ggml_gallocr_free_node(galloc, view_src);
                    }
                }
                else if (p_hn->allocated) {
                    wsp_ggml_gallocr_free_node(galloc, parent);
                }
            }
            AT_PRINTF("\n");
        }
    }
}

bool wsp_ggml_gallocr_reserve_n(wsp_ggml_gallocr_t galloc, struct wsp_ggml_cgraph * graph, const int * node_buffer_ids, const int * leaf_buffer_ids) {
    size_t min_hash_size = graph->n_nodes + graph->n_leafs;
    // add 25% margin to avoid hash collisions
    min_hash_size += min_hash_size / 4;

    // initialize hash table
    if (galloc->hash_set.size < min_hash_size) {
        wsp_ggml_hash_set_free(&galloc->hash_set);
        galloc->hash_set = wsp_ggml_hash_set_new(min_hash_size);
        WSP_GGML_ASSERT(galloc->hash_set.keys != NULL);

        free(galloc->hash_values);
        galloc->hash_values = malloc(sizeof(struct hash_node) * galloc->hash_set.size);
        WSP_GGML_ASSERT(galloc->hash_values != NULL);
    }

    // reset allocators
    for (int i = 0; i < galloc->n_buffers; i++) {
        wsp_ggml_dyn_tallocr_reset(galloc->buf_tallocs[i]);
    }

    // allocate in hash table
    wsp_ggml_gallocr_alloc_graph_impl(galloc, graph, node_buffer_ids, leaf_buffer_ids);

    // set the node_allocs from the hash table
    if (galloc->n_nodes < graph->n_nodes) {
        free(galloc->node_allocs);
        galloc->node_allocs = calloc(graph->n_nodes, sizeof(struct node_alloc));
        WSP_GGML_ASSERT(galloc->node_allocs != NULL);
    }
    galloc->n_nodes = graph->n_nodes;
    for (int i = 0; i < graph->n_nodes; i++) {
        struct wsp_ggml_tensor * node = graph->nodes[i];
        struct node_alloc * node_alloc = &galloc->node_allocs[i];
        if (node->view_src || node->data) {
            node_alloc->dst.buffer_id = -1;
            node_alloc->dst.addr = WSP_GGML_BUFFER_ADDRESS_INVALID;
            node_alloc->dst.size_max = 0;
        } else {
            struct hash_node * hn = wsp_ggml_gallocr_hash_get(galloc, node);
            node_alloc->dst.buffer_id = hn->buffer_id;
            node_alloc->dst.addr = hn->addr;
            node_alloc->dst.size_max  = wsp_ggml_backend_buft_get_alloc_size(galloc->bufts[hn->buffer_id], node);
        }
        for (int j = 0; j < WSP_GGML_MAX_SRC; j++) {
            struct wsp_ggml_tensor * src = node->src[j];
            if (!src || src->view_src || src->data) {
                node_alloc->src[j].buffer_id = -1;
                node_alloc->src[j].addr = WSP_GGML_BUFFER_ADDRESS_INVALID;
                node_alloc->src[j].size_max = 0;
            } else {
                struct hash_node * hn = wsp_ggml_gallocr_hash_get(galloc, src);
                node_alloc->src[j].buffer_id = hn->buffer_id;
                node_alloc->src[j].addr = hn->addr;
                node_alloc->src[j].size_max = wsp_ggml_backend_buft_get_alloc_size(galloc->bufts[hn->buffer_id], src);
            }
        }
    }
    if (galloc->n_leafs < graph->n_leafs) {
        free(galloc->leaf_allocs);
        galloc->leaf_allocs = calloc(graph->n_leafs, sizeof(galloc->leaf_allocs[0]));
        WSP_GGML_ASSERT(galloc->leaf_allocs != NULL);
    }
    galloc->n_leafs = graph->n_leafs;
    for (int i = 0; i < graph->n_leafs; i++) {
        struct wsp_ggml_tensor * leaf = graph->leafs[i];
        struct hash_node * hn = wsp_ggml_gallocr_hash_get(galloc, leaf);
        if (leaf->view_src || leaf->data) {
            galloc->leaf_allocs[i].leaf.buffer_id = -1;
            galloc->leaf_allocs[i].leaf.addr = WSP_GGML_BUFFER_ADDRESS_INVALID;
            galloc->leaf_allocs[i].leaf.size_max = 0;
        } else {
            galloc->leaf_allocs[i].leaf.buffer_id = hn->buffer_id;
            galloc->leaf_allocs[i].leaf.addr = hn->addr;
            galloc->leaf_allocs[i].leaf.size_max = wsp_ggml_backend_buft_get_alloc_size(galloc->bufts[hn->buffer_id], leaf);
        }
    }

    // reallocate buffers if needed
    for (int i = 0; i < galloc->n_buffers; i++) {
        // if the buffer type is used multiple times, we reuse the same buffer
        for (int j = 0; j < i; j++) {
            if (galloc->buf_tallocs[j] == galloc->buf_tallocs[i]) {
                galloc->buffers[i] = galloc->buffers[j];
                break;
            }
        }

        // even if there are no tensors allocated in this buffer, we still need to allocate it to initialize views
        bool realloc = galloc->buffers[i] == NULL;
        size_t new_size = 0;
        for (int c = 0; c < galloc->buf_tallocs[i]->n_chunks; c++) {
            size_t cur_chunk_size = galloc->buffers[i] ? wsp_ggml_vbuffer_chunk_size(galloc->buffers[i], c) : 0;
            size_t new_chunk_size = wsp_ggml_dyn_tallocr_max_size(galloc->buf_tallocs[i], c);
            new_size += new_chunk_size;
            if (new_chunk_size > cur_chunk_size) {
                realloc = true;
            }
        }
        if (realloc) {
#ifndef NDEBUG
            size_t cur_size = galloc->buffers[i] ? wsp_ggml_vbuffer_size(galloc->buffers[i]) : 0;
            WSP_GGML_LOG_DEBUG("%s: reallocating %s buffer from size %.02f MiB to %.02f MiB\n", __func__, wsp_ggml_backend_buft_name(galloc->bufts[i]), cur_size / 1024.0 / 1024.0, new_size / 1024.0 / 1024.0);
#endif

            wsp_ggml_vbuffer_free(galloc->buffers[i]);
            galloc->buffers[i] = wsp_ggml_vbuffer_alloc(galloc->bufts[i], galloc->buf_tallocs[i], WSP_GGML_BACKEND_BUFFER_USAGE_COMPUTE);
            if (galloc->buffers[i] == NULL) {
                WSP_GGML_LOG_ERROR("%s: failed to allocate %s buffer of size %zu\n", __func__, wsp_ggml_backend_buft_name(galloc->bufts[i]), new_size);
                return false;
            }
        }
    }

    return true;
}

bool wsp_ggml_gallocr_reserve(wsp_ggml_gallocr_t galloc, struct wsp_ggml_cgraph *graph) {
    return wsp_ggml_gallocr_reserve_n(galloc, graph, NULL, NULL);
}

static void wsp_ggml_gallocr_init_tensor(wsp_ggml_gallocr_t galloc, struct wsp_ggml_tensor * tensor, struct tensor_alloc * tensor_alloc) {
    int buffer_id = tensor_alloc->buffer_id;
    assert(tensor->data || tensor->view_src || wsp_ggml_backend_buft_get_alloc_size(galloc->bufts[buffer_id], tensor) <= tensor_alloc->size_max);

    if (tensor->view_src != NULL) {
        if (tensor->buffer == NULL) {
            assert(tensor_alloc->addr.offset == SIZE_MAX);
            if (tensor->view_src->buffer == NULL) {
                // this tensor was allocated without ggml-backend
                return;
            }
            wsp_ggml_backend_view_init(tensor);
        }
    } else {
        if (tensor->data == NULL) {
            assert(tensor_alloc->addr.offset != SIZE_MAX);
            assert(wsp_ggml_backend_buft_get_alloc_size(galloc->bufts[buffer_id], tensor) <= tensor_alloc->size_max);
            wsp_ggml_vbuffer_tensor_alloc(galloc->buffers[buffer_id], tensor, tensor_alloc->addr);
        } else {
            if (tensor->buffer == NULL) {
                // this tensor was allocated without ggml-backend
                return;
            }
        }
    }
}

static bool wsp_ggml_gallocr_node_needs_realloc(wsp_ggml_gallocr_t galloc, struct wsp_ggml_tensor * node, struct tensor_alloc * talloc) {
    size_t node_size = 0;
    if (!node->data && !node->view_src) {
        // If we previously had data but don't now then reallocate
        if (talloc->buffer_id < 0) {
            return false;
        }
        node_size = wsp_ggml_backend_buft_get_alloc_size(galloc->bufts[talloc->buffer_id], node);
    }
    return talloc->size_max >= node_size;
}

static bool wsp_ggml_gallocr_needs_realloc(wsp_ggml_gallocr_t galloc, struct wsp_ggml_cgraph * graph) {
    if (galloc->n_nodes != graph->n_nodes) {
#ifndef NDEBUG
        WSP_GGML_LOG_DEBUG("%s: graph has different number of nodes\n", __func__);
#endif
        return true;
    }

    if (galloc->n_leafs != graph->n_leafs) {
#ifndef NDEBUG
        WSP_GGML_LOG_DEBUG("%s: graph has different number of leafs\n", __func__);
#endif
        return true;
    }

    for (int i = 0; i < graph->n_nodes; i++) {
        struct wsp_ggml_tensor * node = graph->nodes[i];
        struct node_alloc * node_alloc = &galloc->node_allocs[i];

        if (!wsp_ggml_gallocr_node_needs_realloc(galloc, node, &node_alloc->dst)) {
#ifndef NDEBUG
            WSP_GGML_LOG_DEBUG("%s: node %s is not valid\n", __func__, node->name);
#endif
            return true;
        }

        for (int j = 0; j < WSP_GGML_MAX_SRC; j++) {
            struct wsp_ggml_tensor * src = node->src[j];
            if (src == NULL) {
                continue;
            }
            if (!wsp_ggml_gallocr_node_needs_realloc(galloc, src, &node_alloc->src[j])) {
#ifndef NDEBUG
                WSP_GGML_LOG_DEBUG("%s: src %d (%s) of node %s is not valid\n", __func__, j, src->name, node->name);
#endif
                return true;
            }
        }
    }

    return false;
}

bool wsp_ggml_gallocr_alloc_graph(wsp_ggml_gallocr_t galloc, struct wsp_ggml_cgraph * graph) {
    if (wsp_ggml_gallocr_needs_realloc(galloc, graph)) {
        if (galloc->n_buffers == 1) {
#ifndef NDEBUG
            WSP_GGML_LOG_DEBUG("%s: reallocating buffers automatically\n", __func__);
#endif
            if (!wsp_ggml_gallocr_reserve(galloc, graph)) {
                return false;
            }
        } else {
#ifndef NDEBUG
            WSP_GGML_LOG_DEBUG("%s: cannot reallocate multi buffer graph automatically, call reserve\n", __func__);
#endif
            return false;
        }
    }

    // reset buffers
    for (int i = 0; i < galloc->n_buffers; i++) {
        if (galloc->buffers[i] != NULL) {
            wsp_ggml_vbuffer_reset(galloc->buffers[i]);
        }
    }

    // allocate the graph tensors from the previous assignments
    // leafs
    for (int i = 0; i < graph->n_leafs; i++) {
        struct wsp_ggml_tensor * leaf = graph->leafs[i];
        struct leaf_alloc * leaf_alloc = &galloc->leaf_allocs[i];
        wsp_ggml_gallocr_init_tensor(galloc, leaf, &leaf_alloc->leaf);
    }
    // nodes
    for (int i = 0; i < graph->n_nodes; i++) {
        struct wsp_ggml_tensor * node = graph->nodes[i];
        struct node_alloc * node_alloc = &galloc->node_allocs[i];
        for (int j = 0; j < WSP_GGML_MAX_SRC; j++) {
            struct wsp_ggml_tensor * src = node->src[j];
            if (src == NULL) {
                continue;
            }
            wsp_ggml_gallocr_init_tensor(galloc, src, &node_alloc->src[j]);
        }
        wsp_ggml_gallocr_init_tensor(galloc, node, &node_alloc->dst);
    }

    return true;
}

size_t wsp_ggml_gallocr_get_buffer_size(wsp_ggml_gallocr_t galloc, int buffer_id) {
    WSP_GGML_ASSERT(buffer_id >= 0 && buffer_id < galloc->n_buffers);

    if (galloc->buffers[buffer_id] == NULL) {
        return 0;
    }

    for (int i = 0; i < buffer_id; i++) {
        if (galloc->buffers[i] == galloc->buffers[buffer_id]) {
            // this buffer is the same as a previous one due to the same buffer type being used multiple times
            // only return the buffer size the first time it appears to avoid double counting
            return 0;
        }
    }

    return wsp_ggml_vbuffer_size(galloc->buffers[buffer_id]);
}

// utils

static void free_buffers(wsp_ggml_backend_buffer_t ** buffers, const size_t * n_buffers) {
    for (size_t i = 0; i < *n_buffers; i++) {
        wsp_ggml_backend_buffer_free((*buffers)[i]);
    }
    free(*buffers);
}

static bool alloc_tensor_range(struct wsp_ggml_context * ctx,
        struct wsp_ggml_tensor * first, struct wsp_ggml_tensor * last,
        wsp_ggml_backend_buffer_type_t buft, size_t size,
        wsp_ggml_backend_buffer_t ** buffers, size_t * n_buffers) {

    wsp_ggml_backend_buffer_t buffer = wsp_ggml_backend_buft_alloc_buffer(buft, size);
    if (buffer == NULL) {
        WSP_GGML_LOG_ERROR("%s: failed to allocate %s buffer of size %zu\n", __func__, wsp_ggml_backend_buft_name(buft), size);
        free_buffers(buffers, n_buffers);
        return false;
    }

    *buffers = realloc(*buffers, sizeof(wsp_ggml_backend_buffer_t) * (*n_buffers + 1));
    (*buffers)[(*n_buffers)++] = buffer;

    struct wsp_ggml_tallocr tallocr = wsp_ggml_tallocr_new(buffer);

    for (struct wsp_ggml_tensor * t = first; t != last; t = wsp_ggml_get_next_tensor(ctx, t)) {
        enum wsp_ggml_status status = WSP_GGML_STATUS_SUCCESS;
        if (t->data == NULL) {
            if (t->view_src == NULL) {
                status = wsp_ggml_tallocr_alloc(&tallocr, t);
            } else if (t->buffer == NULL) {
                status = wsp_ggml_backend_view_init(t);
            }
        } else {
            if (t->view_src != NULL && t->buffer == NULL) {
                // view of a pre-allocated tensor
                status = wsp_ggml_backend_view_init(t);
            }
        }
        if (status != WSP_GGML_STATUS_SUCCESS) {
            WSP_GGML_LOG_ERROR("%s: failed to initialize tensor %s\n", __func__, t->name);
            free_buffers(buffers, n_buffers);
            return false;
        }
    }

    return true;
}

wsp_ggml_backend_buffer_t wsp_ggml_backend_alloc_ctx_tensors_from_buft(struct wsp_ggml_context * ctx, wsp_ggml_backend_buffer_type_t buft) {
    WSP_GGML_ASSERT(wsp_ggml_get_no_alloc(ctx) == true);

    size_t alignment = wsp_ggml_backend_buft_get_alignment(buft);
    size_t max_size = wsp_ggml_backend_buft_get_max_size(buft);

    wsp_ggml_backend_buffer_t * buffers = NULL;
    size_t n_buffers = 0;

    size_t cur_buf_size = 0;
    struct wsp_ggml_tensor * first = wsp_ggml_get_first_tensor(ctx);
    for (struct wsp_ggml_tensor * t = first; t != NULL; t = wsp_ggml_get_next_tensor(ctx, t)) {
        size_t this_size = 0;
        if (t->data == NULL && t->view_src == NULL) {
            this_size = WSP_GGML_PAD(wsp_ggml_backend_buft_get_alloc_size(buft, t), alignment);
        }

        if (cur_buf_size > 0 && (cur_buf_size + this_size) > max_size) {
            // allocate tensors in the current buffer
            if (!alloc_tensor_range(ctx, first, t, buft, cur_buf_size, &buffers, &n_buffers)) {
                return NULL;
            }
            first = t;
            cur_buf_size = this_size;
        } else {
            cur_buf_size += this_size;
        }
    }

    // allocate remaining tensors
    if (cur_buf_size > 0) {
        if (!alloc_tensor_range(ctx, first, NULL, buft, cur_buf_size, &buffers, &n_buffers)) {
            return NULL;
        }
    }

    if (n_buffers == 0) {
#ifndef NDEBUG
        WSP_GGML_LOG_DEBUG("%s: all tensors in the context are already allocated\n", __func__);
#endif
        return NULL;
    }

    wsp_ggml_backend_buffer_t buffer;
    if (n_buffers == 1) {
        buffer = buffers[0];
    } else {
        buffer = wsp_ggml_backend_multi_buffer_alloc_buffer(buffers, n_buffers);
    }
    free(buffers);
    return buffer;
}

wsp_ggml_backend_buffer_t wsp_ggml_backend_alloc_ctx_tensors(struct wsp_ggml_context * ctx, wsp_ggml_backend_t backend) {
    return wsp_ggml_backend_alloc_ctx_tensors_from_buft(ctx, wsp_ggml_backend_get_default_buffer_type(backend));
}
