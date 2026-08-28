#include "file_compat_lock.h"

#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <sys/wait.h>
#include <unistd.h>

namespace {
void require(bool condition, const char *message) {
  if (!condition) {
    std::perror(message);
    std::exit(1);
  }
}

int try_classic_write_lock(int fd) {
  struct flock lock {};
  lock.l_type = F_WRLCK;
  lock.l_whence = SEEK_SET;
  lock.l_start = 0;
  lock.l_len = 0;
  if (fcntl(fd, F_SETLK, &lock) == 0) {
    return 0;
  }
  return errno;
}

void write_exact(int fd, const void *bytes, size_t size) {
  require(write(fd, bytes, size) == static_cast<ssize_t>(size), "write pipe");
}

void read_exact(int fd, void *bytes, size_t size) {
  require(read(fd, bytes, size) == static_cast<ssize_t>(size), "read pipe");
}
}  // namespace

int main() {
  char path[] = "/tmp/mindwtr-ofd-lock.XXXXXX";
  const int retained_fd = mkstemp(path);
  require(retained_fd >= 0, "mkstemp");
  require(mindwtr_try_ofd_write_lock(retained_fd) == 0, "acquire OFD lock");

  int commands[2];
  int results[2];
  require(pipe(commands) == 0, "command pipe");
  require(pipe(results) == 0, "result pipe");
  const pid_t child = fork();
  require(child >= 0, "fork");
  if (child == 0) {
    close(commands[1]);
    close(results[0]);
    close(retained_fd);
    const int legacy_fd = open(path, O_RDWR | O_CLOEXEC);
    require(legacy_fd >= 0, "child open");
    for (int attempt = 0; attempt < 2; ++attempt) {
      char command = 0;
      read_exact(commands[0], &command, sizeof(command));
      const int result = try_classic_write_lock(legacy_fd);
      write_exact(results[1], &result, sizeof(result));
    }
    close(legacy_fd);
    _exit(0);
  }

  close(commands[0]);
  close(results[1]);
  // SAF identity revalidation opens and closes another descriptor for the same
  // document. A process-owned F_SETLK lock would be released here; the retained
  // OFD lock must continue excluding a legacy FileChannel/fcntl owner.
  for (int attempt = 0; attempt < 3; ++attempt) {
    const int validation_fd = open(path, O_RDONLY | O_CLOEXEC);
    require(validation_fd >= 0, "validation open");
    close(validation_fd);
  }
  char command = 1;
  write_exact(commands[1], &command, sizeof(command));
  int first_result = 0;
  read_exact(results[0], &first_result, sizeof(first_result));
  require(first_result == EAGAIN || first_result == EACCES,
          "legacy lock unexpectedly acquired after revalidation");

  require(mindwtr_unlock_ofd_write_lock(retained_fd) == 0, "release OFD lock");
  command = 2;
  write_exact(commands[1], &command, sizeof(command));
  int second_result = -1;
  read_exact(results[0], &second_result, sizeof(second_result));
  require(second_result == 0, "legacy lock did not acquire after release");

  int status = 0;
  require(waitpid(child, &status, 0) == child, "waitpid");
  require(WIFEXITED(status) && WEXITSTATUS(status) == 0, "child failed");
  close(commands[1]);
  close(results[0]);
  close(retained_fd);
  unlink(path);
  return 0;
}
