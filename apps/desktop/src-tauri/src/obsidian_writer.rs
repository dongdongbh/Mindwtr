use crate::config::assert_configured_obsidian_vault;
use crate::obsidian_paths::{
    is_obsidian_markdown_relative_path, join_obsidian_vault_path, normalize_obsidian_relative_path,
};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use tempfile::{Builder, NamedTempFile};
use time::{format_description, OffsetDateTime};

#[derive(Clone, Debug, PartialEq, Eq)]
struct LineRecord {
    content: String,
    ending: String,
}

fn split_lines_preserving_endings(input: &str) -> Vec<LineRecord> {
    if input.is_empty() {
        return Vec::new();
    }

    let bytes = input.as_bytes();
    let mut start = 0;
    let mut lines: Vec<LineRecord> = Vec::new();

    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        let (content_end, ending) = if index > 0 && bytes[index - 1] == b'\r' {
            (index - 1, "\r\n")
        } else {
            (index, "\n")
        };
        lines.push(LineRecord {
            content: input[start..content_end].to_string(),
            ending: ending.to_string(),
        });
        start = index + 1;
    }

    if start < input.len() {
        lines.push(LineRecord {
            content: input[start..].to_string(),
            ending: String::new(),
        });
    }

    lines
}

fn rebuild_lines(lines: &[LineRecord]) -> String {
    let mut rebuilt = String::new();
    for line in lines {
        rebuilt.push_str(&line.content);
        rebuilt.push_str(&line.ending);
    }
    rebuilt
}

fn checkbox_index(line: &str) -> Option<(usize, char, usize)> {
    let bytes = line.as_bytes();
    let mut index = 0;

    while index < bytes.len() && matches!(bytes[index], b' ' | b'\t') {
        index += 1;
    }
    if index >= bytes.len() || !matches!(bytes[index], b'-' | b'*' | b'+') {
        return None;
    }
    index += 1;

    let mut gap_after_bullet = 0;
    while index < bytes.len() && matches!(bytes[index], b' ' | b'\t') {
        gap_after_bullet += 1;
        index += 1;
    }
    if gap_after_bullet == 0
        || index + 2 >= bytes.len()
        || bytes[index] != b'['
        || bytes[index + 2] != b']'
    {
        return None;
    }

    let marker = bytes[index + 1] as char;
    if !matches!(marker, ' ' | 'x' | 'X') {
        return None;
    }

    let mut text_start = index + 3;
    let mut gap_after_checkbox = 0;
    while text_start < bytes.len() && matches!(bytes[text_start], b' ' | b'\t') {
        gap_after_checkbox += 1;
        text_start += 1;
    }
    if gap_after_checkbox == 0 {
        return None;
    }

    Some((index + 1, marker, text_start))
}

fn extract_task_text(line: &str) -> Option<&str> {
    let (_, _, text_start) = checkbox_index(line)?;
    Some(&line[text_start..])
}

fn toggle_task_line(line: &str, set_completed: bool) -> Result<String, String> {
    let Some((checkbox_idx, marker, _)) = checkbox_index(line) else {
        return Err("The selected line is not a Markdown task.".to_string());
    };

    if set_completed && marker != ' ' {
        return Err("Expected an unchecked task before marking it complete.".to_string());
    }
    if !set_completed && !matches!(marker, 'x' | 'X') {
        return Err("Expected a checked task before marking it incomplete.".to_string());
    }

    let next_marker = if set_completed { 'x' } else { ' ' };
    let mut updated = String::with_capacity(line.len());
    updated.push_str(&line[..checkbox_idx]);
    updated.push(next_marker);
    updated.push_str(&line[checkbox_idx + 1..]);
    Ok(updated)
}

fn find_task_line(
    lines: &[LineRecord],
    expected_line: usize,
    task_text: &str,
) -> Result<usize, String> {
    if expected_line > 0 && expected_line <= lines.len() {
        if extract_task_text(&lines[expected_line - 1].content) == Some(task_text) {
            return Ok(expected_line);
        }
    }

    let matches = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| {
            (extract_task_text(&line.content) == Some(task_text)).then_some(index + 1)
        })
        .collect::<Vec<_>>();

    match matches.as_slice() {
        [line_number] => Ok(*line_number),
        [] => Err("Task not found in the note. Try rescanning the vault.".to_string()),
        _ => Err(
            "Multiple matching tasks were found in the note. Try rescanning the vault.".to_string(),
        ),
    }
}

