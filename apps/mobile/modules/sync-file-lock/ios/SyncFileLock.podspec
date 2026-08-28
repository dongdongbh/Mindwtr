Pod::Spec.new do |s|
  s.name = 'SyncFileLock'
  s.version = '1.0.0'
  s.summary = 'Mindwtr stable File Sync lease authority'
  s.description = 'Cross-process File Sync locking bound to retained sync-root and legacy lock identities.'
  s.homepage = 'https://github.com/dongdongbh/Mindwtr'
  s.license = { type: 'AGPL-3.0-only' }
  s.author = { 'Mindwtr' => 'dongdongli@dongdongli.com' }
  s.platform = :ios, '15.1'
  s.swift_version = '5.0'
  s.source = { git: 'https://github.com/dongdongbh/Mindwtr.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = 'SyncFileLockModule.swift'
end
