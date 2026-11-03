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
        cc::Build::new()
            .file("src/macos_quick_add_focus_bridge.m")
            .flag("-fobjc-arc")
            .compile("mindwtr_macos_quick_add_focus_bridge");
        cc::Build::new()
            .file("src/macos_renderer_recovery_bridge.m")
            .flag("-fobjc-arc")
            .compile("mindwtr_macos_renderer_recovery_bridge");
        cc::Build::new()
            .file("src/macos_widget_bridge.m")
            .flag("-fobjc-arc")
            .compile("mindwtr_macos_widget_bridge");
        cc::Build::new()
            .file("src/macos_notification_bridge.m")
            .flag("-fobjc-arc")
            .compile("mindwtr_macos_notification_bridge");
        cc::Build::new()
            .file("src/macos_app_lock_bridge.m")
            .flag("-fobjc-arc")
            .compile("mindwtr_macos_app_lock_bridge");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=UserNotifications");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=EventKit");
        println!("cargo:rustc-link-lib=framework=CloudKit");
        println!("cargo:rustc-link-lib=framework=WebKit");
        println!("cargo:rustc-link-lib=framework=LocalAuthentication");
        println!("cargo:rerun-if-changed=src/macos_eventkit_bridge.m");
        println!("cargo:rerun-if-changed=src/macos_sandbox_bridge.m");
        println!("cargo:rerun-if-changed=src/macos_cloudkit_bridge.m");
        println!("cargo:rerun-if-changed=src/macos_quick_add_focus_bridge.m");
        println!("cargo:rerun-if-changed=src/macos_renderer_recovery_bridge.m");
        println!("cargo:rerun-if-changed=src/macos_widget_bridge.m");
        println!("cargo:rerun-if-changed=src/macos_notification_bridge.m");
        println!("cargo:rerun-if-changed=src/macos_app_lock_bridge.m");

        let team_id = std::env::var("APPLE_TEAM_ID").unwrap_or_default();
        let app_group = if team_id.trim().is_empty() {
            "DEVTEAM.tech.dongdongbh.mindwtr".to_string()
        } else {
            format!("{}.tech.dongdongbh.mindwtr", team_id.trim())
        };
        println!("cargo:rustc-env=MINDWTR_MACOS_APP_GROUP={app_group}");
        println!("cargo:rerun-if-env-changed=APPLE_TEAM_ID");

        let target_arch = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
        let swift_arch = match target_arch.as_str() {
            "aarch64" => "arm64",
            other => other,
        };
        let sdk_path = std::process::Command::new("xcrun")
            .args(["--sdk", "macosx", "--show-sdk-path"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string());
        let swiftc_path = std::process::Command::new("xcrun")
            .args(["--find", "swiftc"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| std::path::PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()));
        let swift_runtime_path = swiftc_path.as_ref().and_then(|path| {
            path.parent()
                .and_then(std::path::Path::parent)
                .map(|usr| usr.join("lib/swift/macosx"))
        });

        let out_dir = std::env::var("OUT_DIR").expect("OUT_DIR is set by cargo");
        let reload_lib_path = format!("{out_dir}/libmindwtr_widget_reload.a");
        let mut swiftc_args: Vec<String> = vec![
            "-emit-library".into(),
            "-static".into(),
            "-module-name".into(),
            "MindwtrWidgetReload".into(),
            "-target".into(),
            format!("{swift_arch}-apple-macos11"),
        ];
        if let Some(sdk) = sdk_path {
            swiftc_args.push("-sdk".into());
            swiftc_args.push(sdk);
        }
        swiftc_args.push("-o".into());
        swiftc_args.push(reload_lib_path);
        swiftc_args.push("src/macos_widget_reload.swift".into());

        let swiftc = swiftc_path
            .as_deref()
            .unwrap_or_else(|| std::path::Path::new("swiftc"));
        let swiftc_ok = std::process::Command::new(swiftc)
            .args(&swiftc_args)
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if swiftc_ok {
            println!("cargo:rustc-link-search=native={out_dir}");
            let swift_runtime_path = swift_runtime_path
                .filter(|path| path.is_dir())
                .unwrap_or_else(|| {
                    panic!(
                        "could not locate the macOS Swift runtime libraries beside {}",
                        swiftc.display()
                    )
                });

            println!(
                "cargo:rustc-link-search=native={}",
                swift_runtime_path.display()
            );
            println!("cargo:rustc-link-lib=static=mindwtr_widget_reload");

            println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

            println!("cargo:rustc-link-arg=-weak_framework");
            println!("cargo:rustc-link-arg=WidgetKit");
        } else {
            let profile = std::env::var("PROFILE").unwrap_or_default();
            let stub_allowed = profile == "debug"
                || std::env::var("MINDWTR_ALLOW_WIDGET_RELOAD_STUB").as_deref() == Ok("1");
            if !stub_allowed {
                panic!(
                    "swiftc failed to build the macOS widget timeline-reload shim in a release \
                     build (#1054). Set MINDWTR_ALLOW_WIDGET_RELOAD_STUB=1 to allow a no-op stub \
                     deliberately; debug builds allow it automatically."
                );
            }
            println!(
                "cargo:warning=swiftc unavailable or failed; macOS widget timeline reload will no-op (#1054)"
            );
            let stub_path = format!("{out_dir}/macos_widget_reload_stub.c");
            std::fs::write(&stub_path, "void mindwtr_reload_widgets(void) {}\n")
                .expect("should write widget reload stub");
            cc::Build::new()
                .file(&stub_path)
                .compile("mindwtr_widget_reload_stub");
        }
        println!("cargo:rerun-if-changed=src/macos_widget_reload.swift");
    }

    tauri_build::build()
}