fn detect_line_ending(input: &str) -> &'static str {
    if input.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

fn atomic_write_text(path: &Path, content: &str) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Err("Failed to resolve the Obsidian file parent directory.".to_string());
    };
    fs::create_dir_all(parent)
        .map_err(|error| format!("Failed to prepare the Obsidian folder: {error}"))?;

    let metadata = fs::metadata(path).ok();
    let mut temp_file = Builder::new()
        .prefix(".mindwtr-obsidian-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|error| format!("Failed to create a temporary Obsidian file: {error}"))?;

    temp_file
        .write_all(content.as_bytes())
        .map_err(|error| format!("Failed to write Obsidian file changes: {error}"))?;
    temp_file
        .as_file()
        .sync_all()
        .map_err(|error| format!("Failed to flush Obsidian file changes: {error}"))?;

    if let Some(existing_metadata) = metadata {
        let _ = fs::set_permissions(temp_file.path(), existing_metadata.permissions());
    }

    persist_over_existing(temp_file, path)
}

// `persist` replaces an existing file atomically on every platform Mindwtr
// ships on (Windows goes through MoveFileEx with MOVEFILE_REPLACE_EXISTING),
// so there is nothing to delete up front — this used to remove the note before
// persisting on Windows, which destroyed it outright whenever the persist and
// the copy fallback both failed.
fn persist_over_existing(temp_file: NamedTempFile, path: &Path) -> Result<(), String> {
    let first = match temp_file.persist(path) {
        Ok(_) => return Ok(()),
        Err(error) => error,
    };

    // The replacement could not land. Move the original aside — never delete
    // it — so the retries below get a free destination and a replacement that
    // still fails can be rolled back. A folder that rejects the rename falls
    // through to the same in-place copy as before: no worse than the old
    // fallback, and still the only way to update such a note.
    let aside = path
        .file_name()
        // Dot-prefixed so a leftover copy is skipped by the vault scanner.
        .map(|name| path.with_file_name(format!(".{}.mindwtr-old", name.to_string_lossy())));
    let moved_aside = path.exists()
        && aside.as_ref().is_some_and(|aside| {
            let _ = fs::remove_file(aside);
            fs::rename(path, aside).is_ok()
        });

    let outcome = match first.file.persist(path) {
        Ok(_) => Ok(()),
        Err(second) => {
            let temp_path = second.file.path().to_path_buf();
            fs::copy(&temp_path, path)
                .map(|_| {
                    let _ = fs::remove_file(&temp_path);
                })
                .map_err(|copy_error| {
                    format!(
                        "Failed to replace the Obsidian file: {}, {copy_error}",
                        second.error
                    )
                })
        }
    };

    if let Some(aside) = aside.filter(|_| moved_aside) {
        if outcome.is_ok() {
            let _ = fs::remove_file(&aside);
        } else {
            let _ = fs::rename(&aside, path);
        }
    }
    outcome
}

fn is_frontmatter_boundary(line: &str) -> bool {
    line.trim() == "---"
}

fn find_frontmatter_range(lines: &[LineRecord]) -> Option<(usize, usize)> {
    if !matches!(lines.first(), Some(first) if is_frontmatter_boundary(&first.content)) {
        return None;
    }

    for (index, line) in lines.iter().enumerate().skip(1) {
        if is_frontmatter_boundary(&line.content) {
            return Some((0, index));
        }
    }

    None
}

fn find_frontmatter_field_line(
    lines: &[LineRecord],
    frontmatter_start: usize,
    frontmatter_end: usize,
    field: &str,
) -> Option<usize> {
    let prefix = format!("{field}:");
    lines
        .iter()
        .enumerate()
        .skip(frontmatter_start + 1)
        .take(frontmatter_end.saturating_sub(frontmatter_start + 1))
        .find_map(|(index, line)| {
            line.content
                .trim_start()
                .starts_with(&prefix)
                .then_some(index)
        })
}

