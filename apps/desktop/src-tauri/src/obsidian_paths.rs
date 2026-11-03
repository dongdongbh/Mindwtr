use std::path::{Path, PathBuf};

pub(crate) const DEFAULT_OBSIDIAN_INBOX_FILE: &str = "Mindwtr/Inbox.md";

pub(crate) fn default_obsidian_inbox_file() -> String {
    DEFAULT_OBSIDIAN_INBOX_FILE.to_string()
}

pub(crate) fn normalize_obsidian_relative_path(value: &str) -> Result<String, String> {
    let normalized = value.trim().replace('\\', "/");
    if normalized.is_empty() {
        return Ok(String::new());
    }
    if normalized.starts_with('/') {
        return Err("Obsidian relative paths cannot be absolute.".to_string());
    }
    let mut chars = normalized.chars();
    if matches!(
        (chars.next(), chars.next()),
        (Some(first), Some(':')) if first.is_ascii_alphabetic()
    ) {
        return Err("Obsidian relative paths cannot include drive prefixes.".to_string());
    }

    let mut segments: Vec<String> = Vec::new();
    for raw_segment in normalized.split('/') {
        let segment = raw_segment.trim();
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            return Err("Obsidian relative paths cannot contain parent traversal.".to_string());
        }
        segments.push(segment.to_string());
    }

    Ok(segments.join("/"))
}

pub(crate) fn normalize_obsidian_inbox_file(value: &str) -> String {
    normalize_obsidian_relative_path(value)
        .ok()
        .filter(|path| !path.is_empty())
        .unwrap_or_else(default_obsidian_inbox_file)
}

pub(crate) fn should_skip_obsidian_segment(name: &str) -> bool {
    if name.is_empty() {
        return true;
    }
    if name == ".obsidian" || name == ".trash" || name == "node_modules" {
        return true;
    }
    name.starts_with('.')
}

pub(crate) fn should_skip_obsidian_relative_path(relative_path: &str) -> bool {
    let Ok(normalized) = normalize_obsidian_relative_path(relative_path) else {
        return true;
    };
    normalized
        .split('/')
        .map(str::trim)
        .filter(|segment| !segment.is_empty())
        .any(should_skip_obsidian_segment)
}

pub(crate) fn is_obsidian_markdown_relative_path(relative_path: &str) -> bool {
    let Ok(normalized) = normalize_obsidian_relative_path(relative_path) else {
        return false;
    };
    normalized.to_ascii_lowercase().ends_with(".md")
}

pub(crate) fn join_obsidian_vault_path(
    vault_path: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let trimmed_vault = vault_path.trim();
    if trimmed_vault.is_empty() {
        return Err("Obsidian vault path is not configured.".to_string());
    }
    let normalized_relative = normalize_obsidian_relative_path(relative_path)?;
    if normalized_relative.is_empty() {
        return Err("Obsidian file path is not configured.".to_string());
    }
    let joined = Path::new(trimmed_vault).join(Path::new(&normalized_relative));
    assert_inside_obsidian_vault(trimmed_vault, &joined)?;
    Ok(joined)
}

fn assert_inside_obsidian_vault(vault_path: &str, joined: &Path) -> Result<(), String> {
    let vault_root = Path::new(vault_path)
        .canonicalize()
        .map_err(|error| format!("Failed to resolve the Obsidian vault path: {error}"))?;
    let mut candidate = joined;
    let resolved = loop {
        if let Ok(resolved) = candidate.canonicalize() {
            break resolved;
        }
        match candidate.parent() {
            Some(parent) => candidate = parent,
            None => return Err("Failed to resolve the Obsidian file path.".to_string()),
        }
    };
    if resolved.starts_with(&vault_root) {
        Ok(())
    } else {
        Err("Obsidian file paths must stay inside the configured vault.".to_string())
    }
}

