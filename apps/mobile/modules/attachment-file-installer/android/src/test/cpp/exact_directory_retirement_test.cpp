#include "exact_directory_retirement.h"

#include <cerrno>
#include <cstdlib>
#include <filesystem>
#include <fcntl.h>
#include <iostream>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

namespace {

using mindwtr::attachment_file_installer::BeforeDirectoryQuarantineHook;
using mindwtr::attachment_file_installer::DirectoryIdentity;
using mindwtr::attachment_file_installer::DirectoryRetirementHookPoint;
using mindwtr::attachment_file_installer::DirectoryRetirementResult;
using mindwtr::attachment_file_installer::directory_retirement_quarantine_name;
using mindwtr::attachment_file_installer::retire_empty_directory_if_identity;
using mindwtr::attachment_file_installer::retire_reserved_private_stage;

void require(bool condition, const std::string& message) {
  if (!condition) throw std::runtime_error(message);
}

class TemporaryDirectory {
 public:
  TemporaryDirectory() {
    char path[] = "/tmp/mindwtr-directory-retirement-XXXXXX";
    const char* created = mkdtemp(path);
    if (created == nullptr) throw std::runtime_error("mkdtemp failed");
    path_ = created;
  }

  ~TemporaryDirectory() { std::filesystem::remove_all(path_); }

  const std::string& path() const { return path_; }