fn split_yaml_comment(input: &str) -> (&str, &str) {
    let mut in_single_quote = false;
    let mut in_double_quote = false;
    let mut previous_was_whitespace = true;

    for (index, ch) in input.char_indices() {
        match ch {
            '\'' if !in_double_quote => in_single_quote = !in_single_quote,
            '"' if !in_single_quote => in_double_quote = !in_double_quote,
            '#' if !in_single_quote && !in_double_quote && previous_was_whitespace => {
                return (input[..index].trim_end(), &input[index..]);
            }
            _ => {}
        }
        previous_was_whitespace = ch.is_whitespace();
    }

    (input.trim_end(), "")
}

fn replace_frontmatter_scalar_line(line: &str, field: &str, new_value: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let prefix = format!("{field}:");
    if !trimmed.starts_with(&prefix) {
        return None;
    }

    let indent = &line[..line.len() - trimmed.len()];
    let remainder = &trimmed[prefix.len()..];
    let (_, comment) = split_yaml_comment(remainder);
    let suffix = if comment.is_empty() {
        String::new()
    } else {
        format!(" {comment}")
    };

    Some(format!("{indent}{field}: {new_value}{suffix}"))
}

fn replace_frontmatter_scalar_field(
    lines: &mut [LineRecord],
    frontmatter_start: usize,
    frontmatter_end: usize,
    field: &str,
    new_value: &str,
) -> Result<(), String> {
    let index = find_frontmatter_field_line(lines, frontmatter_start, frontmatter_end, field)
        .ok_or_else(|| format!("Field '{field}' was not found in the TaskNotes frontmatter."))?;
    let updated = replace_frontmatter_scalar_line(&lines[index].content, field, new_value)
        .ok_or_else(|| format!("Field '{field}' could not be updated."))?;
    lines[index].content = updated;
    Ok(())
}

fn upsert_frontmatter_scalar_field(
    lines: &mut Vec<LineRecord>,
    frontmatter_start: usize,
    frontmatter_end: usize,
    field: &str,
    new_value: &str,
    line_ending: &str,
) -> Result<(), String> {
    if let Some(index) =
        find_frontmatter_field_line(lines, frontmatter_start, frontmatter_end, field)
    {
        let updated = replace_frontmatter_scalar_line(&lines[index].content, field, new_value)
            .ok_or_else(|| format!("Field '{field}' could not be updated."))?;
        lines[index].content = updated;
        return Ok(());
    }

    lines.insert(
        frontmatter_end,
        LineRecord {
            content: format!("{field}: {new_value}"),
            ending: line_ending.to_string(),
        },
    );
    Ok(())
}

fn remove_frontmatter_field(
    lines: &mut Vec<LineRecord>,
    frontmatter_start: usize,
    frontmatter_end: usize,
    field: &str,
) {
    if let Some(index) =
        find_frontmatter_field_line(lines, frontmatter_start, frontmatter_end, field)
    {
        lines.remove(index);
    }
}

fn current_yyyy_mm_dd() -> Result<String, String> {
    let format = format_description::parse("[year]-[month]-[day]")
        .map_err(|error| format!("Failed to prepare date formatter: {error}"))?;
    OffsetDateTime::now_utc()
        .format(&format)
        .map_err(|error| format!("Failed to format the completion date: {error}"))
}

