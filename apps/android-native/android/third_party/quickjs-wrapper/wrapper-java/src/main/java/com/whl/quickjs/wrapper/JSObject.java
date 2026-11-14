package com.whl.quickjs.wrapper;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;

public interface JSObject {

    void setStackTrace(Throwable trace);
    Throwable getStackTrace();

    void setProperty(String name, String value);
    void setProperty(String name, int value);
    void setProperty(String name, long value);
    void setProperty(String name, JSObject value);
    void setProperty(String name, boolean value);
    void setProperty(String name, double value);
    void setProperty(String name, byte[] value);
    void setProperty(String name, JSCallFunction value);
    void setProperty(String name, Class<?> clazz);
    long getPointer();
    QuickJSContext getContext();
    Object getProperty(String name);
    @Deprecated
    String getStringProperty(String name);
    String getString(String name);
    @Deprecated
    Integer getIntProperty(String name);
    Integer getInteger(String name);
    @Deprecated
    Boolean getBooleanProperty(String name);
    Boolean getBoolean(String name);
    @Deprecated
    Double getDoubleProperty(String name);
    Double getDouble(String name);
    Long getLong(String name);
    byte[] getBytes(String name);
    @Deprecated
    JSObject getJSObjectProperty(String name);
    JSObject getJSObject(String name);
    @Deprecated
    JSFunction getJSFunctionProperty(String name);
    JSFunction getJSFunction(String name);
    @Deprecated
    JSArray getJSArrayProperty(String name);
    JSArray getJSArray(String name);
    @Deprecated
    JSArray getOwnPropertyNames();
    JSArray getNames();
    String stringify();
    boolean isAlive();
    void release();
    void hold();
    int getRefCount();
    boolean isRefCountZero();
    /**
     * 引用计数减一，目前仅将对象返回到 JavaScript 中的场景中使用。
     */
    void decrementRefCount();

    HashMap<String, Object> toMap();

    ArrayList<Object> toArray();

    HashMap<String, Object> toMap(MapFilter filter);
    ArrayList<Object> toArray(MapFilter filter);
    Map<String, Object> toMap(MapFilter filter, Object extra, MapCreator mapCreator);
    ArrayList<Object> toArray(MapFilter filter, Object extra, MapCreator mapCreator);
}
