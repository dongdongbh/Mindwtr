require 'xcodeproj'

project = Xcodeproj::Project.open(ARGV.fetch(0))
app = project.targets.find { |target| target.name == 'MindwtrDev' }
abort 'Expected a generated MindwtrDev development project.' unless app

name = 'MindwtrReminderIntentsTests'
tests = project.targets.find { |target| target.name == name }
unless tests
  tests = project.new_target(:ui_test_bundle, name, :ios, '27.0')
  tests.add_dependency(app)
  source = project.main_group.new_file('../ios-app-intents/tests/MindwtrReminderIntentsTests.swift')
  tests.add_file_references([source])
end

tests.build_configurations.each do |configuration|
  configuration.build_settings.merge!(
    'PRODUCT_NAME' => name,
    'PRODUCT_BUNDLE_IDENTIFIER' => "tech.dongdongbh.mindwtr.dev.#{name}",
    'GENERATE_INFOPLIST_FILE' => 'YES',
    'SWIFT_VERSION' => '5.0',
    'TEST_TARGET_NAME' => app.name
  )
end
project.save

scheme = Xcodeproj::XCScheme.new
scheme.configure_with_targets(app, tests, launch_target: false)
scheme.test_action.build_configuration = 'Release'
scheme.save_as(project.path, name, true)