fn sanitize_tasknotes_filename(title: &str) -> String {
    let filtered = title
        .chars()
        .filter(|ch| !matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect::<String>();
    filtered
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_matches('.')
        .trim()
        .to_string()
}

fn escape_yaml_double_quoted(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn build_tasknotes_content(title: &str, line_ending: &str) -> String {
    [
        "---".to_string(),
        "tags:".to_string(),
        "  - task".to_string(),
        format!("title: \"{}\"", escape_yaml_double_quoted(title)),
        "status: open".to_string(),
        "---".to_string(),
        String::new(),
    ]
    .join(line_ending)
}

// Every write below is a read-modify-write against a file in the user's vault,
// and `obsidian_create_tasknotes` also picks a filename it then creates. The
// main thread used to serialize them for free; now that they run off the UI
// thread, two toggles in the same note would each read the same content and
// write back only their own edit, losing the other one in the user's notes.
// ponytail: one global lock, so a write to note A waits on an unrelated write
// to note B. These are single user-initiated actions with no bulk caller, so
// the wait is one file write; make it a per-path lock map if a bulk path lands.
static VAULT_WRITE_MUTEX: Mutex<()> = Mutex::new(());

fn lock_vault_write() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    VAULT_WRITE_MUTEX
        .lock()
        .map_err(|_| "Obsidian vault write lock is unavailable".to_string())
}

// Off the UI thread: a vault on a network share or a FUSE mount makes this
// read plus atomic write block for as long as the mount takes to answer.
#[tauri::command(async)]
pub(crate) fn obsidian_toggle_task(
    app: tauri::AppHandle,
    vault_path: String,
    relative_file_path: String,
    line_number: usize,
    task_text: String,
    set_completed: bool,
) -> Result<(), String> {
    assert_configured_obsidian_vault(&app, &vault_path)?;
    toggle_task_in_vault(
        &vault_path,
        &relative_file_path,
        line_number,
        &task_text,
        set_completed,
    )
}

fn toggle_task_in_vault(
    vault_path: &str,
    relative_file_path: &str,
    line_number: usize,
    task_text: &str,
    set_completed: bool,
) -> Result<(), String> {
    let _vault_guard = lock_vault_write()?;
    let normalized_relative_path = normalize_obsidian_relative_path(relative_file_path)?;
    if !is_obsidian_markdown_relative_path(&normalized_relative_path) {
        return Err("Obsidian tasks can only be updated in Markdown files.".to_string());
    }

    let absolute_path = join_obsidian_vault_path(vault_path, &normalized_relative_path)?;
    let content = fs::read_to_string(&absolute_path)
        .map_err(|error| format!("Failed to read the Obsidian note: {error}"))?;
    let mut lines = split_lines_preserving_endings(&content);
    let actual_line = find_task_line(&lines, line_number, task_text)?;
    let current = lines
        .get(actual_line - 1)
        .map(|line| line.content.as_str())
        .ok_or_else(|| "Task line is out of bounds.".to_string())?;
    let updated_line = toggle_task_line(current, set_completed)?;
    lines[actual_line - 1].content = updated_line;

    atomic_write_text(&absolute_path, &rebuild_lines(&lines))
}

// Off the UI thread, and serialized, for the same reasons as
// `obsidian_toggle_task`.
#[tauri::command(async)]
pub(crate) fn obsidian_toggle_tasknotes(
    app: tauri::AppHandle,
    vault_path: String,
    relative_file_path: String,
    set_completed: bool,
) -> Result<(), String> {
    assert_configured_obsidian_vault(&app, &vault_path)?;
    toggle_tasknotes_in_vault(&vault_path, &relative_file_path, set_completed)
}

fn toggle_tasknotes_in_vault(
    vault_path: &str,
    relative_file_path: &str,
    set_completed: bool,
) -> Result<(), String> {
    let _vault_guard = lock_vault_write()?;
    let normalized_relative_path = normalize_obsidian_relative_path(relative_file_path)?;
    if !is_obsidian_markdown_relative_path(&normalized_relative_path) {
        return Err("TaskNotes files must be Markdown files ending in .md.".to_string());
    }

    let absolute_path = join_obsidian_vault_path(vault_path, &normalized_relative_path)?;
    let content = fs::read_to_string(&absolute_path)
        .map_err(|error| format!("Failed to read the TaskNotes file: {error}"))?;
    let line_ending = detect_line_ending(&content);
    let mut lines = split_lines_preserving_endings(&content);
    let (frontmatter_start, frontmatter_end) = find_frontmatter_range(&lines)
        .ok_or_else(|| "TaskNotes files must start with YAML frontmatter.".to_string())?;

    replace_frontmatter_scalar_field(
        &mut lines,
        frontmatter_start,
        frontmatter_end,
        "status",
        if set_completed { "done" } else { "open" },
    )?;

    if set_completed {
        let completed_date = current_yyyy_mm_dd()?;
        upsert_frontmatter_scalar_field(
            &mut lines,
            frontmatter_start,
            frontmatter_end,
            "completedDate",
            &completed_date,
            line_ending,
        )?;
    } else {
        remove_frontmatter_field(
            &mut lines,
            frontmatter_start,
            frontmatter_end,
            "completedDate",
        );
    }

    atomic_write_text(&absolute_path, &rebuild_lines(&lines))
}

// Off the UI thread, and serialized: two captures into the same inbox note
// would otherwise each append to the content the other one read.
#[tauri::command(async)]
pub(crate) fn obsidian_create_task(
    app: tauri::AppHandle,
    vault_path: String,
    relative_file_path: String,
    task_text: String,
) -> Result<(), String> {
    assert_configured_obsidian_vault(&app, &vault_path)?;
    create_task_in_vault(&vault_path, &relative_file_path, &task_text)
}

fn create_task_in_vault(
    vault_path: &str,
    relative_file_path: &str,
    task_text: &str,
) -> Result<(), String> {
    let _vault_guard = lock_vault_write()?;
    let normalized_relative_path = normalize_obsidian_relative_path(relative_file_path)?;
    if normalized_relative_path.is_empty() {
        return Err("Choose an Obsidian inbox note before creating a task.".to_string());
    }
    if !is_obsidian_markdown_relative_path(&normalized_relative_path) {
        return Err("Obsidian inbox notes must be Markdown files ending in .md.".to_string());
    }

    let trimmed_task_text = task_text.trim();
    if trimmed_task_text.is_empty() {
        return Err("Enter a task title before adding it to Obsidian.".to_string());
    }

    let absolute_path = join_obsidian_vault_path(vault_path, &normalized_relative_path)?;
    let existing_content = match fs::read_to_string(&absolute_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(error) => return Err(format!("Failed to read the Obsidian inbox note: {error}")),
    };

    let line_ending = detect_line_ending(&existing_content);
    let next_content = if existing_content.is_empty() {
        format!("- [ ] {trimmed_task_text}{line_ending}")
    } else if existing_content.ends_with('\n') {
        format!("{existing_content}- [ ] {trimmed_task_text}{line_ending}")
    } else {
        format!("{existing_content}{line_ending}- [ ] {trimmed_task_text}{line_ending}")
    };

    atomic_write_text(&absolute_path, &next_content)
}

// Off the UI thread, and serialized across the whole body: the guard has to
// span the `exists()` check AND the write, or two creations from the same title
// in the same second both see a free filename and one overwrites the other.
#[tauri::command(async)]
pub(crate) fn obsidian_create_tasknotes(
    app: tauri::AppHandle,
    vault_path: String,
    folder: String,
    title: String,
) -> Result<String, String> {
    assert_configured_obsidian_vault(&app, &vault_path)?;
    create_tasknotes_in_vault(&vault_path, &folder, &title)
}

fn create_tasknotes_in_vault(
    vault_path: &str,
    folder: &str,
    title: &str,
) -> Result<String, String> {
    let _vault_guard = lock_vault_write()?;
    let normalized_folder = normalize_obsidian_relative_path(folder)?;
    if normalized_folder.is_empty() {
        return Err("Choose a TaskNotes folder before creating a task.".to_string());
    }

    let trimmed_title = title.trim();
    if trimmed_title.is_empty() {
        return Err("Enter a task title before adding it to Obsidian.".to_string());
    }

    let safe_filename = sanitize_tasknotes_filename(trimmed_title);
    if safe_filename.is_empty() {
        return Err("Could not generate a valid TaskNotes filename from that title.".to_string());
    }

    let mut relative_path = format!("{normalized_folder}/{safe_filename}.md");
    let mut absolute_path = join_obsidian_vault_path(vault_path, &relative_path)?;

    if absolute_path.exists() {
        let suffix = OffsetDateTime::now_utc().unix_timestamp();
        relative_path = format!("{normalized_folder}/{safe_filename} {suffix}.md");
        absolute_path = join_obsidian_vault_path(vault_path, &relative_path)?;
    }

    let content = build_tasknotes_content(trimmed_title, "\n");
    atomic_write_text(&absolute_path, &content)?;
    Ok(relative_path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    // A temp file on a filesystem other than the vault's, so `persist` fails
    // with a real cross-device error instead of a simulated one. Returns None
    // when the two paths turn out to share a device, so the test degrades to a
    // no-op rather than asserting on a persist that quietly succeeded.
    #[cfg(target_os = "linux")]
    fn cross_device_temp_file(vault_dir: &Path, content: &str) -> Option<NamedTempFile> {
        use std::os::unix::fs::MetadataExt;

        let other_root = Path::new("/dev/shm");
        if fs::metadata(other_root).ok()?.dev() == fs::metadata(vault_dir).ok()?.dev() {
            return None;
        }
        let mut file = Builder::new().tempfile_in(other_root).ok()?;
        file.write_all(content.as_bytes()).ok()?;
        Some(file)
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn replacement_lands_by_moving_a_locked_original_aside() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempdir().expect("should create temp vault");
        let note = temp.path().join("Note.md");
        fs::write(&note, "original").expect("should create note");
        fs::set_permissions(&note, fs::Permissions::from_mode(0o444))
            .expect("should make the note read-only");

        let Some(replacement) = cross_device_temp_file(temp.path(), "replacement") else {
            return;
        };

        persist_over_existing(replacement, &note).expect("should replace the note");

        assert_eq!(
            fs::read_to_string(&note).expect("should read the note"),
            "replacement"
        );
        assert!(!temp.path().join(".Note.md.mindwtr-old").exists());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn replacement_that_cannot_land_leaves_the_original_note_intact() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempdir().expect("should create temp vault");
        let note = temp.path().join("Note.md");
        fs::write(&note, "original").expect("should create note");

        let Some(replacement) = cross_device_temp_file(temp.path(), "replacement") else {
            return;
        };
        // Unreadable source: the cross-device persist fails, and so does the
        // copy fallback, after the original has already been moved aside.
        fs::set_permissions(replacement.path(), fs::Permissions::from_mode(0o000))
            .expect("should make the replacement unreadable");

        let error =
            persist_over_existing(replacement, &note).expect_err("should refuse to replace");

        assert!(error.contains("Failed to replace the Obsidian file"));
        assert_eq!(
            fs::read_to_string(&note).expect("should read the note"),
            "original"
        );
        assert!(!temp.path().join(".Note.md.mindwtr-old").exists());
    }

    #[test]
    fn toggle_filtered_task_preserves_other_checkboxes_and_marker() {
        let temp = tempdir().unwrap();
        let path = temp.path().join("Inbox.md");
        let markdown = "---\ntags: [task]\n---\n- [ ] Checklist\n- [ ] Action #task/work\n- [ ] Other #tasks\n";
        fs::write(&path, markdown).unwrap();
        toggle_task_in_vault(&temp.path().to_string_lossy(), "Inbox.md", 5, "Action #task/work", true).unwrap();
        assert_eq!(fs::read_to_string(path).unwrap(), markdown.replace("- [ ] Action", "- [x] Action"));
    }

    #[test]
    fn toggle_task_preserves_indentation_and_line_endings() {
        let temp = tempdir().expect("should create temp vault");
        let file_path = temp.path().join("Projects.md");
        fs::write(
            &file_path,
            "Intro\r\n  - [ ] Draft spec #work [[Spec]]\r\nOutro\r\n",
        )
        .expect("should create note");

        toggle_task_in_vault(
            &temp.path().to_string_lossy(),
            "Projects.md",
            2,
            "Draft spec #work [[Spec]]",
            true,
        )
        .expect("should toggle task");

        let updated = fs::read_to_string(&file_path).expect("should read updated file");
        assert_eq!(
            updated,
            "Intro\r\n  - [x] Draft spec #work [[Spec]]\r\nOutro\r\n"
        );
    }

    #[test]
    fn toggle_task_falls_back_to_matching_task_text_when_line_numbers_shift() {
        let temp = tempdir().expect("should create temp vault");
        let file_path = temp.path().join("Inbox.md");
        fs::write(&file_path, "New line\n- [ ] Follow up client\n").expect("should create note");

        toggle_task_in_vault(
            &temp.path().to_string_lossy(),
            "Inbox.md",
            1,
            "Follow up client",
            true,
        )
        .expect("should find shifted task");

        let updated = fs::read_to_string(&file_path).expect("should read updated file");
        assert_eq!(updated, "New line\n- [x] Follow up client\n");
    }

    #[test]
    fn toggle_task_errors_when_multiple_matching_tasks_exist() {
        let temp = tempdir().expect("should create temp vault");
        let file_path = temp.path().join("Inbox.md");
        fs::write(
            &file_path,
            "- [ ] Follow up client\n- [ ] Follow up client\n",
        )
        .expect("should create note");

        let error = toggle_task_in_vault(
            &temp.path().to_string_lossy(),
            "Inbox.md",
            0,
            "Follow up client",
            true,
        )
        .expect_err("should reject ambiguous task matches");

        assert!(error.contains("Multiple matching tasks"));
    }

    #[test]
    fn create_task_creates_parent_directories_and_appends_to_existing_file() {
        let temp = tempdir().expect("should create temp vault");
        let vault_root = temp.path().to_string_lossy().to_string();

        create_task_in_vault(&vault_root, "Mindwtr/Inbox.md", "Capture from Mindwtr")
            .expect("should create inbox note");
        create_task_in_vault(&vault_root, "Mindwtr/Inbox.md", "Second task")
            .expect("should append task");

        let content = fs::read_to_string(temp.path().join("Mindwtr/Inbox.md"))
            .expect("should read inbox note");
        assert_eq!(content, "- [ ] Capture from Mindwtr\n- [ ] Second task\n");
    }

    #[test]
    fn toggle_tasknotes_updates_status_and_completed_date() {
        let temp = tempdir().expect("should create temp vault");
        let file_path = temp.path().join("TaskNotes/Review.md");
        fs::create_dir_all(file_path.parent().expect("should have parent"))
            .expect("should create tasknotes folder");
        fs::write(&file_path, "---\nstatus: open\npriority: high\n---\nBody\n")
            .expect("should create tasknote");

        toggle_tasknotes_in_vault(&temp.path().to_string_lossy(), "TaskNotes/Review.md", true)
        .expect("should update tasknotes status");

        let updated = fs::read_to_string(&file_path).expect("should read updated tasknote");
        assert!(updated.contains("status: done"));
        assert!(updated.contains("completedDate: "));
        assert!(updated.contains("priority: high"));
        assert!(updated.ends_with("---\nBody\n"));
    }

    #[test]
    fn toggle_tasknotes_removes_completed_date_when_marking_incomplete() {
        let temp = tempdir().expect("should create temp vault");
        let file_path = temp.path().join("TaskNotes/Review.md");
        fs::create_dir_all(file_path.parent().expect("should have parent"))
            .expect("should create tasknotes folder");
        fs::write(
            &file_path,
            "---\nstatus: done\ncompletedDate: 2025-01-20\n---\nBody\n",
        )
        .expect("should create tasknote");

        toggle_tasknotes_in_vault(&temp.path().to_string_lossy(), "TaskNotes/Review.md", false)
        .expect("should clear tasknotes completion");

        let updated = fs::read_to_string(&file_path).expect("should read updated tasknote");
        assert!(updated.contains("status: open"));
        assert!(!updated.contains("completedDate:"));
        assert!(updated.ends_with("---\nBody\n"));
    }

    #[test]
    fn create_tasknotes_creates_a_markdown_file() {
        let temp = tempdir().expect("should create temp vault");
        let relative_path = create_tasknotes_in_vault(
            &temp.path().to_string_lossy(),
            "TaskNotes",
            "Review rollout / demo?",
        )
        .expect("should create a tasknotes file");

        assert_eq!(relative_path, "TaskNotes/Review rollout demo.md");
        let content = fs::read_to_string(temp.path().join(&relative_path))
            .expect("should read created tasknotes file");
        assert!(content.contains("tags:"));
        assert!(content.contains("title: \"Review rollout / demo?\""));
        assert!(content.contains("status: open"));
    }
}