pub(crate) fn matches_configured_vault_path(configured: Option<&str>, requested: &str) -> bool {
    let Some(configured) = configured.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    let requested = requested.trim();
    if requested.is_empty() {
        return false;
    }
    normalize_filesystem_path(Path::new(configured)) == normalize_filesystem_path(Path::new(requested))
}

pub(crate) fn normalize_filesystem_path(path: &Path) -> String {
    let raw = path.to_string_lossy().replace('\\', "/");
    if raw.len() > 1 {
        raw.trim_end_matches('/').to_string()
    } else {
        raw
    }
}

pub(crate) fn relative_obsidian_path_from_absolute(
    vault_root: &Path,
    candidate_path: &Path,
) -> Option<String> {
    let base = normalize_filesystem_path(vault_root);
    let candidate = normalize_filesystem_path(candidate_path);
    if candidate == base {
        return None;
    }
    let prefix = format!("{base}/");
    if !candidate.starts_with(&prefix) {
        return None;
    }
    normalize_obsidian_relative_path(&candidate[prefix.len()..])
        .ok()
        .filter(|path| !path.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_obsidian_relative_paths() {
        assert_eq!(
            normalize_obsidian_relative_path(r" Projects\Alpha.md ").unwrap(),
            "Projects/Alpha.md"
        );
        assert!(normalize_obsidian_relative_path("/tmp/Alpha.md").is_err());
        assert!(normalize_obsidian_relative_path("../Alpha.md").is_err());
    }

    #[test]
    fn identifies_hidden_obsidian_paths() {
        assert!(should_skip_obsidian_relative_path(".obsidian/config.md"));
        assert!(should_skip_obsidian_relative_path(".trash/Deleted.md"));
        assert!(should_skip_obsidian_relative_path("Projects/.hidden.md"));
        assert!(!should_skip_obsidian_relative_path("Projects/Alpha.md"));
    }

    #[test]
    fn rejects_joined_paths_that_resolve_outside_the_vault() {
        let temp = tempfile::tempdir().expect("should create temp dir");
        let vault = temp.path().join("Vault");
        let outside = temp.path().join("Outside");
        std::fs::create_dir_all(vault.join("Projects")).expect("should create vault folders");
        std::fs::create_dir_all(&outside).expect("should create outside folder");
        std::fs::write(outside.join("Secret.md"), "secret").expect("should create outside note");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, vault.join("Escape")).expect("should link out");
        #[cfg(windows)]
        std::os::windows::fs::symlink_dir(&outside, vault.join("Escape")).expect("should link out");

        let vault_path = vault.to_string_lossy().to_string();
        assert!(join_obsidian_vault_path(&vault_path, "Projects/Alpha.md").is_ok());

        let error = join_obsidian_vault_path(&vault_path, "Escape/Secret.md")
            .expect_err("should reject a symlinked escape");
        assert!(error.contains("must stay inside the configured vault"));
    }

    #[test]
    fn only_accepts_the_configured_vault_path() {
        assert!(matches_configured_vault_path(Some("/home/u/Vault"), "/home/u/Vault"));
        assert!(matches_configured_vault_path(
            Some("/home/u/Vault/"),
            " /home/u/Vault "
        ));
        assert!(!matches_configured_vault_path(
            Some("/home/u/Vault"),
            "/home/u/Vault/Nested"
        ));
        assert!(!matches_configured_vault_path(Some("/home/u/Vault"), "/etc"));
        assert!(!matches_configured_vault_path(None, "/home/u/Vault"));
        assert!(!matches_configured_vault_path(Some(""), ""));
    }

    #[test]
    fn resolves_relative_obsidian_paths_from_absolute_paths() {
        let vault = Path::new("/tmp/Vault");
        let file = Path::new("/tmp/Vault/Projects/Alpha.md");
        assert_eq!(
            relative_obsidian_path_from_absolute(vault, file).as_deref(),
            Some("Projects/Alpha.md")
        );
        assert_eq!(
            relative_obsidian_path_from_absolute(vault, Path::new("/tmp/Other/Alpha.md")),
            None
        );
    }
}
