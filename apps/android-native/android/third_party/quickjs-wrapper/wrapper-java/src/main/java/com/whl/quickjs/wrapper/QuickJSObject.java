package com.whl.quickjs.wrapper;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;

/**
 * Created by Harlon Wang on 2024/2/12.
 */
public class QuickJSObject implements JSObject {

    private final QuickJSContext context;
    private final long pointer;
    private int refCount;
    private Throwable stackTrace;

    public QuickJSObject(QuickJSContext context, long pointer) {
        this.context = context;
        this.pointer = pointer;
        refCount++;
    }

    @Override
    public long getPointer() {
        return pointer;
    }

    @Override
    public QuickJSContext getContext() {
        return context;
    }

    @Override
    public Object getProperty(String name) {
        checkRefCountIsZero();
        return context.getProperty(this, name);
    }

    @Override
    public String getStringProperty(String name) {
        return getString(name);
    }

    @Override
    public void setStackTrace(Throwable stackTrace) {
        this.stackTrace = stackTrace;
    }

    @Override
    public Throwable getStackTrace() {
        return stackTrace;
    }

    @Override
    public void setProperty(String name, String value) {
        setPropertyObject(name, value);
    }

    @Override
    public void setProperty(String name, int value) {
        setPropertyObject(name, value);
    }

    @Override
    public void setProperty(String name, long value) {
        setPropertyObject(name, value);
    }

    @Override
    public void setProperty(String name, JSObject value) {
        setPropertyObject(name, value);
    }

    @Override
    public void setProperty(String name, boolean value) {
        setPropertyObject(name, value);
    }

    @Override
    public void setProperty(String name, double value) {
        setPropertyObject(name, value);
    }

    @Override
    public void setProperty(String name, byte[] value) {
        setPropertyObject(name, value);
    }

    @Override
    public void setProperty(String name, JSCallFunction value) {
        setPropertyObject(name, value);
    }

    private void setPropertyObject(String name, Object o) {
        checkRefCountIsZero();
        context.setProperty(this, name, o);
    }

    @Override
    public void setProperty(String name, Class<?> clazz) {
        Object javaObj = null;
        try {
            javaObj = clazz.newInstance();
        } catch (IllegalAccessException e) {
            e.printStackTrace();
        } catch (InstantiationException e) {
            e.printStackTrace();
        }

        if (javaObj == null) {
            throw new NullPointerException("The JavaObj cannot be null. An error occurred in newInstance!");
        }

        JSObject jsObj = context.createNewJSObject();
        Method[] methods = clazz.getMethods();
        for (Method method : methods) {
            if (method.isAnnotationPresent(JSMethod.class)) {
                Object finalJavaObj = javaObj;
                jsObj.setProperty(method.getName(), args -> {
                    try {
                        return method.invoke(finalJavaObj, args);
                    } catch (IllegalAccessException e) {
                        e.printStackTrace();
                    } catch (InvocationTargetException e) {
                        e.printStackTrace();
                    }
                    return null;
                });
            }
        }

        setProperty(name, jsObj);
        jsObj.release();
    }

    @Override
    public String getString(String name) {
        Object value = getProperty(name);
        return value instanceof String ? (String) value : null;
    }

    @Override
    public Integer getIntProperty(String name) {
        return getInteger(name);
    }

    @Override
    public Integer getInteger(String name) {
        Object value = getProperty(name);
        return value instanceof Integer ? (Integer) value : null;
    }

    @Override
    public Boolean getBooleanProperty(String name) {
        return getBoolean(name);
    }

    @Override
    public Boolean getBoolean(String name) {
        Object value = getProperty(name);
        return value instanceof Boolean ? (Boolean) value : null;
    }

    @Override
    public Double getDoubleProperty(String name) {
        return getDouble(name);
    }

    @Override
    public Double getDouble(String name) {
        Object value = getProperty(name);
        return value instanceof Double ? (Double) value : null;
    }

    @Override
    public Long getLong(String name) {
        Object value = getProperty(name);
        return value instanceof Long ? (Long) value : null;
    }

    @Override
    public byte[] getBytes(String name) {
        Object value = getProperty(name);
        return value instanceof byte[] ? (byte[]) value : null;
    }

    @Override
    public JSObject getJSObjectProperty(String name) {
        return getJSObject(name);
    }

    @Override
    public JSObject getJSObject(String name) {
        Object value = getProperty(name);
        return value instanceof JSObject ? (JSObject) value : null;
    }

    @Override
    public JSFunction getJSFunctionProperty(String name) {
        return getJSFunction(name);
    }

    @Override
    public JSFunction getJSFunction(String name) {
        Object value = getProperty(name);
        return value instanceof JSFunction ? (JSFunction) value : null;
    }

    @Override
    public JSArray getJSArrayProperty(String name) {
        return getJSArray(name);
    }

