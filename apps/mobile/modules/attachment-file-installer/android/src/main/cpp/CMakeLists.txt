cmake_minimum_required(VERSION 3.22.1)

project(attachment_file_installer LANGUAGES CXX)

add_library(
  attachment-file-installer
  SHARED
  exact_directory_retirement.cpp
  exact_attachment_publisher.cpp
)

target_link_options(
  attachment-file-installer
  PRIVATE
  "-Wl,-z,max-page-size=16384"
  "-Wl,-z,common-page-size=16384"
)
