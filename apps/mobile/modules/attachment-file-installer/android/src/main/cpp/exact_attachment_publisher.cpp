#include <jni.h>

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <linux/fs.h>
#include <string>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

namespace {

void throw_io_exception(JNIEnv* env, const std::string& message) {
  jclass exception_class = env->FindClass("java/io/IOException");
  if (exception_class != nullptr) {
    env->ThrowNew(exception_class, message.c_str());
  }
}

class ScopedUtfChars {
 public:
  ScopedUtfChars(JNIEnv* env, jstring value)
      : env_(env), value_(value), chars_(env->GetStringUTFChars(value, nullptr)) {}
  ~ScopedUtfChars() {
    if (chars_ != nullptr) env_->ReleaseStringUTFChars(value_, chars_);
  }
  const char* get() const { return chars_; }

 private:
  JNIEnv* env_;
  jstring value_;
  const char* chars_;
};

bool matches_identity(const struct stat& value, const char* expected) {
  return expected != nullptr
      && (std::to_string(static_cast<unsigned long long>(value.st_dev)) + ":"
          + std::to_string(static_cast<unsigned long long>(value.st_ino))) == expected;
}

}  // namespace

extern "C" JNIEXPORT jboolean JNICALL
Java_tech_dongdongbh_mindwtr_attachmentfileinstaller_ExactAttachmentPublisherNative_publishRelativeNoReplace(
    JNIEnv* env,
    jobject,
    jint source_fd,
    jstring private_directory_path,
    jstring target_directory_path,
    jstring target_name,
    jstring expected_source_identity,
    jstring expected_private_directory_identity,
    jstring expected_target_directory_identity) {
  ScopedUtfChars private_path(env, private_directory_path);
  ScopedUtfChars target_path(env, target_directory_path);
  ScopedUtfChars target_leaf(env, target_name);
  ScopedUtfChars expected_source(env, expected_source_identity);
  ScopedUtfChars expected_private(env, expected_private_directory_identity);
  ScopedUtfChars expected_target(env, expected_target_directory_identity);
  if (private_path.get() == nullptr || target_path.get() == nullptr || target_leaf.get() == nullptr
      || expected_source.get() == nullptr || expected_private.get() == nullptr
      || expected_target.get() == nullptr) {
    return JNI_FALSE;
  }
  const std::string target_leaf_value(target_leaf.get());
  if (target_leaf_value.empty() || target_leaf_value == "." || target_leaf_value == ".."
      || target_leaf_value.find('/') != std::string::npos) {
    throw_io_exception(env, "Attachment generation target name is invalid");
    return JNI_FALSE;
  }

  const int private_fd = open(private_path.get(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (private_fd < 0) {
    throw_io_exception(env, std::string("Could not retain private publication directory: ") + strerror(errno));
    return JNI_FALSE;
  }
  const int target_fd = open(target_path.get(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (target_fd < 0) {
    const int saved = errno;
    close(private_fd);
    throw_io_exception(env, std::string("Could not retain attachment target directory: ") + strerror(saved));
    return JNI_FALSE;
  }

  struct stat opened{};
  struct stat named{};
  struct stat private_directory{};
  struct stat target_directory{};
  const bool exact_named_stage = fstat(source_fd, &opened) == 0
      && S_ISREG(opened.st_mode)
      && matches_identity(opened, expected_source.get())
      && fstat(private_fd, &private_directory) == 0
      && S_ISDIR(private_directory.st_mode)
      && matches_identity(private_directory, expected_private.get())
      && fstat(target_fd, &target_directory) == 0
      && S_ISDIR(target_directory.st_mode)
      && matches_identity(target_directory, expected_target.get())
      && fstatat(private_fd, "stage", &named, AT_SYMLINK_NOFOLLOW) == 0
      && S_ISREG(named.st_mode)
      && opened.st_dev == named.st_dev
      && opened.st_ino == named.st_ino;
  if (!exact_named_stage) {
    close(target_fd);
    close(private_fd);
    throw_io_exception(env, "Verified attachment stage name changed before publication");
    return JNI_FALSE;
  }

  long result = syscall(
      SYS_renameat2,
      private_fd,
      "stage",
      target_fd,
      target_leaf.get(),
      RENAME_NOREPLACE);
  if (result != 0 && (errno == ENOSYS || errno == EOPNOTSUPP)) {
    const std::string exact_source = "/proc/self/fd/" + std::to_string(source_fd);
    result = linkat(
        AT_FDCWD,
        exact_source.c_str(),
        target_fd,
        target_leaf.get(),
        AT_SYMLINK_FOLLOW);
    if (result == 0 && unlinkat(private_fd, "stage", 0) != 0) {
      const int saved = errno;
      close(target_fd);
      close(private_fd);
      throw_io_exception(
          env,
          std::string("Published attachment stage could not release its private name: ")
              + strerror(saved));
      return JNI_FALSE;
    }
  }
  if (result != 0) {
    const int saved = errno;
    close(target_fd);
    close(private_fd);
    if (saved == EEXIST) return JNI_FALSE;
    throw_io_exception(env, std::string("Could not publish exact attachment stage: ") + strerror(saved));
    return JNI_FALSE;
  }

  const bool durable = fsync(target_fd) == 0 && fsync(private_fd) == 0;
  const int saved = errno;
  close(target_fd);
  close(private_fd);
  if (!durable) {
    throw_io_exception(env, std::string("Could not flush attachment publication directories: ") + strerror(saved));
    return JNI_FALSE;
  }
  return JNI_TRUE;
}
