#include "ggml-threading.h"
#include <mutex>

std::mutex wsp_ggml_critical_section_mutex;

void wsp_ggml_critical_section_start() {
    wsp_ggml_critical_section_mutex.lock();
}

void wsp_ggml_critical_section_end(void) {
    wsp_ggml_critical_section_mutex.unlock();
}
