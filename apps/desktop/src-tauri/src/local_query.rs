use crate::local_api::valid_iso_date_like;
use serde_json::{Map, Value};
use time::format_description::well_known::Rfc3339;
use time::{Date, Duration, Month, OffsetDateTime, PrimitiveDateTime, Time};

pub(crate) const TASK_QUERY_FIELDS: &[&str] = &[
    "status",
    "projectId",
    "includeDeleted",
    "limit",
    "offset",
    "search",
    "dueDateFrom",
    "dueDateTo",
    "isFocusedToday",
    "sortBy",
    "sortOrder",
];

pub(crate) fn validate_query(input: &Map<String, Value>) -> Result<(), String> {
    for (field, value) in input {
        let valid = match field.as_str() {
            "status" => value.as_str().is_some_and(|s| {
                matches!(
                    s,
                    "all"
                        | "inbox"
                        | "next"
                        | "waiting"
                        | "someday"
                        | "reference"
                        | "done"
                        | "archived"
                )
            }),
            "projectId" => value.is_string(),
            "includeDeleted" | "isFocusedToday" => value.is_boolean(),
            "limit" => value.as_u64().is_some_and(|n| (1..=1000).contains(&n)),
            "offset" => value.as_u64().is_some_and(|n| n <= 100000),
            "search" => value
                .as_str()
                .is_some_and(|s| s.encode_utf16().count() <= 512),
            "dueDateFrom" | "dueDateTo" => value.as_str().is_some_and(valid_iso_date_like),
            "sortBy" => value.as_str().is_some_and(|s| {
                matches!(
                    s,
                    "updatedAt" | "createdAt" | "dueDate" | "title" | "priority"
                )
            }),
            "sortOrder" => value.as_str().is_some_and(|s| matches!(s, "asc" | "desc")),
            _ => false,
        };
        if !valid {
            return Err("Invalid task query".into());
        }
    }
    Ok(())
}

fn text<'a>(value: &'a Value, field: &str) -> &'a str {
    value.get(field).and_then(Value::as_str).unwrap_or("")
}
fn present(value: &Value, field: &str) -> bool {
    !text(value, field).is_empty()
}
fn contains(haystack: &str, needle: &str) -> bool {
    !haystack.is_empty() && haystack.to_lowercase().contains(&needle.to_lowercase())
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn array<'a>(value: &'a Value, field: &str) -> &'a [Value] {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}
fn person_key(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub(crate) fn query_tasks(data: &Value, input: &Map<String, Value>) -> Result<Vec<Value>, String> {
    query_tasks_at(data, input, OffsetDateTime::now_utc())
}

fn query_tasks_at(
    data: &Value,
    input: &Map<String, Value>,
    now: OffsetDateTime,
) -> Result<Vec<Value>, String> {
    validate_query(input)?;
    let search = input.get("search").and_then(Value::as_str).unwrap_or("");
    let clauses = parse_search(search);
    let local_now = local_wall(now).ok_or("Native timezone is unavailable")?;
    let date_key = |field: &str| {
        input
            .get(field)
            .and_then(Value::as_str)
            .and_then(local_date_key)
    };
    let from = date_key("dueDateFrom");
    let to = date_key("dueDateTo");
    let mut tasks = array(data, "tasks")
        .iter()
        .filter(|task| {
            if present(task, "purgedAt")
                || (input.get("includeDeleted").and_then(Value::as_bool) != Some(true)
                    && present(task, "deletedAt"))
            {
                return false;
            }
            if input
                .get("status")
                .and_then(Value::as_str)
                .is_some_and(|s| s != "all" && text(task, "status") != s)
            {
                return false;
            }
            if input
                .get("projectId")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty() && text(task, "projectId") != s)
            {
                return false;
            }
            if input
                .get("isFocusedToday")
                .and_then(Value::as_bool)
                .is_some_and(|focus| task.get("isFocusedToday").is_some_and(truthy) != focus)
            {
                return false;
            }
            let due = local_date_key(text(task, "dueDate"));
            if from.is_some_and(|from| due.is_none_or(|due| due < from))
                || to.is_some_and(|to| due.is_none_or(|due| due > to))
            {
                return false;
            }
            if !search.is_empty() {
                if present(task, "deletedAt") {
                    return false;
                }
                if !clauses.is_empty()
                    && !clauses.iter().any(|clause| {
                        clause
                            .iter()
                            .all(|term| matches_term(term, task, data, local_now))
                    })
                {
                    return false;
                }
            }
            true
        })
        .cloned()
        .collect::<Vec<_>>();
    let sort_by = input
        .get("sortBy")
        .and_then(Value::as_str)
        .unwrap_or("updatedAt");
    let ascending = input.get("sortOrder").and_then(Value::as_str) == Some("asc");
    let priority = |task: &Value| match text(task, "priority") {
        "low" => 1,
        "medium" => 2,
        "high" => 3,
        "urgent" => 4,
        _ => 0,
    };
    tasks.sort_by(|left, right| {
        let ordering = if sort_by == "priority" {
            priority(left).cmp(&priority(right))
        } else {
            text(left, sort_by).cmp(text(right, sort_by))
        };
        (if ascending {
            ordering
        } else {
            ordering.reverse()
        })
        .then_with(|| text(left, "id").cmp(text(right, "id")))
    });
    let offset = input.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
    let limit = input.get("limit").and_then(Value::as_u64).unwrap_or(200) as usize;
    Ok(tasks.into_iter().skip(offset).take(limit).collect())
}