    @Override
    public JSArray getJSArray(String name) {
        Object value = getProperty(name);
        return value instanceof JSArray ? (JSArray) value : null;
    }

    @Override
    public JSArray getOwnPropertyNames() {
        return getNames();
    }

    @Override
    public JSArray getNames() {
        checkRefCountIsZero();
        return (JSArray) context.getOwnPropertyNames(this);
    }

    @Override
    public void release() {
        if (isRefCountZero()) {
            return;
        }
        refCount--;
        context.freeValue(this);
    }

    @Override
    public void hold() {
        checkRefCountIsZero();
        refCount++;
        context.hold(this);
    }

    @Override
    public void decrementRefCount() {
        checkRefCountIsZero();
        refCount--;
    }

    @Override
    public HashMap<String, Object> toMap() {
        return toMap(null);
    }

    @Override
    public ArrayList<Object> toArray() {
        return toArray(null);
    }

    @Override
    public HashMap<String, Object> toMap(MapFilter filter) {
        return (HashMap<String, Object>) toMap(filter, null, HashMap::new);
    }

    @Override
    public Map<String, Object> toMap(MapFilter filter, Object extra, MapCreator mapCreator) {
        Map<String, Object> objectMap = mapCreator.get();
        HashMap<Long, Object> circulars = new HashMap<>();
        convertToMap(this, objectMap, circulars, filter, extra, mapCreator);
        circulars.clear();
        return objectMap;
    }

    @Override
    public ArrayList<Object> toArray(MapFilter filter, Object extra, MapCreator mapCreator) {
        throw new UnsupportedOperationException("Object types are not yet supported for conversion to array. You should use toMap.");
    }

    @Override
    public ArrayList<Object> toArray(MapFilter filter) {
        return toArray(filter, null, null);
    }

    protected void convertToMap(Object target, Object map, HashMap<Long, Object> circulars, MapFilter filter, Object extra, MapCreator mapCreator) {
        circulars.put(((JSObject) target).getPointer(), map);

        boolean isArray = target instanceof JSArray;
        JSArray array = isArray ? (JSArray) target : ((JSObject) target).getNames();
        int length = array.length();
        for (int i = 0; i < length; i++) {
            String key = null;
            Object value;
            if (isArray) {
                value = array.get(i);
            } else {
                key = (String) array.get(i);
                if (filter != null && filter.shouldSkipKey(key, pointer, extra)) {
                    continue;
                }
                value = ((JSObject) target).getProperty(key);
            }

            if (value instanceof JSObject) {
                long pointer = ((JSObject) value).getPointer();
                if (circulars.containsKey(pointer)) {
                    // Circular reference objects.
                    Object refValue = circulars.get(pointer);
                    if (map instanceof Map) {
                        ((Map<String, Object>) map).put(key, refValue);
                    } else if (map instanceof ArrayList){
                        ((ArrayList<Object>) map).add(refValue);
                    }
                    continue;
                }
            }

            if (value instanceof JSFunction) {
                // Unsupported type.
                ((JSFunction) value).release();
                continue;
            }

            if (value instanceof JSArray) {
                ArrayList<Object> list = new ArrayList<>(((JSArray) value).length());
                convertToMap(value, list, circulars, filter, extra, mapCreator);
                if (map instanceof Map) {
                    ((Map<String, Object>) map).put(key, list);
                } else if (map instanceof ArrayList){
                    ((ArrayList<Object>) map).add(list);
                }
                ((JSArray) value).release();
                continue;
            }

            if (value instanceof JSObject) {
                Map<String, Object> valueMap = mapCreator.get();
                convertToMap(value, valueMap, circulars, filter, extra, mapCreator);
                if (map instanceof Map) {
                    ((Map<String, Object>) map).put(key, valueMap);
                } else if (map instanceof ArrayList){
                    ((ArrayList<Object>) map).add(valueMap);
                }
                ((JSObject) value).release();
                continue;
            }

            // Primitive types.
            if (map instanceof Map) {
                ((Map<String, Object>) map).put(key, value);
            } else if (map instanceof ArrayList){
                ((ArrayList<Object>) map).add(value);
            }
        }
        if (!isArray) {
            array.release();
        }
    }

    public int getRefCount() {
        return refCount;
    }

    @Override
    public String stringify() {
        checkRefCountIsZero();
        return context.stringify(this);
    }

    @Override
    public boolean isAlive() {
        return !isRefCountZero();
    }

    final void checkRefCountIsZero() {
        if (isRefCountZero()) {
            throw new QuickJSException("The call threw an exception, the reference count of the current object has already reached zero.");
        }
    }

    public boolean isRefCountZero() {
        return refCount == 0;
    }

    @Override
    public String toString() {
        checkRefCountIsZero();
        JSFunction toString = getJSFunction("toString");
        String ret = (String) toString.call();
        toString.release();
        return ret;
    }

    @Override
    public int hashCode() {
        return Arrays.hashCode(new long[]{pointer});
    }

}
