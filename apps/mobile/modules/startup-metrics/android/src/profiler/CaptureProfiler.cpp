#include <jni.h>
#include <hermes/hermes.h>


static auto* profiler() {
  return facebook::jsi::castInterface<facebook::hermes::IHermesRootAPI>(
      facebook::hermes::makeHermesRootAPI());
}

extern "C" JNIEXPORT void JNICALL
Java_tech_dongdongbh_mindwtr_startupmetrics_CaptureSampling_enable(JNIEnv* env, jobject) {
  try { profiler()->enableSamplingProfiler(1000); }
  catch (...) { env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "Profiler unavailable"); }
}

extern "C" JNIEXPORT void JNICALL
Java_tech_dongdongbh_mindwtr_startupmetrics_CaptureSampling_disable(JNIEnv* env, jobject) {
  try { profiler()->disableSamplingProfiler(); }
  catch (...) { env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "Profiler unavailable"); }
}

extern "C" JNIEXPORT void JNICALL
Java_tech_dongdongbh_mindwtr_startupmetrics_CaptureSampling_dump(JNIEnv* env, jobject, jstring filename) {
  const char* path = env->GetStringUTFChars(filename, nullptr);
  if (!path) return;
  try {
    profiler()->dumpSampledTraceToFile(path);
  } catch (...) {
    env->ReleaseStringUTFChars(filename, path);
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), "Profile dump failed");
    return;
  }
  env->ReleaseStringUTFChars(filename, path);
}
