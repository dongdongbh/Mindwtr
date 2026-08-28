cmake_minimum_required(VERSION 3.22.1)

project(sync_file_lock LANGUAGES CXX)

add_library(
  sync-file-lock
  SHARED
  stable_root_lock.cpp
)
