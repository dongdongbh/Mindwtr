#include <jni.h>
#include <string>
#include "quickjs_wrapper.h"
#include <vector>

extern "C"
JNIEXPORT void JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_destroyContext(JNIEnv *env, jobject thiz,
                                                           jlong context) {
    delete reinterpret_cast<QuickJSWrapper*>(context);
}

extern "C"
JNIEXPORT jobject JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_evaluate(JNIEnv *env, jobject thiz, jlong context, jstring script,
                                                     jstring file_name) {
    if (script == nullptr) {
        env->ThrowNew(env->FindClass("java/lang/NullPointerException"), "Script cannot be null");
        return nullptr;
    }

    if (file_name == nullptr) {
        env->ThrowNew(env->FindClass("java/lang/NullPointerException"), "File name cannot be null");
        return nullptr;
    }

    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    return wrapper->evaluate(env, thiz, script, file_name);
}

extern "C"
JNIEXPORT jobject JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_getGlobalObject(JNIEnv *env, jobject thiz,
                                                            jlong context) {
    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    return wrapper->getGlobalObject(env, thiz);
}

extern "C"
JNIEXPORT jobject JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_getProperty(JNIEnv *env, jobject thiz, jlong context, jlong value,
                                                 jstring name) {
    if (name == nullptr) {
        env->ThrowNew(env->FindClass("java/lang/NullPointerException"), "Property Name cannot be null");
        return nullptr;
    }

    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    return wrapper->getProperty(env, thiz, value, name);
}

extern "C"
JNIEXPORT jobject JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_call(JNIEnv *env, jobject thiz, jlong context,
                                                 jlong func, jlong this_obj, jint this_obj_tag, jobjectArray args) {
    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    return wrapper->call(env, thiz, func, this_obj, this_obj_tag, args);
}

