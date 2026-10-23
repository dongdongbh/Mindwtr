Pod::Spec.new do |s|
  s.name = 'MindwtrGmailAuthorization'
  s.version = '1.0.0'
  s.summary = 'Mindwtr native Gmail read-only authorization'
  s.description = 'Browser OAuth with PKCE and device-only Keychain credentials.'
  s.homepage = 'https://github.com/dongdongbh/Mindwtr'
  s.license = { type: 'AGPL-3.0-only' }
  s.author = { 'Mindwtr' => 'dongdongli@dongdongli.com' }
  s.platform = :ios, '15.1'
  s.swift_version = '5.0'
  s.source = { git: 'https://github.com/dongdongbh/Mindwtr.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'AuthenticationServices', 'Security', 'CryptoKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES', 'SWIFT_COMPILATION_MODE' => 'wholemodule' }
  s.source_files = 'ios/*.{h,m,swift}'
  s.exclude_files = 'ios/Package.swift'
end
