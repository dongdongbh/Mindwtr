fn main() {
  #[cfg(target_os = "macos")]
  {
    cc::Build::new()
      .file("src/macos_eventkit_bridge.m")
      .flag("-fobjc-arc")
      .compile("mindwtr_macos_eventkit_bridge");
    cc::Build::new()
      .file("src/macos_sandbox_bridge.m")
      .flag("-fobjc-arc")
      .compile("mindwtr_macos_sandbox_bridge");
    cc::Build::new()
      .file("src/macos_cloudkit_bridge.m")
      .flag("-fobjc-arc")
      .compile("mindwtr_macos_cloudkit_bridge");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=EventKit");
    println!("cargo:rustc-link-lib=framework=CloudKit");
    println!("cargo:rerun-if-changed=src/macos_eventkit_bridge.m");
    println!("cargo:rerun-if-changed=src/macos_sandbox_bridge.m");
    println!("cargo:rerun-if-changed=src/macos_cloudkit_bridge.m");
  }

  tauri_build::build()
}
