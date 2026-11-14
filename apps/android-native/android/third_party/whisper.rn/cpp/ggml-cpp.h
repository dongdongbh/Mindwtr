#pragma once

#ifndef __cplusplus
#error "This header is for C++ only"
#endif

#include "ggml.h"
#include "ggml-alloc.h"
#include "ggml-backend.h"
#include "gguf.h"
#include <memory>

// Smart pointers for ggml types

// ggml

struct wsp_ggml_context_deleter { void operator()(wsp_ggml_context * ctx) { wsp_ggml_free(ctx); } };
struct wsp_gguf_context_deleter { void operator()(wsp_gguf_context * ctx) { wsp_gguf_free(ctx); } };

typedef std::unique_ptr<wsp_ggml_context, wsp_ggml_context_deleter> wsp_ggml_context_ptr;
typedef std::unique_ptr<wsp_gguf_context, wsp_gguf_context_deleter> wsp_gguf_context_ptr;

// ggml-alloc

struct wsp_ggml_gallocr_deleter { void operator()(wsp_ggml_gallocr_t galloc) { wsp_ggml_gallocr_free(galloc); } };

typedef std::unique_ptr<wsp_ggml_gallocr, wsp_ggml_gallocr_deleter> wsp_ggml_gallocr_ptr;

// ggml-backend

struct wsp_ggml_backend_deleter        { void operator()(wsp_ggml_backend_t backend)       { wsp_ggml_backend_free(backend); } };
struct wsp_ggml_backend_buffer_deleter { void operator()(wsp_ggml_backend_buffer_t buffer) { wsp_ggml_backend_buffer_free(buffer); } };
struct wsp_ggml_backend_event_deleter  { void operator()(wsp_ggml_backend_event_t event)   { wsp_ggml_backend_event_free(event); } };
struct wsp_ggml_backend_sched_deleter  { void operator()(wsp_ggml_backend_sched_t sched)   { wsp_ggml_backend_sched_free(sched); } };

typedef std::unique_ptr<wsp_ggml_backend,        wsp_ggml_backend_deleter>        wsp_ggml_backend_ptr;
typedef std::unique_ptr<wsp_ggml_backend_buffer, wsp_ggml_backend_buffer_deleter> wsp_ggml_backend_buffer_ptr;
typedef std::unique_ptr<wsp_ggml_backend_event,  wsp_ggml_backend_event_deleter>  wsp_ggml_backend_event_ptr;
typedef std::unique_ptr<wsp_ggml_backend_sched,  wsp_ggml_backend_sched_deleter>  wsp_ggml_backend_sched_ptr;
