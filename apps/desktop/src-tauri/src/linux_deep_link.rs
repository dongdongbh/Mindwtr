use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use tauri::Manager;

fn desktop_exec(executable: &str) -> io::Result<String> {
    if executable.is_empty() || executable.contains('=') || executable.chars().any(char::is_control)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Invalid desktop executable",
        ));
    }
    // Desktop string escapes are decoded before Exec quoting; both layers must survive.
    let escaped = executable
        .replace('\\', "\\\\\\\\")
        .replace('"', "\\\\\"")
        .replace('$', "\\\\$")
        .replace('`', "\\\\`")
        .replace('%', "%%");
    // GIO validates Exec argv[0] before expanding %% into %. Keep that validation on
    // a fixed executable for percent-bearing paths; env receives the literal path
    // as one argument and launches it directly, without interpreting a shell.
    if executable.contains('%') {
        Ok(format!("env -- \"{escaped}\" %u"))
    } else {
        Ok(format!("\"{escaped}\" %u"))
    }
}

fn executable_in_path(name: &str, search_path: &std::ffi::OsStr) -> Option<PathBuf> {
    std::env::split_paths(search_path)
        .map(|directory| directory.join(name))
        .find(|path| {
            fs::metadata(path)
                .is_ok_and(|file| file.is_file() && file.permissions().mode() & 0o111 != 0)
        })
}

fn correct_handler(path: &Path, executable: &str) -> io::Result<()> {
    let command = desktop_exec(executable)?;
    if executable.contains('%') {
        // Desktop Exec resolves bare executables through PATH, including on NixOS
        // where /usr/bin/env is not part of the filesystem layout.
        if std::env::var_os("PATH")
            .and_then(|path| executable_in_path("env", &path))
            .is_none()
        {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "Desktop executable launcher unavailable",
            ));
        }
    }
    let contents = fs::read_to_string(path)?;
    let mut in_entry = false;
    let mut replaced = 0;
    let corrected = contents
        .lines()
        .map(|line| {
            if line.starts_with('[') {
                in_entry = line == "[Desktop Entry]";
            }
            if in_entry && line.starts_with("Exec=") {
                replaced += 1;
                format!("Exec={command}")
            } else {
                line.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    if replaced != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Invalid desktop handler",
        ));
    }
    if corrected == contents {
        return Ok(());
    }
    let mut file =
        tempfile::NamedTempFile::new_in(path.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
    file.write_all(corrected.as_bytes())?;
    file.persist(path).map_err(|error| error.error)?;
    Ok(())
}

// tauri-plugin-deep-link 2.4.6 generates an unquoted Linux Exec; retain its registration/delivery.
pub(crate) fn correct_registered_handler(app: &tauri::App) -> io::Result<()> {
    let bin = tauri::utils::platform::current_exe()?;
    let name = bin
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or(io::ErrorKind::InvalidInput)?;
    let handler = app
        .path()
        .data_dir()
        .map_err(io::Error::other)?
        .join("applications")
        .join(format!("{name}-handler.desktop"));
    let executable = app
        .env()
        .appimage
        .map(std::path::PathBuf::from)
        .unwrap_or(bin);
    correct_handler(
        &handler,
        executable.to_str().ok_or(io::ErrorKind::InvalidInput)?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_exec_quotes_and_escapes_the_executable_only() {
        assert_eq!(
            desktop_exec("/home/test/My App.AppImage").unwrap(),
            "\"/home/test/My App.AppImage\" %u"
        );
        assert_eq!(
            desktop_exec(r#"/home/test/a"b\c%d$e`f & ; app"#).unwrap(),
            r#"env -- "/home/test/a\\"b\\\\c%%d\\$e\\`f & ; app" %u"#
        );
        for invalid in ["", "/home/a=b", "/home/a\nb", "/home/a\rb"] {
            assert!(desktop_exec(invalid).is_err());
        }
    }

    #[test]
    fn launcher_lookup_requires_a_regular_executable_in_the_supplied_path() {
        let dir = tempfile::tempdir().unwrap();
        let search_path = std::env::join_paths([dir.path()]).unwrap();
        let launcher = dir.path().join("env");
        assert_eq!(executable_in_path("env", &search_path), None);
        fs::create_dir(&launcher).unwrap();
        assert_eq!(executable_in_path("env", &search_path), None);
        fs::remove_dir(&launcher).unwrap();
        fs::write(&launcher, b"fixture").unwrap();
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(executable_in_path("env", &search_path), None);
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(executable_in_path("env", &search_path), Some(launcher));
    }

    #[test]
    fn correct_handler_preserves_mime_and_other_sections_and_is_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("handler.desktop");
        fs::write(&path, "[Desktop Entry]\nName=Mindwtr\nExec=/home/test/My App %u\nMimeType=x-scheme-handler/mindwtr;\n[Desktop Action QuickAdd]\nExec=other --quick-add\n").unwrap();
        correct_handler(&path, "/home/test/My App").unwrap();
        let corrected = fs::read_to_string(&path).unwrap();
        assert!(corrected.contains("Exec=\"/home/test/My App\" %u\n"));
        assert!(corrected.contains("MimeType=x-scheme-handler/mindwtr;\n"));
        assert!(corrected.contains("[Desktop Action QuickAdd]\nExec=other --quick-add\n"));
        correct_handler(&path, "/home/test/My App").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), corrected);
    }

    #[test]
    fn corrected_handler_delivers_literal_path_and_uri_with_gio() {
        use std::os::unix::fs::PermissionsExt;
        use std::process::Command;
        if Command::new("gio").arg("version").output().is_err() {
            eprintln!("GIO launch regression unavailable: gio not installed");
            return;
        }
        let shell = executable_in_path("sh", &std::env::var_os("PATH").unwrap())
            .expect("GIO regression requires a POSIX shell in PATH");
        for name in [
            r#"app space"back\$dollar`tick;&"#,
            r#"app space"back\percent%u$dollar`tick;&"#,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let executable = dir.path().join(name);
            // Resolve the interpreter through the build's PATH. Nix supplies sh
            // in its store rather than /bin; printf is a shell builtin.
            fs::write(
                &executable,
                format!(
                    "#!{}\n: > \"${{0%/*}}/argv.bin\"\nsleep 0.05\nprintf '%s\\0' \"$@\" > \"${{0%/*}}/argv.bin\"\n",
                    shell.display()
                ),
            )
            .unwrap();
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
            let handler = dir.path().join("task-link.desktop");
            fs::write(
                &handler,
                "[Desktop Entry]\nType=Application\nName=Task link test\nExec=placeholder %u\n",
            )
            .unwrap();
            correct_handler(&handler, executable.to_str().unwrap()).unwrap();
            let uri = "mindwtr://open?task=a%20%26%22%5C%25&literal=$(touch%20nope)";
            assert!(Command::new("gio")
                .arg("launch")
                .arg(&handler)
                .arg(uri)
                .status()
                .unwrap()
                .success());
            let output = dir.path().join("argv.bin");
            let expected = [uri.as_bytes(), b"\0"].concat();
            // Creation precedes the child's write; wait for complete argv bytes.
            for _ in 0..100 {
                if fs::read(&output).is_ok_and(|bytes| bytes == expected) {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert_eq!(fs::read(output).unwrap(), expected);
        }
    }
}
