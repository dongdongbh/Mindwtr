#include "file_compat_lock.h"

#include <cerrno>
#include <fcntl.h>
#include <unistd.h>

#if defined(__linux__)
#ifndef F_OFD_SETLK
#define F_OFD_SETLK 37
#endif

namespace {
int set_ofd_lock(int fd, short type) {
  if (fd < 0) {
    return EBADF;
  }
  struct flock lock {};
  lock.l_type = type;
  lock.l_whence = SEEK_SET;
  lock.l_start = 0;
  lock.l_len = 0;
  if (fcntl(fd, F_OFD_SETLK, &lock) == 0) {
    return 0;
  }
  return errno;
}
}  // namespace

int mindwtr_try_ofd_write_lock(int fd) {
  return set_ofd_lock(fd, F_WRLCK);
}

int mindwtr_unlock_ofd_write_lock(int fd) {
  return set_ofd_lock(fd, F_UNLCK);
}
#else
int mindwtr_try_ofd_write_lock(int) { return ENOTSUP; }
int mindwtr_unlock_ofd_write_lock(int) { return ENOTSUP; }
#endif