#[derive(Debug)]
struct Term {
    field: Option<String>,
    comparator: Option<String>,
    value: String,
    negated: bool,
}

fn decode(value: &str) -> String {
    let Some(value) = value.strip_prefix('"') else {
        return value.to_string();
    };
    let value = value.strip_suffix('"').unwrap_or(value);
    let mut characters = value.chars().peekable();
    let mut decoded = String::new();
    while let Some(character) = characters.next() {
        if character == '\\' && characters.peek().is_some_and(|c| matches!(c, '"' | '\\')) {
            decoded.push(characters.next().unwrap());
        } else {
            decoded.push(character);
        }
    }
    decoded
}

fn comparator(value: &str) -> (Option<String>, String) {
    for comparator in ["<=", ">=", "<", ">", "="] {
        if let Some(rest) = value
            .strip_prefix(comparator)
            .filter(|rest| !rest.trim().is_empty())
        {
            return (Some(comparator.to_string()), rest.trim().to_string());
        }
    }
    (None, value.trim().to_string())
}

fn parse_search(query: &str) -> Vec<Vec<Term>> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut quoted = false;
    let mut escaped = false;
    for character in query.chars() {
        if escaped {
            token.push(character);
            escaped = false;
            continue;
        }
        if quoted && character == '\\' {
            token.push(character);
            escaped = true;
            continue;
        }
        if character == '"' {
            quoted = !quoted;
            token.push(character);
            continue;
        }
        if character.is_whitespace() && !quoted {
            if !token.is_empty() {
                tokens.push(std::mem::take(&mut token));
            }
            continue;
        }
        token.push(character);
    }
    if !token.is_empty() {
        tokens.push(token);
    }
    let mut clauses = Vec::new();
    let mut terms = Vec::new();
    for token in tokens {
        if token.eq_ignore_ascii_case("OR") || matches!(token.as_str(), "|" | "||") {
            if !terms.is_empty() {
                clauses.push(std::mem::take(&mut terms));
            }
            continue;
        }
        let negated = token.starts_with('-');
        let token = decode(if negated { &token[1..] } else { &token });
        if token.is_empty() {
            continue;
        }
        let shorthand = match token.chars().next() {
            Some('@') => Some("context"),
            Some('#') => Some("tag"),
            Some('%') => Some("person"),
            _ => None,
        };
        let (field, comparator, value) = if let Some(field) = shorthand.filter(|_| {
            token.len() > 1 && (!token.contains(':') || token.as_bytes().get(1) == Some(&b'"'))
        }) {
            let value = decode(&token[1..]);
            (
                Some(field.to_string()),
                None,
                if field == "person" {
                    value
                } else {
                    format!("{}{value}", &token[..1])
                },
            )
        } else if let Some((field, value)) =
            token.split_once(':').filter(|(field, _)| !field.is_empty())
        {
            let (cmp, value) = comparator(value);
            (Some(field.to_lowercase()), cmp, decode(&value))
        } else {
            (None, None, token)
        };
        terms.push(Term {
            field,
            comparator,
            value,
            negated,
        });
    }
    if !terms.is_empty() {
        clauses.push(terms);
    }
    clauses
}

