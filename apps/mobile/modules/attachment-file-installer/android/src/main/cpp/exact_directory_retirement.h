#pragma once

#include <cstdint>
#include <string>

namespace mindwtr::attachment_file_installer {

struct DirectoryIdentity {
  uint64_t device;
  uint64_t inode;
};

inline bool operator==(const DirectoryIdentity& left, const DirectoryIdentity& right) {
  return left.device == right.device && left.inode == right.inode;
}

enum class DirectoryRetirementResult {
  kRetired = 0,
  kMissing = 1,
  kConflict = 2,
  kIoError = 3,
};

enum class DirectoryRetirementHookPoint {
  kBeforeQuarantineRename,
  kAfterQuarantineRename,
  kBeforeFinalIdentityCheck,
  kAfterRetirementBeforeParentSync,
  kAfterPeerRestoreBeforeParentSync,
};

using BeforeDirectoryQuarantineHook = void (*)(
    DirectoryRetirementHookPoint point,
    int parent_fd,
    const char* directory_name,
    const char* quarantine_name,
    void* context);

std::string directory_retirement_quarantine_name(
    const char* directory_name);

DirectoryRetirementResult retire_reserved_private_stage(
    int parent_fd,
    const char* directory_name,
    int* error_number);

DirectoryRetirementResult retire_empty_directory_if_identity(
    int parent_fd,
    const char* directory_name,
    DirectoryIdentity expected_directory,
    DirectoryIdentity expected_parent,
    BeforeDirectoryQuarantineHook hook,
    void* hook_context,
    int* error_number);

}  // namespace mindwtr::attachment_file_installer