extern "C"
JNIEXPORT jstring JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_stringify(JNIEnv *env, jobject thiz, jlong context,
                                               jlong value) {
    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    return wrapper->jsonStringify(env, value);
}extern "C"
JNIEXPORT jint JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_length(JNIEnv *env, jobject thiz, jlong context,
                                               jlong value) {
    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    return wrapper->length(env, value);
}extern "C"
JNIEXPORT jobject JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_get(JNIEnv *env, jobject thiz, jlong context, jlong value,
                                         jint index) {
    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    return wrapper->get(env, thiz, value, index);
}extern "C"
JNIEXPORT jlong JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_createContext(JNIEnv *env, jobject thiz, jlong runtime) {
    auto *wrapper = new(std::nothrow) QuickJSWrapper(env, thiz, reinterpret_cast<JSRuntime *>(runtime));
    if (!wrapper || !wrapper->context || !wrapper->runtime) {
        delete wrapper;
        wrapper = nullptr;
    }

    return reinterpret_cast<jlong>(wrapper);
}extern "C"
JNIEXPORT void JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_setProperty(JNIEnv *env, jobject thiz, jlong context,
                                                        jlong this_obj, jstring name,
                                                        jobject value) {
    if (name == nullptr) {
        env->ThrowNew(env->FindClass("java/lang/NullPointerException"), "Property Name cannot be null");
        return;
    }

    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    wrapper->setProperty(env, thiz, this_obj, name, value);
}extern "C"
JNIEXPORT void JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_freeValue(JNIEnv *env, jobject thiz, jlong context,
                                                      jlong value) {
    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    wrapper->freeValue(value);
}extern "C"
JNIEXPORT void JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_dupValue(JNIEnv *env, jobject thiz, jlong context,
                                                     jlong value) {
    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    wrapper->dupValue(value);
}extern "C"
JNIEXPORT void JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_freeDupValue(JNIEnv *env, jobject thiz, jlong context,
                                                         jlong value) {
    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    wrapper->freeDupValue(value);
}extern "C"
JNIEXPORT jobject JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_parseJSON(JNIEnv *env, jobject thiz, jlong context,
                                                      jstring json) {
    if (json == nullptr) {
        env->ThrowNew(env->FindClass("java/lang/NullPointerException"), "JSON cannot be null");
        return nullptr;
    }

    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    return wrapper->parseJSON(env, thiz, json);
}extern "C"
JNIEXPORT jbyteArray JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_compile(JNIEnv *env, jobject thiz, jlong context,
                                                    jstring source_code, jstring file_name, jboolean isModule) {
    if (source_code == nullptr) {
        env->ThrowNew(env->FindClass("java/lang/NullPointerException"), "Source code cannot be null");
        return nullptr;
    }

    if (file_name == nullptr) {
        env->ThrowNew(env->FindClass("java/lang/NullPointerException"), "File name cannot be null");
        return nullptr;
    }

    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    return wrapper->compile(env, source_code, file_name, isModule);
}extern "C"
JNIEXPORT jobject JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_execute(JNIEnv *env, jobject thiz, jlong context,
                                                    jbyteArray bytecode) {
    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    return wrapper->execute(env, thiz, bytecode);
}extern "C"
JNIEXPORT jobject JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_evaluateModule(JNIEnv *env, jobject thiz, jlong context,
                                                           jstring script, jstring file_name) {
    if (script == nullptr) {
        env->ThrowNew(env->FindClass("java/lang/NullPointerException"), "Script cannot be null");
        return nullptr;
    }

    if (file_name == nullptr) {
        env->ThrowNew(env->FindClass("java/lang/NullPointerException"), "File name cannot be null");
        return nullptr;
    }

    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    return wrapper->evaluateModule(env, thiz, script, file_name);
}extern "C"
JNIEXPORT void JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_set(JNIEnv *env, jobject thiz, jlong context,
                                                jlong this_obj, jobject value, jint index) {
    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    wrapper->set(env, thiz, this_obj, value, index);
}
extern "C"
JNIEXPORT void JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_setMaxStackSize(JNIEnv *env, jclass thiz,
                                                            jlong runtime, jint size) {
    auto *rt = reinterpret_cast<JSRuntime*>(runtime);
    JS_SetMaxStackSize(rt, size);
}
extern "C"
JNIEXPORT jboolean JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_isLiveObject(JNIEnv *env, jclass thiz, jlong runtime,
                                                         jlong value) {
    auto *rt = reinterpret_cast<JSRuntime*>(runtime);
    JSValue jsObj = JS_MKPTR(JS_TAG_OBJECT, reinterpret_cast<void *>(value));
    if (JS_IsLiveObject(rt, jsObj)) {
        return JNI_TRUE;
    }

    return JNI_FALSE;
}
extern "C"
JNIEXPORT void JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_runGC(JNIEnv *env, jclass thiz, jlong runtime) {
    auto *rt = reinterpret_cast<JSRuntime*>(runtime);
    JS_RunGC(rt);
}
extern "C"
JNIEXPORT jlong JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_createRuntime(JNIEnv *env, jclass clazz) {
    auto *rt = JS_NewRuntime();
    JS_SetStripInfo(rt, JS_STRIP_SOURCE);
    return reinterpret_cast<jlong>(rt);
}
extern "C"
JNIEXPORT void JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_setMemoryLimit(JNIEnv *env, jclass clazz, jlong runtime,
                                                           jint size) {
    auto *rt = reinterpret_cast<JSRuntime*>(runtime);
    JS_SetMemoryLimit(rt, size);
}
extern "C"
JNIEXPORT void JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_dumpMemoryUsage(JNIEnv *env, jclass clazz,
                                                            jlong runtime, jstring file_name) {
    auto *rt = reinterpret_cast<JSRuntime*>(runtime);

    if (file_name == nullptr) {
        JSMemoryUsage stats;
        JS_ComputeMemoryUsage(rt, &stats);
        JS_DumpMemoryUsage(stdout, &stats, rt);
    } else {
        const char *path = env->GetStringUTFChars(file_name, JNI_FALSE);
        auto file = fopen(path, "w");
        env->ReleaseStringUTFChars(file_name, path);
        if (!file) {
            env->ThrowNew(env->FindClass("java/lang/NullPointerException"), "File cannot be null");
            return;
        }

        JSMemoryUsage stats;
        JS_ComputeMemoryUsage(rt, &stats);
        JS_DumpMemoryUsage(file, &stats, rt);

        fclose(file);
    }
}
extern "C"
JNIEXPORT jobject JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_getOwnPropertyNames(JNIEnv *env, jobject thiz,
                                                                jlong context, jlong obj_value) {
    auto wrapper = reinterpret_cast<QuickJSWrapper*>(context);
    return wrapper->getOwnPropertyNames(env, thiz, obj_value);
}
extern "C"
JNIEXPORT jlong JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_getMemoryUsedSize(JNIEnv *env, jobject thiz,
                                                              jlong runtime) {
    auto *rt = reinterpret_cast<JSRuntime*>(runtime);
    JSMemoryUsage usage;
    JS_ComputeMemoryUsage(rt, &usage);
    return (jlong)usage.memory_used_size;
}
extern "C"
JNIEXPORT void JNICALL
Java_com_whl_quickjs_wrapper_QuickJSContext_setGCThreshold(JNIEnv *env, jobject thiz, jlong runtime,
                                                           jint size) {
    auto *rt = reinterpret_cast<JSRuntime*>(runtime);
    // use -1 to disable automatic GC
    if (size < 0) {
        size = -1;
    }
    JS_SetGCThreshold(rt, size);
}