fn matches_term(term: &Term, task: &Value, data: &Value, now: PrimitiveDateTime) -> bool {
    let value = &term.value;
    let checklist = |needle: &str| {
        array(task, "checklist")
            .iter()
            .any(|item| contains(text(item, "title"), needle))
    };
    let result = match term.field.as_deref() {
        None => {
            ["title", "description", "location", "assignedTo"]
                .iter()
                .any(|field| contains(text(task, field), value))
                || checklist(value)
        }
        Some("checklist") => !value.trim().is_empty() && checklist(value),
        Some("id") => !value.trim().is_empty() && contains(text(task, "id"), value),
        Some("status") => {
            let status = value.trim().to_lowercase();
            let status = match status.as_str() {
                "planned" | "pending" | "in-progress" | "doing" => "next",
                "inbox" | "next" | "waiting" | "someday" | "reference" | "done" | "archived" => {
                    status.as_str()
                }
                _ => "inbox",
            };
            text(task, "status") == status
        }
        Some("context" | "contexts" | "tag" | "tags") => {
            let context = matches!(term.field.as_deref(), Some("context" | "contexts"));
            let prefix = if context { '@' } else { '#' };
            let filter = if value.starts_with(prefix) {
                value.to_string()
            } else {
                format!("{prefix}{value}")
            };
            let filter = filter.trim_end_matches('/');
            array(task, if context { "contexts" } else { "tags" })
                .iter()
                .filter_map(Value::as_str)
                .any(|token| token == filter || token.starts_with(&format!("{filter}/")))
        }
        Some("project") => {
            let id = text(task, "projectId");
            !id.is_empty()
                && (id == value
                    || array(data, "projects")
                        .iter()
                        .filter(|project| !present(project, "deletedAt"))
                        .any(|project| {
                            text(project, "id") == id && contains(text(project, "title"), value)
                        }))
        }
        Some("assigned" | "assignee" | "assignedto") => {
            !value.trim().is_empty() && contains(text(task, "assignedTo"), value)
        }
        Some("person") => {
            let key = person_key(value);
            !key.is_empty()
                && (person_key(text(task, "assignedTo")) == key
                    || array(task, "contexts")
                        .iter()
                        .filter_map(Value::as_str)
                        .filter_map(|context| context.trim().strip_prefix('@'))
                        .any(|context| person_key(context) == key))
        }
        Some("location" | "where") => {
            !value.trim().is_empty() && contains(text(task, "location"), value)
        }
        Some("due" | "start" | "review" | "created") => {
            let field = match term.field.as_deref() {
                Some("due") => "dueDate",
                Some("start") => "startTime",
                Some("review") => "reviewAt",
                _ => "createdAt",
            };
            match_date(text(task, field), field == "dueDate", term, now)
        }
        Some(field) => {
            let needle = format!("{field}:{value}");
            contains(text(task, "title"), &needle)
                || contains(text(task, "description"), &needle)
                || checklist(&needle)
        }
    };
    if term.negated {
        !result
    } else {
        result
    }
}

fn parse_date(value: &str) -> Option<Date> {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    Date::from_calendar_date(
        value[..4].parse().ok()?,
        Month::try_from(value[5..7].parse::<u8>().ok()?).ok()?,
        value[8..10].parse().ok()?,
    )
    .ok()
}

fn local_date_key(value: &str) -> Option<Date> {
    OffsetDateTime::parse(value, &Rfc3339)
        .ok()
        .and_then(local_wall)
        .or_else(|| parse_local_date(value))
        .map(|date| date.date())
}

pub(crate) fn parse_local_date(value: &str) -> Option<PrimitiveDateTime> {
    if let Some(date) = parse_date(value) {
        return Some(date.midnight());
    }
    let (date, clock) = value.split_once('T')?;
    let mut parts = clock.split(':');
    let hour = parts.next()?.parse().ok()?;
    let minute = parts.next()?.parse().ok()?;
    let seconds = parts.next().unwrap_or("00");
    let (second, fraction) = seconds.split_once('.').unwrap_or((seconds, ""));
    if parts.next().is_some()
        || fraction.len() > 9
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    let nanos = if fraction.is_empty() {
        0
    } else {
        fraction
            .parse::<u32>()
            .ok()?
            .checked_mul(10_u32.pow(9 - fraction.len() as u32))?
    };
    Some(PrimitiveDateTime::new(
        parse_date(date)?,
        Time::from_hms_nano(hour, minute, second.parse().ok()?, nanos).ok()?,
    ))
}