 private:
  std::string path_;
};

DirectoryIdentity identity_at(int parent_fd, const char* name) {
  struct stat value {};
  require(fstatat(parent_fd, name, &value, AT_SYMLINK_NOFOLLOW) == 0, "fstatat failed");
  return DirectoryIdentity{
      static_cast<uint64_t>(value.st_dev),
      static_cast<uint64_t>(value.st_ino)};
}

bool exists_at(int parent_fd, const char* name) {
  struct stat value {};
  return fstatat(parent_fd, name, &value, AT_SYMLINK_NOFOLLOW) == 0;
}

void create_regular_file_at(int parent_fd, const char* name) {
  const int fd = openat(parent_fd, name, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  require(fd >= 0, "could not create regular file");
  close(fd);
}

struct ReplacementHookContext {
  std::string displaced_name;
  std::string quarantine_name;
  DirectoryIdentity peer_identity{};
};

void replace_with_peer_directory(
    DirectoryRetirementHookPoint point,
    int parent_fd,
    const char* directory_name,
    const char* quarantine_name,
    void* raw_context) {
  if (point != DirectoryRetirementHookPoint::kBeforeQuarantineRename) return;
  auto* context = static_cast<ReplacementHookContext*>(raw_context);
  context->quarantine_name = quarantine_name;
  require(
      renameat(parent_fd, directory_name, parent_fd, context->displaced_name.c_str()) == 0,
      "could not displace expected directory");
  require(mkdirat(parent_fd, directory_name, 0700) == 0, "could not install peer directory");
  context->peer_identity = identity_at(parent_fd, directory_name);
}

void replace_quarantine_with_peer_directory(
    DirectoryRetirementHookPoint point,
    int parent_fd,
    const char* directory_name,
    const char* quarantine_name,
    void* raw_context) {
  if (point != DirectoryRetirementHookPoint::kBeforeFinalIdentityCheck) return;
  auto* context = static_cast<ReplacementHookContext*>(raw_context);
  context->quarantine_name = quarantine_name;
  require(
      renameat(parent_fd, quarantine_name, parent_fd, context->displaced_name.c_str()) == 0,
      "could not displace quarantined directory");
  require(mkdirat(parent_fd, quarantine_name, 0700) == 0, "could not install quarantined peer");
  context->peer_identity = identity_at(parent_fd, quarantine_name);
  (void)directory_name;
}

void exit_at_hook_point(
    DirectoryRetirementHookPoint point,
    int,
    const char*,
    const char*,
    void* raw_context) {
  const auto expected = *static_cast<DirectoryRetirementHookPoint*>(raw_context);
  if (point == expected) _exit(73);
}

void replace_peer_then_exit_after_restore(
    DirectoryRetirementHookPoint point,
    int parent_fd,
    const char* directory_name,
    const char* quarantine_name,
    void*) {
  if (point == DirectoryRetirementHookPoint::kBeforeQuarantineRename) {
    require(
        renameat(parent_fd, directory_name, parent_fd, "owned-preserved") == 0,
        "could not displace expected directory before restore crash");
    require(
        mkdirat(parent_fd, directory_name, 0700) == 0,
        "could not install peer before restore crash");
  }
  if (point == DirectoryRetirementHookPoint::kAfterPeerRestoreBeforeParentSync) {
    (void)quarantine_name;
    _exit(73);
  }
}

void require_child_crash_at(
    int parent_fd,
    DirectoryIdentity expected,
    DirectoryIdentity expected_parent,
    DirectoryRetirementHookPoint hook_point) {
  const pid_t child = fork();
  require(child >= 0, "fork failed");
  if (child == 0) {
    int error_number = 0;
    (void)retire_empty_directory_if_identity(
        parent_fd,
        "candidate",
        expected,
        expected_parent,
        exit_at_hook_point,
        &hook_point,
        &error_number);
    _exit(74);
  }
  int status = 0;
  require(waitpid(child, &status, 0) == child, "waitpid failed");
  require(WIFEXITED(status) && WEXITSTATUS(status) == 73, "child missed crash hook");
}

void retires_the_expected_empty_directory() {
  TemporaryDirectory temporary;
  const int parent_fd = open(temporary.path().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(parent_fd >= 0, "could not open test parent");
  require(mkdirat(parent_fd, "candidate", 0700) == 0, "could not create candidate");
  const DirectoryIdentity expected = identity_at(parent_fd, "candidate");
  const DirectoryIdentity expected_parent = identity_at(AT_FDCWD, temporary.path().c_str());

  int error_number = 0;
  const DirectoryRetirementResult result = retire_empty_directory_if_identity(
      parent_fd,
      "candidate",
      expected,
      expected_parent,
      nullptr,
      nullptr,
      &error_number);

  require(result == DirectoryRetirementResult::kRetired, "expected directory was not retired");
  require(error_number == 0, "successful retirement reported an error");
  require(!exists_at(parent_fd, "candidate"), "retired directory name still exists");
  close(parent_fd);
}

void preserves_a_peer_swapped_in_before_quarantine() {
  TemporaryDirectory temporary;
  const int parent_fd = open(temporary.path().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(parent_fd >= 0, "could not open test parent");
  require(mkdirat(parent_fd, "candidate", 0700) == 0, "could not create candidate");
  const DirectoryIdentity expected = identity_at(parent_fd, "candidate");
  const DirectoryIdentity expected_parent = identity_at(AT_FDCWD, temporary.path().c_str());
  ReplacementHookContext context{"owned-preserved", "", {}};

  int error_number = 0;
  const DirectoryRetirementResult result = retire_empty_directory_if_identity(
      parent_fd,
      "candidate",
      expected,
      expected_parent,
      static_cast<BeforeDirectoryQuarantineHook>(replace_with_peer_directory),
      &context,
      &error_number);

  require(result == DirectoryRetirementResult::kConflict, "peer replacement was not reported");
  require(error_number == 0, "peer replacement was misreported as an I/O error");
  require(identity_at(parent_fd, "candidate") == context.peer_identity, "peer directory was not restored");
  require(identity_at(parent_fd, "owned-preserved") == expected, "owned directory was not preserved");
  require(!exists_at(parent_fd, context.quarantine_name.c_str()), "peer leaked in quarantine");
  close(parent_fd);
}

void preserves_a_peer_swapped_in_before_final_identity_check() {
  TemporaryDirectory temporary;
  const int parent_fd = open(temporary.path().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(parent_fd >= 0, "could not open test parent");
  require(mkdirat(parent_fd, "candidate", 0700) == 0, "could not create candidate");
  const DirectoryIdentity expected = identity_at(parent_fd, "candidate");
  const DirectoryIdentity expected_parent = identity_at(AT_FDCWD, temporary.path().c_str());
  ReplacementHookContext context{"owned-preserved", "", {}};

  int error_number = 0;
  const DirectoryRetirementResult result = retire_empty_directory_if_identity(
      parent_fd,
      "candidate",
      expected,
      expected_parent,
      replace_quarantine_with_peer_directory,
      &context,
      &error_number);

  require(result == DirectoryRetirementResult::kConflict, "quarantine replacement was not reported");
  require(error_number == 0, "quarantine replacement was misreported as an I/O error");
  require(identity_at(parent_fd, "candidate") == context.peer_identity, "quarantined peer was not restored");
  require(identity_at(parent_fd, "owned-preserved") == expected, "owned quarantine was not preserved");
  require(!exists_at(parent_fd, context.quarantine_name.c_str()), "peer leaked in quarantine");
  close(parent_fd);
}

void resumes_after_crash_with_expected_quarantine() {
  TemporaryDirectory temporary;
  const int parent_fd = open(temporary.path().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(parent_fd >= 0, "could not open test parent");
  require(mkdirat(parent_fd, "candidate", 0700) == 0, "could not create candidate");
  const DirectoryIdentity expected = identity_at(parent_fd, "candidate");
  const DirectoryIdentity expected_parent = identity_at(AT_FDCWD, temporary.path().c_str());
  require_child_crash_at(
      parent_fd,
      expected,
      expected_parent,
      DirectoryRetirementHookPoint::kAfterQuarantineRename);

  int error_number = 0;
  const DirectoryRetirementResult result = retire_empty_directory_if_identity(
      parent_fd,
      "candidate",
      expected,
      expected_parent,
      nullptr,
      nullptr,
      &error_number);

  require(result == DirectoryRetirementResult::kRetired, "expected quarantine was not resumed");
  require(!exists_at(parent_fd, "candidate"), "candidate reappeared after quarantine resume");
  require(
      !exists_at(parent_fd, directory_retirement_quarantine_name("candidate").c_str()),
      "quarantine remained after resume");
  close(parent_fd);
}

void confirms_missing_after_crash_before_parent_sync() {
  TemporaryDirectory temporary;
  const int parent_fd = open(temporary.path().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(parent_fd >= 0, "could not open test parent");
  require(mkdirat(parent_fd, "candidate", 0700) == 0, "could not create candidate");
  const DirectoryIdentity expected = identity_at(parent_fd, "candidate");
  const DirectoryIdentity expected_parent = identity_at(AT_FDCWD, temporary.path().c_str());
  require_child_crash_at(
      parent_fd,
      expected,
      expected_parent,
      DirectoryRetirementHookPoint::kAfterRetirementBeforeParentSync);

  int error_number = 0;
  const DirectoryRetirementResult result = retire_empty_directory_if_identity(
      parent_fd,
      "candidate",
      expected,
      expected_parent,
      nullptr,
      nullptr,
      &error_number);

  require(result == DirectoryRetirementResult::kMissing, "missing retirement was not durably confirmed");
  require(error_number == 0, "missing confirmation reported an error");
  close(parent_fd);
}

void preserves_peer_after_crash_before_restore_sync() {
  TemporaryDirectory temporary;
  const int parent_fd = open(temporary.path().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(parent_fd >= 0, "could not open test parent");
  require(mkdirat(parent_fd, "candidate", 0700) == 0, "could not create candidate");
  const DirectoryIdentity expected = identity_at(parent_fd, "candidate");
  const DirectoryIdentity expected_parent = identity_at(AT_FDCWD, temporary.path().c_str());
  const pid_t child = fork();
  require(child >= 0, "fork failed");
  if (child == 0) {
    int child_error = 0;
    (void)retire_empty_directory_if_identity(
        parent_fd,
        "candidate",
        expected,
        expected_parent,
        replace_peer_then_exit_after_restore,
        nullptr,
        &child_error);
    _exit(74);
  }
  int status = 0;
  require(waitpid(child, &status, 0) == child, "waitpid failed");
  require(WIFEXITED(status) && WEXITSTATUS(status) == 73, "child missed restore crash hook");

  int error_number = 0;
  const DirectoryRetirementResult result = retire_empty_directory_if_identity(
      parent_fd,
      "candidate",
      expected,
      expected_parent,
      nullptr,
      nullptr,
      &error_number);

  require(result == DirectoryRetirementResult::kConflict, "restored peer was not preserved after crash");
  require(identity_at(parent_fd, "owned-preserved") == expected, "owned directory was lost after restore crash");
  require(!(identity_at(parent_fd, "candidate") == expected), "peer directory was lost after restore crash");
  require(
      !exists_at(parent_fd, directory_retirement_quarantine_name("candidate").c_str()),
      "quarantine remained after peer restore crash");
  close(parent_fd);
}

void rejects_a_rebound_parent() {
  TemporaryDirectory temporary;
  const int parent_fd = open(temporary.path().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(parent_fd >= 0, "could not open test parent");
  require(mkdirat(parent_fd, "candidate", 0700) == 0, "could not create candidate");
  const DirectoryIdentity expected = identity_at(parent_fd, "candidate");
  DirectoryIdentity wrong_parent = identity_at(AT_FDCWD, temporary.path().c_str());
  wrong_parent.inode += 1;

  int error_number = 0;
  const DirectoryRetirementResult result = retire_empty_directory_if_identity(
      parent_fd,
      "candidate",
      expected,
      wrong_parent,
      nullptr,
      nullptr,
      &error_number);

  require(result == DirectoryRetirementResult::kConflict, "rebound parent was not rejected");
  require(exists_at(parent_fd, "candidate"), "rebound parent cleanup mutated the candidate");
  close(parent_fd);
}

void preserves_a_preexisting_peer_quarantine() {
  TemporaryDirectory temporary;
  const int parent_fd = open(temporary.path().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(parent_fd >= 0, "could not open test parent");
  require(mkdirat(parent_fd, "candidate", 0700) == 0, "could not create candidate");
  const DirectoryIdentity expected = identity_at(parent_fd, "candidate");
  const DirectoryIdentity expected_parent = identity_at(AT_FDCWD, temporary.path().c_str());
  const std::string quarantine_name = directory_retirement_quarantine_name("candidate");
  require(mkdirat(parent_fd, quarantine_name.c_str(), 0700) == 0, "could not create peer quarantine");
  const DirectoryIdentity peer = identity_at(parent_fd, quarantine_name.c_str());

  int error_number = 0;
  const DirectoryRetirementResult result = retire_empty_directory_if_identity(
      parent_fd,
      "candidate",
      expected,
      expected_parent,
      nullptr,
      nullptr,
      &error_number);

  require(result == DirectoryRetirementResult::kConflict, "peer quarantine was not reported");
  require(identity_at(parent_fd, "candidate") == expected, "candidate changed around peer quarantine");
  require(identity_at(parent_fd, quarantine_name.c_str()) == peer, "peer quarantine was changed");
  close(parent_fd);
}

void retires_an_unclaimed_reserved_stage() {
  TemporaryDirectory temporary;
  const int parent_fd = open(temporary.path().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(parent_fd >= 0, "could not open test parent");
  require(mkdirat(parent_fd, "candidate", 0700) == 0, "could not create candidate");
  const int candidate_fd = openat(parent_fd, "candidate", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(candidate_fd >= 0, "could not open candidate");
  create_regular_file_at(candidate_fd, "stage");
  close(candidate_fd);

  int error_number = 0;
  const DirectoryRetirementResult result = retire_reserved_private_stage(
      parent_fd,
      "candidate",
      &error_number);

  require(result == DirectoryRetirementResult::kRetired, "reserved stage was not retired");
  require(error_number == 0, "reserved stage retirement reported an error");
  require(!exists_at(parent_fd, "candidate"), "reserved candidate remained");
  require(
      !exists_at(parent_fd, directory_retirement_quarantine_name("candidate").c_str()),
      "reserved retirement quarantine remained");
  close(parent_fd);
}

void resumes_an_unclaimed_reserved_quarantine() {
  TemporaryDirectory temporary;
  const int parent_fd = open(temporary.path().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(parent_fd >= 0, "could not open test parent");
  require(mkdirat(parent_fd, "candidate", 0700) == 0, "could not create candidate");
  const DirectoryIdentity expected = identity_at(parent_fd, "candidate");
  const DirectoryIdentity expected_parent = identity_at(AT_FDCWD, temporary.path().c_str());
  require_child_crash_at(
      parent_fd,
      expected,
      expected_parent,
      DirectoryRetirementHookPoint::kAfterQuarantineRename);

  int error_number = 0;
  const DirectoryRetirementResult result = retire_reserved_private_stage(
      parent_fd,
      "candidate",
      &error_number);

  require(result == DirectoryRetirementResult::kRetired, "reserved quarantine was not resumed");
  require(!exists_at(parent_fd, "candidate"), "reserved candidate reappeared");
  require(
      !exists_at(parent_fd, directory_retirement_quarantine_name("candidate").c_str()),
      "reserved quarantine remained");
  close(parent_fd);
}

void retains_the_open_parent_across_path_rebind() {
  TemporaryDirectory temporary;
  const std::string parent_path = temporary.path() + "/parent";
  const std::string retained_path = temporary.path() + "/retained-parent";
  require(mkdir(parent_path.c_str(), 0700) == 0, "could not create test parent");
  const int parent_fd = open(parent_path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(parent_fd >= 0, "could not retain test parent");
  require(mkdirat(parent_fd, "candidate", 0700) == 0, "could not create retained candidate");
  const int candidate_fd = openat(parent_fd, "candidate", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(candidate_fd >= 0, "could not open retained candidate");
  create_regular_file_at(candidate_fd, "stage");
  close(candidate_fd);

  require(rename(parent_path.c_str(), retained_path.c_str()) == 0, "could not rebind parent path");
  require(mkdir(parent_path.c_str(), 0700) == 0, "could not create replacement parent");
  const int replacement_fd = open(parent_path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  require(replacement_fd >= 0, "could not open replacement parent");
  require(mkdirat(replacement_fd, "candidate", 0700) == 0, "could not create peer candidate");
  const DirectoryIdentity peer_identity = identity_at(replacement_fd, "candidate");

  int error_number = 0;
  const DirectoryRetirementResult result = retire_reserved_private_stage(
      parent_fd,
      "candidate",
      &error_number);

  require(result == DirectoryRetirementResult::kRetired, "retained candidate was not retired");
  require(!exists_at(parent_fd, "candidate"), "retained candidate remained after rebind");
  require(
      identity_at(replacement_fd, "candidate") == peer_identity,
      "replacement-root peer was changed");
  close(replacement_fd);
  close(parent_fd);
}

}  // namespace

int main() {
  try {
    retires_the_expected_empty_directory();
    preserves_a_peer_swapped_in_before_quarantine();
    preserves_a_peer_swapped_in_before_final_identity_check();
    resumes_after_crash_with_expected_quarantine();
    confirms_missing_after_crash_before_parent_sync();
    preserves_peer_after_crash_before_restore_sync();
    rejects_a_rebound_parent();
    preserves_a_preexisting_peer_quarantine();
    retires_an_unclaimed_reserved_stage();
    resumes_an_unclaimed_reserved_quarantine();
    retains_the_open_parent_across_path_rebind();
    std::cout << "exact directory retirement tests passed\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
