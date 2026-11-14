#include <jni.h>

#include <string>
#include <vector>

#include "whisper.h"

namespace {

void silent(enum wsp_ggml_log_level, const char *, void *) {}

whisper_context *contextOf(jlong handle) { return reinterpret_cast<whisper_context *>(handle); }

}

extern "C" JNIEXPORT jlong JNICALL
Java_tech_dongdongbh_mindwtr_whisper_WhisperNative_open(JNIEnv *env, jclass, jstring path) {
    const char *chars = env->GetStringUTFChars(path, nullptr);
    if (chars == nullptr) return 0;
    const std::string model(chars);
    env->ReleaseStringUTFChars(path, chars);
    whisper_log_set(silent, nullptr);
    whisper_context_params params = whisper_context_default_params();
    params.use_gpu = false;
    params.flash_attn = false;
    return reinterpret_cast<jlong>(whisper_init_from_file_with_params(model.c_str(), params));
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_tech_dongdongbh_mindwtr_whisper_WhisperNative_transcribe(JNIEnv *env, jclass, jlong handle, jfloatArray samples, jstring language,
                                                              jint threads) {
    const jsize count = env->GetArrayLength(samples);
    std::vector<float> pcm(static_cast<size_t>(count));
    env->GetFloatArrayRegion(samples, 0, count, pcm.data());
    const char *chars = env->GetStringUTFChars(language, nullptr);
    if (chars == nullptr) return nullptr;
    const std::string spoken(chars);
    env->ReleaseStringUTFChars(language, chars);

    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.n_threads = threads;
    params.translate = false;
    params.no_context = true;
    params.single_segment = false;
    params.print_special = false;
    params.print_progress = false;
    params.print_realtime = false;
    params.print_timestamps = false;
    params.language = spoken.c_str();
    if (whisper_full(contextOf(handle), params, pcm.data(), count) != 0) return nullptr;

    std::string text;
    const int segments = whisper_full_n_segments(contextOf(handle));
    for (int index = 0; index < segments; ++index) {
        const char *segment = whisper_full_get_segment_text(contextOf(handle), index);
        if (segment != nullptr) text += segment;
    }
    jbyteArray bytes = env->NewByteArray(static_cast<jsize>(text.size()));
    if (bytes != nullptr) env->SetByteArrayRegion(bytes, 0, static_cast<jsize>(text.size()), reinterpret_cast<const jbyte *>(text.data()));
    return bytes;
}

extern "C" JNIEXPORT void JNICALL
Java_tech_dongdongbh_mindwtr_whisper_WhisperNative_close(JNIEnv *, jclass, jlong handle) {
    whisper_free(contextOf(handle));
}