fn relative_date(value: &str, now: PrimitiveDateTime) -> Option<PrimitiveDateTime> {
    let value = value.trim().to_lowercase();
    if value == "today" {
        return Some(now.date().midnight());
    }
    if value == "tomorrow" {
        return Some(now.date().checked_add(Duration::days(1))?.midnight());
    }
    let number_end = value
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(value.len());
    if number_end > 0 {
        let amount = value[..number_end].parse::<i64>().ok()?;
        let unit = value[number_end..].trim();
        let days = match unit {
            "d" | "day" | "days" => Some(amount),
            "w" | "week" | "weeks" => amount.checked_mul(7),
            _ => None,
        };
        if let Some(days) = days {
            return now.checked_add(Duration::seconds(days.checked_mul(86400)?));
        }
        let months = match unit {
            "m" | "month" | "months" => Some(amount),
            "y" | "year" | "years" => amount.checked_mul(12),
            _ => None,
        };
        if let Some(months) = months {
            let month_index = (i64::from(now.year()) * 12 + i64::from(u8::from(now.month())) - 1)
                .checked_add(months)?;
            let year = i32::try_from(month_index.div_euclid(12)).ok()?;
            let month = Month::try_from((month_index.rem_euclid(12) + 1) as u8).ok()?;
            let mut day = now.day();
            while let Err(_) = Date::from_calendar_date(year, month, day) {
                day = day.checked_sub(1)?;
            }
            return Some(PrimitiveDateTime::new(
                Date::from_calendar_date(year, month, day).ok()?,
                now.time(),
            ));
        }
    }

    if value.contains('t') {
        return None;
    }
    parse_local_date(&value)
}

fn match_date(value: &str, due: bool, term: &Term, now: PrimitiveDateTime) -> bool {
    let date = if let Ok(date) = OffsetDateTime::parse(value, &Rfc3339) {
        Some(date)
    } else {
        parse_local_date(value).and_then(|date| {
            local_instant(if due && value.len() == 10 {
                PrimitiveDateTime::new(date.date(), Time::from_hms_milli(23, 59, 59, 999).unwrap())
            } else {
                date
            })
        })
    };
    let (cmp, value) = comparator(&term.value);
    let comparator = term.comparator.as_deref().or(cmp.as_deref()).unwrap_or("=");
    let target = relative_date(&value, now);
    let (Some(date), Some(target)) = (date, target) else {
        return false;
    };
    if comparator == "=" {
        return local_wall(date).is_some_and(|date| date.date() == target.date());
    }
    let Some(target) = local_instant(target) else {
        return false;
    };
    match comparator {
        "<" => date < target,
        "<=" => date <= target,
        ">" => date > target,
        ">=" => date >= target,
        _ => false,
    }
}

#[cfg(unix)]
pub(crate) fn local_wall(date: OffsetDateTime) -> Option<PrimitiveDateTime> {
    let timestamp = libc::time_t::try_from(date.unix_timestamp()).ok()?;
    let mut local = std::mem::MaybeUninit::<libc::tm>::uninit();
    if unsafe { libc::localtime_r(&timestamp, local.as_mut_ptr()) }.is_null() {
        return None;
    }
    let local = unsafe { local.assume_init() };
    Some(PrimitiveDateTime::new(
        Date::from_calendar_date(
            local.tm_year + 1900,
            Month::try_from((local.tm_mon + 1) as u8).ok()?,
            local.tm_mday as u8,
        )
        .ok()?,
        Time::from_hms_nano(
            local.tm_hour as u8,
            local.tm_min as u8,
            local.tm_sec as u8,
            date.nanosecond(),
        )
        .ok()?,
    ))
}

