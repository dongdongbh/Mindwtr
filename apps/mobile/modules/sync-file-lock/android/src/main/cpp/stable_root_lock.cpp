#include <cerrno>
#include <jni.h>
#include <sys/file.h>

extern "C" JNIEXPORT jint JNICALL
Java_tech_dongdongbh_mindwtr_syncfilelock_StableRootLockNative_tryLock(
    JNIEnv *, jobject, jint fd) {
  if (fd < 0) {
    return EBADF;
  }
  if (flock(fd, LOCK_EX | LOCK_NB) == 0) {
    return 0;
  }
  return errno;
}

extern "C" JNIEXPORT jint JNICALL
Java_tech_dongdongbh_mindwtr_syncfilelock_StableRootLockNative_unlock(
    JNIEnv *, jobject, jint fd) {
  if (fd < 0) {
    return EBADF;
  }
  if (flock(fd, LOCK_UN) == 0) {
    return 0;
  }
  return errno;
}
