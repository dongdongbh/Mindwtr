package com.whl.quickjs.wrapper;

import java.util.ArrayList;
import java.util.HashMap;

/**
 * Created by Harlon Wang on 2024/2/12.
 */
public class QuickJSFunction extends QuickJSObject implements JSFunction {

    /**
     * 函数执行状态
     */
    enum Status {
        NOT_CALLED,
        CALLING,
        CALLED
    }
    private int stashTimes = 0;
    private Status currentStatus = Status.NOT_CALLED;

    private final long thisPointer;
    private final int thisPointerTag;

    public QuickJSFunction(QuickJSContext context, long pointer, long thisPointer, int thisPointerTag) {
        super(context, pointer);
        this.thisPointer = thisPointer;
        this.thisPointerTag = thisPointerTag;
    }

    @Override
    public void release() {
        // call 函数未执行完，触发了 release 操作，会导致 quickjs 野指针异常，
        // 这里暂存一下，待函数执行完，才执行 release。
        if (currentStatus == Status.CALLING) {
            stashTimes++;
            return;
        }
        super.release();
    }

    @Override
    public Object call(Object... args) {
        checkRefCountIsZero();

        currentStatus = Status.CALLING;
        Object ret;
        try {
            ret = getContext().call(this, thisPointer, thisPointerTag, args);
        } finally {
            // call 可能会抛出异常，需要保障以下代码被执行，不然因为状态不对，导致无法正常 release。
            currentStatus = Status.CALLED;

            if (stashTimes > 0) {
                // 如果有暂存，这里需要恢复下 release 操作
                for (int i = 0; i < stashTimes; i++) {
                    release();
                }
                stashTimes = 0;
            }
        }

        return ret;
    }

    @Override
    public void callVoid(Object... args) {
        Object ret = call(args);
        if (ret instanceof JSObject) {
            ((JSObject) ret).release();
        }
    }

    @Override
    public HashMap<String, Object> toMap() {
        throw new UnsupportedOperationException("JSFunction types do not support conversion to map or array.");
    }

    @Override
    public ArrayList<Object> toArray() {
        throw new UnsupportedOperationException("JSFunction types do not support conversion to map or array.");
    }
}