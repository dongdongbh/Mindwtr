package tech.dongdongbh.mindwtr.startupmetrics

import androidx.annotation.Keep


@Keep
internal object CaptureSampling {
  init { System.loadLibrary("mindwtr_capture_profiler") }
  external fun enable()
  external fun disable()
  external fun dump(filename: String)
}
