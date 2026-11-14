package com.whl.quickjs.wrapper;

/**
 * Created by Harlon Wang on 2024/9/27.
 */
public interface MapFilter {

    /**
     * toMap 转换期间是否需要过滤指定 key
     * @param key 需要过滤的 key
     * @param pointer 当前 key 所属对象的指针地址
     * @param extra 扩展参数，如果你需要一些额外信息，可通过 toMap(..., extra) 传递该参数
     * @return 是否需要过滤该 key
     */
    boolean shouldSkipKey(String key, long pointer, Object extra);

}
