package com.whl.quickjs.wrapper;

public interface JSFunction extends JSObject {
    Object call(Object... args);
    void callVoid(Object... args);
}
