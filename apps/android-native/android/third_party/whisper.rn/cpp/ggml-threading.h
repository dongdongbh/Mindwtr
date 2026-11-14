#pragma once

#include "ggml.h"

#ifdef __cplusplus
extern "C" {
#endif

WSP_GGML_API void wsp_ggml_critical_section_start(void);
WSP_GGML_API void wsp_ggml_critical_section_end(void);

#ifdef __cplusplus
}
#endif
