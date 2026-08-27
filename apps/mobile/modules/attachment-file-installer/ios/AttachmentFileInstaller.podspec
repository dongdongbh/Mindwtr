Pod::Spec.new do |s|
  s.name = 'AttachmentFileInstaller'
  s.version = '1.0.0'
  s.summary = 'Mindwtr generation-bound attachment file installer'
  s.description = 'Crash-recoverable native installer for app-private Mindwtr attachment files.'
  s.homepage = 'https://github.com/dongdongbh/Mindwtr'
  s.license = { type: 'AGPL-3.0-only' }
  s.author = { 'Mindwtr' => 'dongdongli@dongdongli.com' }
  s.platform = :ios, '15.1'
  s.swift_version = '5.0'
  s.source = { git: 'https://github.com/dongdongbh/Mindwtr.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  # Keep the Swift Package test manifest and XCTest sources out of the pod.
  s.source_files = 'AttachmentFileInstallerModule.swift'
end