#[cfg(unix)]
fn local_instant(date: PrimitiveDateTime) -> Option<OffsetDateTime> {
    let mut local: libc::tm = unsafe { std::mem::zeroed() };
    local.tm_year = date.year() - 1900;
    local.tm_mon = i32::from(u8::from(date.month())) - 1;
    local.tm_mday = i32::from(date.day());
    local.tm_hour = i32::from(date.hour());
    local.tm_min = i32::from(date.minute());
    local.tm_sec = i32::from(date.second());
    local.tm_isdst = -1;
    let timestamp = unsafe { libc::mktime(&mut local) };
    OffsetDateTime::from_unix_timestamp(timestamp as i64)
        .ok()?
        .replace_nanosecond(date.nanosecond())
        .ok()
}

#[cfg(windows)]
fn system_time(date: PrimitiveDateTime) -> windows_sys::Win32::Foundation::SYSTEMTIME {
    windows_sys::Win32::Foundation::SYSTEMTIME {
        wYear: date.year() as u16,
        wMonth: u8::from(date.month()) as u16,
        wDay: date.day() as u16,
        wDayOfWeek: 0,
        wHour: date.hour() as u16,
        wMinute: date.minute() as u16,
        wSecond: date.second() as u16,
        wMilliseconds: date.millisecond(),
    }
}
#[cfg(windows)]
fn wall_from_system_time(
    date: windows_sys::Win32::Foundation::SYSTEMTIME,
) -> Option<PrimitiveDateTime> {
    Some(PrimitiveDateTime::new(
        Date::from_calendar_date(
            date.wYear as i32,
            Month::try_from(date.wMonth as u8).ok()?,
            date.wDay as u8,
        )
        .ok()?,
        Time::from_hms_milli(
            date.wHour as u8,
            date.wMinute as u8,
            date.wSecond as u8,
            date.wMilliseconds,
        )
        .ok()?,
    ))
}
#[cfg(windows)]
pub(crate) fn local_wall(date: OffsetDateTime) -> Option<PrimitiveDateTime> {
    let date = date.to_offset(time::UtcOffset::UTC);
    let input = system_time(PrimitiveDateTime::new(date.date(), date.time()));
    let mut output = unsafe { std::mem::zeroed() };
    if unsafe {
        windows_sys::Win32::System::Time::SystemTimeToTzSpecificLocalTimeEx(
            std::ptr::null(),
            &input,
            &mut output,
        )
    } == 0
    {
        return None;
    }
    wall_from_system_time(output)
}
#[cfg(windows)]
fn local_instant(date: PrimitiveDateTime) -> Option<OffsetDateTime> {
    let input = system_time(date);
    let mut output = unsafe { std::mem::zeroed() };
    if unsafe {
        windows_sys::Win32::System::Time::TzSpecificLocalTimeToSystemTimeEx(
            std::ptr::null(),
            &input,
            &mut output,
        )
    } == 0
    {
        return None;
    }
    Some(wall_from_system_time(output)?.assume_utc())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[cfg(unix)]
    #[test]
    fn mcp_native_rich_search_matches_core_fixture_in_isolated_timezone_process() {
        const MARKER: &str = "MINDWTR_NATIVE_QUERY_TZ_CHILD";
        if std::env::var_os(MARKER).is_none() {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("local_query::tests::mcp_native_rich_search_matches_core_fixture_in_isolated_timezone_process")
                .args(["--exact", "--nocapture"])


                .env(MARKER, "1")
                .env("TZ", "EST5EDT,M3.2.0/2,M11.1.0/2")
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../packages/core/src/fixtures/native-task-search.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let data = json!({"tasks":fixture["taskSets"][case["taskSet"].as_str().unwrap()],"projects":fixture["projects"]});
            let input = json!({"search":case["query"],"limit":1000,"includeDeleted": !case["query"].as_str().unwrap().is_empty()});
            let tasks = query_tasks_at(
                &data,
                input.as_object().unwrap(),
                OffsetDateTime::parse(fixture["now"].as_str().unwrap(), &Rfc3339).unwrap(),
            )
            .unwrap();
            let mut ids = tasks
                .iter()
                .map(|task| text(task, "id").to_string())
                .collect::<Vec<_>>();
            ids.sort();
            assert_eq!(json!(ids), case["expectedIds"], "{}", case["name"]);
        }
    }
    #[test]
    fn mcp_native_due_windows_preserve_written_calendar_days() {
        let data = json!({"tasks":[
            {"id":"evening","dueDate":"2026-10-11T23:30"},
            {"id":"morning","dueDate":"2026-10-12T07:00"},
            {"id":"seconds","dueDate":"2026-10-11T23:30:00.123"},
            {"id":"date-only","dueDate":"2026-10-11"},
            {"id":"invalid","dueDate":"2026-10-11T25:30"},
            {"id":"missing"}
        ]});
        let input = json!({"dueDateFrom":"2026-10-11","dueDateTo":"2026-10-11"});
        let tasks = query_tasks(&data, input.as_object().unwrap()).unwrap();
        let ids = tasks
            .iter()
            .map(|task| text(task, "id"))
            .collect::<Vec<_>>();
        assert_eq!(ids, ["date-only", "evening", "seconds"]);
    }

    #[cfg(unix)]
    #[test]
    fn mcp_native_due_windows_convert_offsets_in_isolated_timezone_process() {
        const MARKER: &str = "MINDWTR_DUE_WINDOW_TZ_CHILD";
        let Ok(zone) = std::env::var(MARKER) else {
            for (zone, rules) in [
                ("America/Los_Angeles", "PST8PDT,M3.2.0/2,M11.1.0/2"),
                ("Asia/Shanghai", "CST-8"),
            ] {
                let status = std::process::Command::new(std::env::current_exe().unwrap())
                    .args([
                        "local_query::tests::mcp_native_due_windows_convert_offsets_in_isolated_timezone_process",
                        "--exact",
                        "--nocapture",
                    ])
                    .env(MARKER, zone)
                    .env("TZ", rules)
                    .status()
                    .unwrap();
                assert!(status.success(), "{zone}");
            }
            return;
        };
        let (early, late) = if zone == "America/Los_Angeles" {
            ("2026-10-11T07:30:00Z", "2026-10-12T06:30:00+00:00")
        } else {
            ("2026-10-10T16:30:00Z", "2026-10-11T15:30:00+00:00")
        };
        let data = json!({"tasks":[
            {"id":"early","dueDate":early}, {"id":"late","dueDate":late},
            {"id":"previous","dueDate":"2026-10-10"},
            {"id":"next","dueDate":"2026-10-12"}
        ]});
        for input in [
            json!({"dueDateFrom":"2026-10-11","dueDateTo":"2026-10-11"}),
            json!({"dueDateFrom":early,"dueDateTo":late}),
        ] {
            let tasks = query_tasks(&data, input.as_object().unwrap()).unwrap();
            let ids = tasks
                .iter()
                .map(|task| text(task, "id"))
                .collect::<Vec<_>>();
            assert_eq!(ids, ["early", "late"], "{zone}");
        }
    }

    #[test]
    fn mcp_native_query_validation_sorting_and_pagination() {
        let data = json!({"tasks":[
            {"id":"c","title":"Z","priority":"high","status":"done","dueDate":"2026-10-05"},
            {"id":"a","title":"A","priority":"low","status":"next","projectId":"p","dueDate":"2026-10-06","isFocusedToday":true},
            {"id":"b","title":"B","priority":"medium","status":"next","projectId":"p","dueDate":"2026-10-07","isFocusedToday":false}
        ],"projects":[]});
        let input = json!({"status":"next","projectId":"p","sortBy":"priority","sortOrder":"desc","offset":1,"limit":1,"dueDateFrom":"2026-10-06","dueDateTo":"2026-10-07"});
        assert_eq!(
            query_tasks(&data, input.as_object().unwrap()).unwrap()[0]["id"],
            "a"
        );
        for invalid in [
            json!({"view":"available"}),
            json!({"limit":0}),
            json!({"offset":100001}),
            json!({"includeDeleted":"true"}),
            json!({"dueDateFrom":"2026-02-30"}),
        ] {
            assert!(validate_query(invalid.as_object().unwrap()).is_err());
        }
        let now = local_wall(OffsetDateTime::now_utc()).unwrap();
        assert!(relative_date("9223372036854775807d", now).is_none());
        assert!(relative_date("9223372036854775807m", now).is_none());
    }
    #[test]
    fn mcp_native_timezone_roundtrip_preserves_per_date_local_time() {
        for value in ["2026-01-05T12:34:56.123Z", "2026-07-05T12:34:56.123Z"] {
            let instant = OffsetDateTime::parse(value, &Rfc3339).unwrap();
            let local = local_wall(instant).unwrap();
            assert_eq!(local_instant(local).unwrap(), instant);
        }
    }
}
