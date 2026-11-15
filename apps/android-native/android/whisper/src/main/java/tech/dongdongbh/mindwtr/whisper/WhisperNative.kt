package tech.dongdongbh.mindwtr.whisper

import android.os.Build
import java.io.File
import java.io.IOException

object WhisperNative {
    private val loaded: Boolean by lazy {
        runCatching { System.loadLibrary(library(Build.SUPPORTED_ABIS.firstOrNull(), cpuFeatures())) }.isSuccess
    }

    fun library(abi: String?, features: String): String =
        if (abi == "arm64-v8a" && features.split(Regex("\\s+")).any { it == "fphp" || it == "fp16" }) "mindwtr_whisper_fp16" else "mindwtr_whisper"

    private fun cpuFeatures(): String =
        runCatching { File("/proc/cpuinfo").useLines { lines -> lines.firstOrNull { it.startsWith("Features") }.orEmpty() } }.getOrDefault("")

    fun transcribe(model: File, samples: FloatArray, language: String, threads: Int): String {
        if (!loaded) throw IOException("E_WHISPER_UNAVAILABLE")
        val context = open(model.path)
        if (context == 0L) throw IOException("E_WHISPER_MODEL_INVALID")
        try {
            val bytes = transcribe(context, samples, language, threads) ?: throw IOException("E_WHISPER_FAILED")
            return String(bytes, Charsets.UTF_8)
        } finally {
            close(context)
        }
    }

    @JvmStatic private external fun open(path: String): Long
    @JvmStatic private external fun transcribe(context: Long, samples: FloatArray, language: String, threads: Int): ByteArray?
    @JvmStatic private external fun close(context: Long)
}
