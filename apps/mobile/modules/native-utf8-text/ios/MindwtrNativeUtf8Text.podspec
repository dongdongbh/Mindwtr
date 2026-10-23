Pod::Spec.new do |s|
  s.name = 'MindwtrNativeUtf8Text'
  s.version = '1.0.0'
  s.summary = 'Mindwtr native UTF-8 decoding for sync responses'
  s.description = 'Decodes a base64 response body as strict UTF-8 in Swift instead of a JavaScript TextDecoder.'
  s.homepage = 'https://github.com/dongdongbh/Mindwtr'
  s.license = { type: 'AGPL-3.0-only' }
  s.author = { 'Mindwtr' => 'dongdongli@dongdongli.com' }
  s.platform = :ios, '15.1'
  s.swift_version = '5.0'
  s.source = { git: 'https://github.com/dongdongbh/Mindwtr.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
  s.source_files = '**/*.{h,m,swift}'
end
