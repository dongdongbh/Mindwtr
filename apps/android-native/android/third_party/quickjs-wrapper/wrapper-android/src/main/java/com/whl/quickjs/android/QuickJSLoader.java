package com.whl.quickjs.android;

import android.util.Log;

import com.whl.quickjs.wrapper.QuickJSContext;

/**
 * Created by Harlon Wang on 2022/8/12.
 */
public final class QuickJSLoader {

    public static void init() {
        System.loadLibrary("quickjs-android-wrapper");
    }

    static final class LogcatConsole implements QuickJSContext.Console {

        private final String tag;

        public LogcatConsole(String tag) {
            this.tag = tag;
        }

        @Override
        public void log(String info) {
            Log.d(tag, info);
        }

        @Override
        public void info(String info) {
            Log.i(tag, info);
        }

        @Override
        public void warn(String info) {
            Log.w(tag, info);
        }

        @Override
        public void error(String info) {
            Log.e(tag, info);
        }
    }

    /**
     * See {@link QuickJSContext#setConsole(QuickJSContext.Console)}
     */
    @Deprecated
    public static void initConsoleLog(QuickJSContext context) {
        initConsoleLog(context, new LogcatConsole("quickjs"));
    }

    /**
     * See {@link QuickJSContext#setConsole(QuickJSContext.Console)}
     */
    @Deprecated
    public static void initConsoleLog(QuickJSContext context, String tag) {
        initConsoleLog(context, new LogcatConsole(tag));
    }

    /**
     * See {@link QuickJSContext#setConsole(QuickJSContext.Console)}
     */
    @Deprecated
    public static void initConsoleLog(QuickJSContext context, QuickJSContext.Console console) {
        context.setConsole(console);
    }

    /**
     * Start threads to show stdout and stderr in logcat.
     * @param tag Android Tag
     */
    public native static void startRedirectingStdoutStderr(String tag);

}
