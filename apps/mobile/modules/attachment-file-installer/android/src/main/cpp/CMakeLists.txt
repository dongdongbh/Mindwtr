cmake_minimum_required(VERSION 3.22.1)

project(attachment_file_installer LANGUAGES CXX)

add_library(
  attachment-file-installer
  SHARED
  exact_attachment_publisher.cpp
)
