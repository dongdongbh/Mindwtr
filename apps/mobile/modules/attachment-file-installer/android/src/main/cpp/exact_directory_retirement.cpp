#include "exact_directory_retirement.h"

#include <cerrno>
#include <fcntl.h>
#include <linux/fs.h>
#include <string>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

namespace mindwtr::attachment_file_installer {
namespace {

enum class NamedDirectoryState {
  kMissing,
  kExpected,
  kPeer,
  kIoError,
};

struct InspectedDirectory {
  NamedDirectoryState state;
  int error_number;
};

void report_error(int* output, int value) {
  if (output != nullptr) *output = value;
}

DirectoryRetirementResult io_error(int* error_number, int value) {
  report_error(error_number, value);
  return DirectoryRetirementResult::kIoError;
}

bool parent_matches(int parent_fd, DirectoryIdentity expected) {
  struct stat value {};
  return fstat(parent_fd, &value) == 0
      && S_ISDIR(value.st_mode)
      && DirectoryIdentity{
          static_cast<uint64_t>(value.st_dev),
          static_cast<uint64_t>(value.st_ino)} == expected;
}

bool retained_directory_matches(int directory_fd, DirectoryIdentity expected) {
  struct stat value {};
  return fstat(directory_fd, &value) == 0
      && S_ISDIR(value.st_mode)
      && DirectoryIdentity{
          static_cast<uint64_t>(value.st_dev),
          static_cast<uint64_t>(value.st_ino)} == expected;
}

int open_expected_directory(
    int parent_fd,
    const char* name,
    DirectoryIdentity expected,
    int* error_number) {
  const int directory_fd = openat(
      parent_fd,
      name,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (directory_fd < 0) {
    const int saved = errno;
    report_error(
        error_number,
        saved == ENOENT || saved == ENOTDIR || saved == ELOOP ? 0 : saved);
    return -1;
  }
  if (!retained_directory_matches(directory_fd, expected)) {
    close(directory_fd);
    report_error(error_number, 0);
    return -1;
  }
  report_error(error_number, 0);
  return directory_fd;
}

InspectedDirectory inspect_directory(
    int parent_fd,
    const char* name,
    DirectoryIdentity expected) {
  struct stat value {};
  if (fstatat(parent_fd, name, &value, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) return {NamedDirectoryState::kMissing, 0};
    return {NamedDirectoryState::kIoError, errno};
  }
  if (!S_ISDIR(value.st_mode)) return {NamedDirectoryState::kPeer, 0};
  return {
      DirectoryIdentity{
          static_cast<uint64_t>(value.st_dev),
          static_cast<uint64_t>(value.st_ino)} == expected
          ? NamedDirectoryState::kExpected
          : NamedDirectoryState::kPeer,
      0};
}

int rename_noreplace(
    int parent_fd,
    const char* source,
    const char* destination) {
  return static_cast<int>(syscall(
      SYS_renameat2,
      parent_fd,
      source,
      parent_fd,
      destination,
      RENAME_NOREPLACE));
}

void invoke_hook(
    BeforeDirectoryQuarantineHook hook,
    DirectoryRetirementHookPoint point,
    int parent_fd,
    const char* directory_name,
    const char* quarantine_name,
    void* context) {
  if (hook != nullptr) {
    hook(point, parent_fd, directory_name, quarantine_name, context);
  }
}

DirectoryRetirementResult sync_parent(
    int parent_fd,
    DirectoryIdentity expected_parent,
    DirectoryRetirementResult result,
    int* error_number) {
  if (!parent_matches(parent_fd, expected_parent)) {
    return DirectoryRetirementResult::kConflict;
  }
  if (fsync(parent_fd) != 0) return io_error(error_number, errno);
  return result;
}

DirectoryRetirementResult restore_peer(
    int parent_fd,
    const char* directory_name,
    const char* quarantine_name,
    DirectoryIdentity expected_parent,
    BeforeDirectoryQuarantineHook hook,
    void* hook_context,
    int* error_number) {
  if (!parent_matches(parent_fd, expected_parent)) {
    return DirectoryRetirementResult::kConflict;
  }
  if (rename_noreplace(parent_fd, quarantine_name, directory_name) != 0) {
    const int saved = errno;
    if (saved != EEXIST && saved != ENOENT) return io_error(error_number, saved);
    return sync_parent(
        parent_fd,
        expected_parent,
        DirectoryRetirementResult::kConflict,
        error_number);
  }
  invoke_hook(
      hook,
      DirectoryRetirementHookPoint::kAfterPeerRestoreBeforeParentSync,
      parent_fd,
      directory_name,
      quarantine_name,
      hook_context);
  return sync_parent(
      parent_fd,
      expected_parent,
      DirectoryRetirementResult::kConflict,
      error_number);
}

DirectoryRetirementResult retire_quarantine(
    int parent_fd,
    int retained_directory_fd,
    const char* directory_name,
    const char* quarantine_name,
    DirectoryIdentity expected_directory,
    DirectoryIdentity expected_parent,
    BeforeDirectoryQuarantineHook hook,
    void* hook_context,
    bool namespace_changed,
    int* error_number) {
  invoke_hook(
      hook,
      DirectoryRetirementHookPoint::kBeforeFinalIdentityCheck,
      parent_fd,
      directory_name,
      quarantine_name,
      hook_context);
  if (
      !parent_matches(parent_fd, expected_parent)
      || !retained_directory_matches(retained_directory_fd, expected_directory)) {
    return DirectoryRetirementResult::kConflict;
  }

  const auto conflict = [&]() {
    return namespace_changed
        ? sync_parent(
            parent_fd,
            expected_parent,
            DirectoryRetirementResult::kConflict,
            error_number)
        : DirectoryRetirementResult::kConflict;
  };

  const InspectedDirectory candidate = inspect_directory(
      parent_fd,
      directory_name,
      expected_directory);
  const InspectedDirectory quarantine = inspect_directory(
      parent_fd,
      quarantine_name,
      expected_directory);
  if (candidate.state == NamedDirectoryState::kIoError) {
    return io_error(error_number, candidate.error_number);
  }
  if (quarantine.state == NamedDirectoryState::kIoError) {
    return io_error(error_number, quarantine.error_number);
  }
  if (
      candidate.state == NamedDirectoryState::kMissing
      && quarantine.state == NamedDirectoryState::kPeer) {
    return restore_peer(
        parent_fd,
        directory_name,
        quarantine_name,
        expected_parent,
        hook,
        hook_context,
        error_number);
  }
  if (
      candidate.state != NamedDirectoryState::kMissing
      || quarantine.state != NamedDirectoryState::kExpected) {
    return conflict();
  }

  // The quarantine leaf is derived from the reservation's random capability and is
  // only manipulated while Mindwtr holds the installer lock. Rechecking here
  // rejects uncoordinated swaps before the directory-only removal. A malicious
  // same-UID process that targets this private name is outside the stated model.
  if (
      !parent_matches(parent_fd, expected_parent)
      || !retained_directory_matches(retained_directory_fd, expected_directory)) {
    return conflict();
  }
  const InspectedDirectory final_quarantine = inspect_directory(
      parent_fd,
      quarantine_name,
      expected_directory);
  if (final_quarantine.state == NamedDirectoryState::kIoError) {
    return io_error(error_number, final_quarantine.error_number);
  }
  if (final_quarantine.state == NamedDirectoryState::kPeer) {
    return restore_peer(
        parent_fd,
        directory_name,
        quarantine_name,
        expected_parent,
        hook,
        hook_context,
        error_number);
  }
  if (final_quarantine.state != NamedDirectoryState::kExpected) {
    return conflict();
  }
  if (unlinkat(parent_fd, quarantine_name, AT_REMOVEDIR) != 0) {
    const int saved = errno;
    if (
        saved == ENOENT
        || saved == ENOTDIR
        || saved == ENOTEMPTY
        || saved == EEXIST
        || saved == EBUSY) {
      return conflict();
    }
    return io_error(error_number, saved);
  }
  invoke_hook(
      hook,
      DirectoryRetirementHookPoint::kAfterRetirementBeforeParentSync,
      parent_fd,
      directory_name,
      quarantine_name,
      hook_context);
  return sync_parent(
      parent_fd,
      expected_parent,
      DirectoryRetirementResult::kRetired,
      error_number);
}

}  // namespace

std::string directory_retirement_quarantine_name(
    const char* directory_name) {
  return std::string(directory_name) + ".retiring";
}

DirectoryRetirementResult retire_reserved_private_stage(
    int parent_fd,
    const char* directory_name,
    int* error_number) {
  report_error(error_number, 0);
  if (
      parent_fd < 0
      || directory_name == nullptr
      || directory_name[0] == '\0'
      || std::string(directory_name) == "."
      || std::string(directory_name) == ".."
      || std::string(directory_name).find('/') != std::string::npos) {
    return io_error(error_number, EINVAL);
  }

  struct stat parent_value {};
  if (fstat(parent_fd, &parent_value) != 0) return io_error(error_number, errno);
  if (!S_ISDIR(parent_value.st_mode)) return DirectoryRetirementResult::kConflict;
  const DirectoryIdentity parent_identity{
      static_cast<uint64_t>(parent_value.st_dev),
      static_cast<uint64_t>(parent_value.st_ino)};
  const std::string quarantine_name = directory_retirement_quarantine_name(directory_name);
  const long name_max = fpathconf(parent_fd, _PC_NAME_MAX);
  if (name_max > 0 && quarantine_name.size() > static_cast<size_t>(name_max)) {
    return io_error(error_number, ENAMETOOLONG);
  }

  struct stat candidate_value {};
  const bool candidate_exists = fstatat(
      parent_fd,
      directory_name,
      &candidate_value,
      AT_SYMLINK_NOFOLLOW) == 0;
  if (!candidate_exists && errno != ENOENT) return io_error(error_number, errno);
  struct stat quarantine_value {};
  const bool quarantine_exists = fstatat(
      parent_fd,
      quarantine_name.c_str(),
      &quarantine_value,
      AT_SYMLINK_NOFOLLOW) == 0;
  if (!quarantine_exists && errno != ENOENT) return io_error(error_number, errno);

  if (!candidate_exists && !quarantine_exists) {
    return sync_parent(
        parent_fd,
        parent_identity,
        DirectoryRetirementResult::kMissing,
        error_number);
  }
  if (candidate_exists && quarantine_exists) {
    return DirectoryRetirementResult::kConflict;
  }
  if (quarantine_exists) {
    if (!S_ISDIR(quarantine_value.st_mode)) {
      return DirectoryRetirementResult::kConflict;
    }
    const DirectoryIdentity quarantine_identity{
        static_cast<uint64_t>(quarantine_value.st_dev),
        static_cast<uint64_t>(quarantine_value.st_ino)};
    return retire_empty_directory_if_identity(
        parent_fd,
        directory_name,
        quarantine_identity,
        parent_identity,
        nullptr,
        nullptr,
        error_number);
  }
  if (!S_ISDIR(candidate_value.st_mode)) {
    return DirectoryRetirementResult::kConflict;
  }
  const DirectoryIdentity candidate_identity{
      static_cast<uint64_t>(candidate_value.st_dev),
      static_cast<uint64_t>(candidate_value.st_ino)};
  int open_error = 0;
  const int candidate_fd = open_expected_directory(
      parent_fd,
      directory_name,
      candidate_identity,
      &open_error);
  if (candidate_fd < 0) {
    return open_error == 0
        ? DirectoryRetirementResult::kConflict
        : io_error(error_number, open_error);
  }

  struct stat stage_value {};
  if (fstatat(candidate_fd, "stage", &stage_value, AT_SYMLINK_NOFOLLOW) == 0) {
    if (!S_ISREG(stage_value.st_mode)) {
      close(candidate_fd);
      return DirectoryRetirementResult::kConflict;
    }
    if (unlinkat(candidate_fd, "stage", 0) != 0) {
      const int saved = errno;
      close(candidate_fd);
      if (saved == ENOENT || saved == EISDIR || saved == EPERM) {
        return DirectoryRetirementResult::kConflict;
      }
      return io_error(error_number, saved);
    }
  } else if (errno != ENOENT) {
    const int saved = errno;
    close(candidate_fd);
    return io_error(error_number, saved);
  }
  if (fsync(candidate_fd) != 0) {
    const int saved = errno;
    close(candidate_fd);
    return io_error(error_number, saved);
  }
  close(candidate_fd);
  return retire_empty_directory_if_identity(
      parent_fd,
      directory_name,
      candidate_identity,
      parent_identity,
      nullptr,
      nullptr,
      error_number);
}

DirectoryRetirementResult retire_empty_directory_if_identity(
    int parent_fd,
    const char* directory_name,
    DirectoryIdentity expected_directory,
    DirectoryIdentity expected_parent,
    BeforeDirectoryQuarantineHook hook,
    void* hook_context,
    int* error_number) {
  report_error(error_number, 0);
  if (
      parent_fd < 0
      || directory_name == nullptr
      || directory_name[0] == '\0'
      || std::string(directory_name) == "."
      || std::string(directory_name) == ".."
      || std::string(directory_name).find('/') != std::string::npos) {
    return io_error(error_number, EINVAL);
  }
  if (!parent_matches(parent_fd, expected_parent)) {
    return DirectoryRetirementResult::kConflict;
  }

  const std::string quarantine_name = directory_retirement_quarantine_name(directory_name);
  const long name_max = fpathconf(parent_fd, _PC_NAME_MAX);
  if (name_max > 0 && quarantine_name.size() > static_cast<size_t>(name_max)) {
    return io_error(error_number, ENAMETOOLONG);
  }

  const InspectedDirectory candidate = inspect_directory(
      parent_fd,
      directory_name,
      expected_directory);
  const InspectedDirectory quarantine = inspect_directory(
      parent_fd,
      quarantine_name.c_str(),
      expected_directory);
  if (candidate.state == NamedDirectoryState::kIoError) {
    return io_error(error_number, candidate.error_number);
  }
  if (quarantine.state == NamedDirectoryState::kIoError) {
    return io_error(error_number, quarantine.error_number);
  }

  if (
      candidate.state == NamedDirectoryState::kMissing
      && quarantine.state == NamedDirectoryState::kMissing) {
    return sync_parent(
        parent_fd,
        expected_parent,
        DirectoryRetirementResult::kMissing,
        error_number);
  }
  if (
      candidate.state == NamedDirectoryState::kMissing
      && quarantine.state == NamedDirectoryState::kPeer) {
    return restore_peer(
        parent_fd,
        directory_name,
        quarantine_name.c_str(),
        expected_parent,
        hook,
        hook_context,
        error_number);
  }
  if (
      candidate.state == NamedDirectoryState::kMissing
      && quarantine.state == NamedDirectoryState::kExpected) {
    int open_error = 0;
    const int retained_directory_fd = open_expected_directory(
        parent_fd,
        quarantine_name.c_str(),
        expected_directory,
        &open_error);
    if (retained_directory_fd < 0) {
      return open_error == 0
          ? DirectoryRetirementResult::kConflict
          : io_error(error_number, open_error);
    }
    const DirectoryRetirementResult result = retire_quarantine(
        parent_fd,
        retained_directory_fd,
        directory_name,
        quarantine_name.c_str(),
        expected_directory,
        expected_parent,
        hook,
        hook_context,
        false,
        error_number);
    close(retained_directory_fd);
    return result;
  }
  if (
      candidate.state != NamedDirectoryState::kExpected
      || quarantine.state != NamedDirectoryState::kMissing) {
    return DirectoryRetirementResult::kConflict;
  }

  int open_error = 0;
  const int retained_directory_fd = open_expected_directory(
      parent_fd,
      directory_name,
      expected_directory,
      &open_error);
  if (retained_directory_fd < 0) {
    return open_error == 0
        ? DirectoryRetirementResult::kConflict
        : io_error(error_number, open_error);
  }

  invoke_hook(
      hook,
      DirectoryRetirementHookPoint::kBeforeQuarantineRename,
      parent_fd,
      directory_name,
      quarantine_name.c_str(),
      hook_context);
  if (!parent_matches(parent_fd, expected_parent)) {
    close(retained_directory_fd);
    return DirectoryRetirementResult::kConflict;
  }
  if (rename_noreplace(parent_fd, directory_name, quarantine_name.c_str()) != 0) {
    const int saved = errno;
    close(retained_directory_fd);
    if (saved == EEXIST || saved == ENOENT) {
      return DirectoryRetirementResult::kConflict;
    }
    return io_error(error_number, saved);
  }
  invoke_hook(
      hook,
      DirectoryRetirementHookPoint::kAfterQuarantineRename,
      parent_fd,
      directory_name,
      quarantine_name.c_str(),
      hook_context);
  const DirectoryRetirementResult result = retire_quarantine(
      parent_fd,
      retained_directory_fd,
      directory_name,
      quarantine_name.c_str(),
      expected_directory,
      expected_parent,
      hook,
      hook_context,
      true,
      error_number);
  close(retained_directory_fd);
  return result;
}

}  // namespace mindwtr::attachment_file_installer
