use serde::{Deserialize, Serialize};

use crate::{
    ExternalCalendarSubscription, MacOsCalendarEventPayload, MacOsCalendarEventWriteResult,
    MacOsCalendarPushTarget,
};

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinuxCalendarIcsSource {
    source_id: String,
    ics: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinuxCalendarReadResult {
    permission: String,
    calendars: Vec<ExternalCalendarSubscription>,
    ics_sources: Vec<LinuxCalendarIcsSource>,
}

#[tauri::command]
pub(crate) async fn get_linux_calendar_permission_status() -> Result<String, String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(imp::permission_status)
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok("unsupported".to_string())
    }
}

#[tauri::command]
pub(crate) async fn request_linux_calendar_permission() -> Result<String, String> {
    get_linux_calendar_permission_status().await
}

#[tauri::command]
pub(crate) async fn get_linux_calendar_events(
    range_start: String,
    range_end: String,
) -> Result<LinuxCalendarReadResult, String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || imp::get_events(&range_start, &range_end))
            .await
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (range_start, range_end);
        Ok(LinuxCalendarReadResult {
            permission: "unsupported".to_string(),
            calendars: Vec::new(),
            ics_sources: Vec::new(),
        })
    }
}

#[tauri::command]
pub(crate) async fn get_linux_writable_calendars() -> Result<Vec<MacOsCalendarPushTarget>, String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(imp::get_writable_calendars)
            .await
            .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub(crate) async fn ensure_linux_mindwtr_calendar(
    stored_calendar_id: Option<String>,
) -> Result<Option<MacOsCalendarPushTarget>, String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            imp::ensure_mindwtr_calendar(stored_calendar_id.as_deref())
        })
        .await
        .map_err(|error| error.to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = stored_calendar_id;
        Ok(None)
    }
}

#[tauri::command]
pub(crate) async fn create_linux_calendar_event(
    details: MacOsCalendarEventPayload,
) -> Result<MacOsCalendarEventWriteResult, String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || imp::create_event_command(&details))
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = details;
        Ok(unsupported_write_result())
    }
}

#[tauri::command]
pub(crate) async fn update_linux_calendar_event(
    event_id: String,
    details: MacOsCalendarEventPayload,
) -> Result<MacOsCalendarEventWriteResult, String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || imp::update_event_command(&event_id, &details))
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (event_id, details);
        Ok(unsupported_write_result())
    }
}

#[tauri::command]
pub(crate) async fn delete_linux_calendar_event(
    event_id: String,
) -> Result<MacOsCalendarEventWriteResult, String> {
    #[cfg(target_os = "linux")]
    {
        tauri::async_runtime::spawn_blocking(move || imp::delete_event_command(&event_id))
            .await
            .map_err(|error| error.to_string())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = event_id;
        Ok(unsupported_write_result())
    }
}

#[cfg(not(target_os = "linux"))]
fn unsupported_write_result() -> MacOsCalendarEventWriteResult {
    MacOsCalendarEventWriteResult {
        ok: false,
        event_id: None,
        error: Some("unsupported".to_string()),
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;
    use libloading::Library;
    use std::{
        ffi::{c_char, c_int, c_void, CStr, CString},
        ptr, thread,
        time::Duration,
    };
    use time::{format_description::well_known::Rfc3339, Date, Month, OffsetDateTime, UtcOffset};

    const CALENDAR_EXTENSION: &[u8] = b"Calendar\0";
    const LOCAL_BACKEND: &[u8] = b"local\0";

    const READ_ONLY_BACKENDS: &[&str] = &["birthdays", "contacts", "weather", "webcal"];
    const SOURCE_TYPE_EVENTS: c_int = 0;
    const OBJ_MOD_ALL: c_int = 0x07;
    const OPERATION_FLAGS_NONE: c_int = 0;
    const CAL_CLIENT_ERROR_OBJECT_NOT_FOUND: c_int = 1;

    #[repr(C)]
    struct GList {
        data: *mut c_void,
        next: *mut GList,
        prev: *mut GList,
    }

    #[repr(C)]
    struct GSList {
        data: *mut c_void,
        next: *mut GSList,
    }

    #[repr(C)]
    struct GError {
        domain: u32,
        code: c_int,
        message: *mut c_char,
    }

    type RegistryNewSync = unsafe extern "C" fn(*mut c_void, *mut *mut GError) -> *mut c_void;
    type RegistryListEnabled = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut GList;
    type RegistryRefSource = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void;
    type RegistryCommitSourceSync =
        unsafe extern "C" fn(*mut c_void, *mut c_void, *mut c_void, *mut *mut GError) -> c_int;
    type SourceNewWithUid =
        unsafe extern "C" fn(*const c_char, *mut c_void, *mut *mut GError) -> *mut c_void;
    type SourceGetString = unsafe extern "C" fn(*mut c_void) -> *const c_char;
    type SourceSetDisplayName = unsafe extern "C" fn(*mut c_void, *const c_char);
    type SourceGetExtension = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_void;
    type SourceBackendSetName = unsafe extern "C" fn(*mut c_void, *const c_char);
    type SourceSelectableGetColor = unsafe extern "C" fn(*mut c_void) -> *const c_char;
    type CalClientConnectSync =
        unsafe extern "C" fn(*mut c_void, c_int, u32, *mut c_void, *mut *mut GError) -> *mut c_void;
    type ClientIsReadonly = unsafe extern "C" fn(*mut c_void) -> c_int;
    type CalClientGetObjectListSync = unsafe extern "C" fn(
        *mut c_void,
        *const c_char,
        *mut *mut GSList,
        *mut c_void,
        *mut *mut GError,
    ) -> c_int;
    type CalClientGetObjectSync = unsafe extern "C" fn(
        *mut c_void,
        *const c_char,
        *const c_char,
        *mut *mut c_void,
        *mut c_void,
        *mut *mut GError,
    ) -> c_int;
    type CalClientErrorQuark = unsafe extern "C" fn() -> u32;
    type CalClientGetComponentString =
        unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_char;
    type CalUtilParseIcsString = unsafe extern "C" fn(*const c_char) -> *mut c_void;
    type CalClientCreateObjectSync = unsafe extern "C" fn(
        *mut c_void,
        *mut c_void,
        c_int,
        *mut *mut c_char,
        *mut c_void,
        *mut *mut GError,
    ) -> c_int;
    type CalClientModifyObjectSync = unsafe extern "C" fn(
        *mut c_void,
        *mut c_void,
        c_int,
        c_int,
        *mut c_void,
        *mut *mut GError,
    ) -> c_int;
    type CalClientRemoveObjectSync = unsafe extern "C" fn(
        *mut c_void,
        *const c_char,
        *const c_char,
        c_int,
        c_int,
        *mut c_void,
        *mut *mut GError,
    ) -> c_int;
    type ObjectUnref = unsafe extern "C" fn(*mut c_void);
    type Free = unsafe extern "C" fn(*mut c_void);
    type ErrorFree = unsafe extern "C" fn(*mut GError);
    type ListFree = unsafe extern "C" fn(*mut GList);
    type SListFree = unsafe extern "C" fn(*mut GSList);

    struct EdsApi {
        _ecal: Library,
        registry_new_sync: RegistryNewSync,
        registry_list_enabled: RegistryListEnabled,
        registry_ref_source: RegistryRefSource,
        registry_commit_source_sync: RegistryCommitSourceSync,
        source_new_with_uid: SourceNewWithUid,
        source_get_uid: SourceGetString,
        source_get_parent: SourceGetString,
        source_get_display_name: SourceGetString,
        source_set_display_name: SourceSetDisplayName,
        source_get_extension: SourceGetExtension,
        source_backend_set_name: SourceBackendSetName,
        source_backend_get_name: SourceGetString,
        source_selectable_get_color: SourceSelectableGetColor,
        cal_client_connect_sync: CalClientConnectSync,
        client_is_readonly: ClientIsReadonly,
        cal_client_get_object_list_sync: CalClientGetObjectListSync,
        cal_client_get_object_sync: CalClientGetObjectSync,
        cal_client_error_quark: CalClientErrorQuark,
        cal_client_get_component_string: CalClientGetComponentString,
        cal_util_parse_ics_string: CalUtilParseIcsString,
        cal_client_create_object_sync: CalClientCreateObjectSync,
        cal_client_modify_object_sync: CalClientModifyObjectSync,
        cal_client_remove_object_sync: CalClientRemoveObjectSync,
        object_unref: ObjectUnref,
        free: Free,
        error_free: ErrorFree,
        list_free: ListFree,
        slist_free: SListFree,
    }

    fn eds_api() -> Result<&'static EdsApi, String> {
        static EDS_API: std::sync::OnceLock<Result<EdsApi, String>> = std::sync::OnceLock::new();
        EDS_API
            .get_or_init(EdsApi::load)
            .as_ref()
            .map_err(Clone::clone)
    }

    impl EdsApi {
        fn load() -> Result<Self, String> {
            let ecal = open_library(&["libecal-2.0.so.3"])?;
            let eds = &ecal;
            let glib = &ecal;
            let gobject = &ecal;

            unsafe {
                Ok(Self {
                    registry_new_sync: load_symbol(&eds, b"e_source_registry_new_sync\0")?,
                    registry_list_enabled: load_symbol(&eds, b"e_source_registry_list_enabled\0")?,
                    registry_ref_source: load_symbol(&eds, b"e_source_registry_ref_source\0")?,
                    registry_commit_source_sync: load_symbol(
                        &eds,
                        b"e_source_registry_commit_source_sync\0",
                    )?,
                    source_new_with_uid: load_symbol(&eds, b"e_source_new_with_uid\0")?,
                    source_get_uid: load_symbol(&eds, b"e_source_get_uid\0")?,
                    source_get_parent: load_symbol(&eds, b"e_source_get_parent\0")?,
                    source_get_display_name: load_symbol(&eds, b"e_source_get_display_name\0")?,
                    source_set_display_name: load_symbol(&eds, b"e_source_set_display_name\0")?,
                    source_get_extension: load_symbol(&eds, b"e_source_get_extension\0")?,
                    source_backend_set_name: load_symbol(
                        &eds,
                        b"e_source_backend_set_backend_name\0",
                    )?,
                    source_backend_get_name: load_symbol(
                        &eds,
                        b"e_source_backend_get_backend_name\0",
                    )?,
                    source_selectable_get_color: load_symbol(
                        &eds,
                        b"e_source_selectable_get_color\0",
                    )?,
                    cal_client_connect_sync: load_symbol(&ecal, b"e_cal_client_connect_sync\0")?,
                    client_is_readonly: load_symbol(&eds, b"e_client_is_readonly\0")?,
                    cal_client_get_object_list_sync: load_symbol(
                        &ecal,
                        b"e_cal_client_get_object_list_sync\0",
                    )?,
                    cal_client_get_object_sync: load_symbol(
                        &ecal,
                        b"e_cal_client_get_object_sync\0",
                    )?,
                    cal_client_error_quark: load_symbol(&ecal, b"e_cal_client_error_quark\0")?,
                    cal_client_get_component_string: load_symbol(
                        &ecal,
                        b"e_cal_client_get_component_as_string\0",
                    )?,
                    cal_util_parse_ics_string: load_symbol(
                        &ecal,
                        b"e_cal_util_parse_ics_string\0",
                    )?,
                    cal_client_create_object_sync: load_symbol(
                        &ecal,
                        b"e_cal_client_create_object_sync\0",
                    )?,
                    cal_client_modify_object_sync: load_symbol(
                        &ecal,
                        b"e_cal_client_modify_object_sync\0",
                    )?,
                    cal_client_remove_object_sync: load_symbol(
                        &ecal,
                        b"e_cal_client_remove_object_sync\0",
                    )?,
                    object_unref: load_symbol(&gobject, b"g_object_unref\0")?,
                    free: load_symbol(&glib, b"g_free\0")?,
                    error_free: load_symbol(&glib, b"g_error_free\0")?,
                    list_free: load_symbol(&glib, b"g_list_free\0")?,
                    slist_free: load_symbol(&glib, b"g_slist_free\0")?,
                    _ecal: ecal,
                })
            }
        }

        unsafe fn take_error(&self, error: *mut GError, fallback: &str) -> String {
            if error.is_null() {
                return fallback.to_string();
            }
            let message = if (*error).message.is_null() {
                fallback.to_string()
            } else {
                CStr::from_ptr((*error).message)
                    .to_string_lossy()
                    .into_owned()
            };
            (self.error_free)(error);
            message
        }
    }

    unsafe fn load_symbol<T: Copy>(library: &Library, name: &[u8]) -> Result<T, String> {
        library
            .get::<T>(name)
            .map(|symbol| *symbol)
            .map_err(|error| format!("Evolution Data Server symbol unavailable: {error}"))
    }

    fn open_library(names: &[&str]) -> Result<Library, String> {
        for name in names {
            if let Ok(library) = unsafe { Library::new(name) } {
                return Ok(library);
            }
        }
        Err("Evolution Data Server libraries are unavailable".to_string())
    }

    struct ObjectRef<'a> {
        api: &'a EdsApi,
        ptr: *mut c_void,
    }

    impl<'a> ObjectRef<'a> {
        fn new(api: &'a EdsApi, ptr: *mut c_void) -> Option<Self> {
            (!ptr.is_null()).then_some(Self { api, ptr })
        }
    }

    impl Drop for ObjectRef<'_> {
        fn drop(&mut self) {
            unsafe { (self.api.object_unref)(self.ptr) };
        }
    }

    struct Session<'a> {
        api: &'a EdsApi,
        registry: ObjectRef<'a>,
    }

    impl<'a> Session<'a> {
        fn new(api: &'a EdsApi) -> Result<Self, String> {
            let mut error = ptr::null_mut();
            let registry = unsafe { (api.registry_new_sync)(ptr::null_mut(), &mut error) };
            let registry = ObjectRef::new(api, registry).ok_or_else(|| unsafe {
                api.take_error(error, "Evolution Data Server is unavailable")
            })?;
            if !error.is_null() {
                unsafe { (api.error_free)(error) };
            }
            Ok(Self { api, registry })
        }

        fn list_sources(&self) -> Vec<ObjectRef<'a>> {
            let head = unsafe {
                (self.api.registry_list_enabled)(
                    self.registry.ptr,
                    CALENDAR_EXTENSION.as_ptr().cast(),
                )
            };
            let mut sources = Vec::new();
            let mut cursor = head;
            while !cursor.is_null() {
                unsafe {
                    if let Some(source) = ObjectRef::new(self.api, (*cursor).data) {
                        sources.push(source);
                    }
                    cursor = (*cursor).next;
                }
            }
            unsafe { (self.api.list_free)(head) };
            sources
        }

        fn ref_source(&self, uid: &str) -> Option<ObjectRef<'a>> {
            let uid = CString::new(uid).ok()?;
            ObjectRef::new(self.api, unsafe {
                (self.api.registry_ref_source)(self.registry.ptr, uid.as_ptr())
            })
        }
    }

    struct CalendarClient<'a> {
        _source: ObjectRef<'a>,
        client: ObjectRef<'a>,
    }

    fn connect_calendar<'a>(
        session: &'a Session<'a>,
        source: ObjectRef<'a>,
        require_writable: bool,
    ) -> Result<CalendarClient<'a>, String> {
        let mut error = ptr::null_mut();
        let client = unsafe {
            (session.api.cal_client_connect_sync)(
                source.ptr,
                SOURCE_TYPE_EVENTS,
                0,
                ptr::null_mut(),
                &mut error,
            )
        };
        let client = ObjectRef::new(session.api, client).ok_or_else(|| unsafe {
            session
                .api
                .take_error(error, "Calendar backend is unavailable")
        })?;
        if !error.is_null() {
            unsafe { (session.api.error_free)(error) };
        }
        if require_writable && unsafe { (session.api.client_is_readonly)(client.ptr) } != 0 {
            return Err("calendar-read-only".to_string());
        }
        Ok(CalendarClient {
            _source: source,
            client,
        })
    }

    fn c_string(value: &str, label: &str) -> Result<CString, String> {
        CString::new(value).map_err(|_| format!("Invalid {label}"))
    }

    unsafe fn borrowed_string(value: *const c_char) -> Option<String> {
        if value.is_null() {
            return None;
        }
        let value = CStr::from_ptr(value).to_string_lossy().trim().to_string();
        (!value.is_empty()).then_some(value)
    }

    fn source_uid(api: &EdsApi, source: *mut c_void) -> Option<String> {
        unsafe { borrowed_string((api.source_get_uid)(source)) }
    }

    fn source_name(api: &EdsApi, source: *mut c_void) -> String {
        unsafe { borrowed_string((api.source_get_display_name)(source)) }
            .unwrap_or_else(|| "Calendar".to_string())
    }

    fn source_parent_name(session: &Session<'_>, source: *mut c_void) -> Option<String> {
        let parent_uid = unsafe { borrowed_string((session.api.source_get_parent)(source)) }?;
        let parent = session.ref_source(&parent_uid)?;
        unsafe { borrowed_string((session.api.source_get_display_name)(parent.ptr)) }
    }

    fn source_color(api: &EdsApi, source: *mut c_void) -> Option<String> {
        let extension =
            unsafe { (api.source_get_extension)(source, CALENDAR_EXTENSION.as_ptr().cast()) };
        if extension.is_null() {
            return None;
        }
        unsafe { borrowed_string((api.source_selectable_get_color)(extension)) }
    }

    fn source_backend_name(api: &EdsApi, source: *mut c_void) -> Option<String> {
        let extension =
            unsafe { (api.source_get_extension)(source, CALENDAR_EXTENSION.as_ptr().cast()) };
        if extension.is_null() {
            return None;
        }
        unsafe { borrowed_string((api.source_backend_get_name)(extension)) }
    }

    fn is_writable_backend(backend_name: Option<&str>) -> bool {
        let Some(backend_name) = backend_name else {
            return true;
        };
        let backend_name = backend_name.trim().to_ascii_lowercase();
        !READ_ONLY_BACKENDS.contains(&backend_name.as_str())
    }

    fn push_target_from_source(
        session: &Session<'_>,
        source: &ObjectRef<'_>,
    ) -> Option<MacOsCalendarPushTarget> {
        if !is_writable_backend(source_backend_name(session.api, source.ptr).as_deref()) {
            return None;
        }
        let id = source_uid(session.api, source.ptr)?;
        let name = source_name(session.api, source.ptr);
        let source_name = source_parent_name(session, source.ptr);
        let color = source_color(session.api, source.ptr);
        Some(MacOsCalendarPushTarget {
            id,
            is_mindwtr_dedicated: name.eq_ignore_ascii_case("mindwtr"),
            name,
            source_name,
            color,
        })
    }

    pub(super) fn permission_status() -> String {
        let Ok(api) = eds_api() else {
            return "unsupported".to_string();
        };
        if Session::new(api).is_ok() {
            "granted".to_string()
        } else {
            "unsupported".to_string()
        }
    }

    pub(super) fn get_writable_calendars() -> Result<Vec<MacOsCalendarPushTarget>, String> {
        let api = eds_api()?;
        let session = Session::new(api)?;
        let sources = session.list_sources();
        let targets = sources
            .iter()
            .filter_map(|source| push_target_from_source(&session, source))
            .collect();
        Ok(targets)
    }

    pub(super) fn ensure_mindwtr_calendar(
        stored_calendar_id: Option<&str>,
    ) -> Result<Option<MacOsCalendarPushTarget>, String> {
        let api = eds_api()?;
        let session = Session::new(api)?;

        if let Some(stored_id) = stored_calendar_id
            .map(str::trim)
            .filter(|id| !id.is_empty())
        {
            if let Some(source) = session.ref_source(stored_id) {
                if let Some(target) = push_target_from_source(&session, &source) {
                    return Ok(Some(target));
                }
            }
        }

        for source in session.list_sources() {
            if source_name(session.api, source.ptr).eq_ignore_ascii_case("mindwtr") {
                if let Some(target) = push_target_from_source(&session, &source) {
                    return Ok(Some(target));
                }
            }
        }

        create_mindwtr_calendar(&session).map(Some)
    }

    fn create_mindwtr_calendar(session: &Session<'_>) -> Result<MacOsCalendarPushTarget, String> {
        let uid = format!("mindwtr-calendar-{:032x}", rand::random::<u128>());
        let uid_c = c_string(&uid, "calendar ID")?;
        let mut error = ptr::null_mut();
        let source = unsafe {
            (session.api.source_new_with_uid)(uid_c.as_ptr(), ptr::null_mut(), &mut error)
        };
        let source = ObjectRef::new(session.api, source).ok_or_else(|| unsafe {
            session
                .api
                .take_error(error, "Could not create a calendar source")
        })?;
        if !error.is_null() {
            unsafe { (session.api.error_free)(error) };
        }

        let name = c_string("Mindwtr", "calendar name")?;
        unsafe { (session.api.source_set_display_name)(source.ptr, name.as_ptr()) };
        let extension = unsafe {
            (session.api.source_get_extension)(source.ptr, CALENDAR_EXTENSION.as_ptr().cast())
        };
        if extension.is_null() {
            return Err("Evolution Data Server calendar extension is unavailable".to_string());
        }
        unsafe { (session.api.source_backend_set_name)(extension, LOCAL_BACKEND.as_ptr().cast()) };

        let mut error = ptr::null_mut();
        let committed = unsafe {
            (session.api.registry_commit_source_sync)(
                session.registry.ptr,
                source.ptr,
                ptr::null_mut(),
                &mut error,
            )
        };
        if committed == 0 {
            return Err(unsafe {
                session
                    .api
                    .take_error(error, "Could not create the Mindwtr calendar")
            });
        }
        if !error.is_null() {
            unsafe { (session.api.error_free)(error) };
        }
        drop(source);

        for _ in 0..20 {
            if let Some(source) = session.ref_source(&uid) {
                let target = push_target_from_source(session, &source);

                if connect_calendar(session, source, true).is_ok() {
                    if let Some(target) = target {
                        return Ok(target);
                    }
                }
            }
            thread::sleep(Duration::from_millis(50));
        }
        Err("Mindwtr calendar was created but is not ready yet".to_string())
    }

    pub(super) fn get_events(
        range_start: &str,
        range_end: &str,
    ) -> Result<LinuxCalendarReadResult, String> {
        let api = match eds_api() {
            Ok(api) => api,
            Err(_) => {
                return Ok(LinuxCalendarReadResult {
                    permission: "unsupported".to_string(),
                    calendars: Vec::new(),
                    ics_sources: Vec::new(),
                })
            }
        };
        let session = match Session::new(api) {
            Ok(session) => session,
            Err(_) => {
                return Ok(LinuxCalendarReadResult {
                    permission: "unsupported".to_string(),
                    calendars: Vec::new(),
                    ics_sources: Vec::new(),
                })
            }
        };
        let query = calendar_query(range_start, range_end)?;
        let query = c_string(&query, "calendar range")?;
        let mut calendars = Vec::new();
        let mut ics_sources = Vec::new();

        for source in session.list_sources() {
            let Some(uid) = source_uid(session.api, source.ptr) else {
                continue;
            };
            let name = source_name(session.api, source.ptr);
            let color = source_color(session.api, source.ptr);

            let Ok(calendar) = connect_calendar(&session, source, false) else {
                continue;
            };
            let source_id = format!("system:{uid}");
            calendars.push(ExternalCalendarSubscription {
                id: source_id.clone(),
                name,
                url: format!("system://{}", percent_encode(&uid)),
                enabled: true,
                color,
                area_ids: None,
            });
            let Ok(ics) = read_calendar_components(session.api, calendar.client.ptr, &query) else {
                continue;
            };
            if !ics.is_empty() {
                ics_sources.push(LinuxCalendarIcsSource { source_id, ics });
            }
        }

        Ok(LinuxCalendarReadResult {
            permission: "granted".to_string(),
            calendars,
            ics_sources,
        })
    }

    fn read_calendar_components(
        api: &EdsApi,
        client: *mut c_void,
        query: &CString,
    ) -> Result<Vec<String>, String> {
        let mut list = ptr::null_mut();
        let mut error = ptr::null_mut();
        let ok = unsafe {
            (api.cal_client_get_object_list_sync)(
                client,
                query.as_ptr(),
                &mut list,
                ptr::null_mut(),
                &mut error,
            )
        };
        if ok == 0 {
            free_component_list(api, list);
            return Err(unsafe { api.take_error(error, "calendar-read-failed") });
        }
        if !error.is_null() {
            unsafe { (api.error_free)(error) };
        }

        let mut result = Vec::new();
        let mut cursor = list;
        while !cursor.is_null() {
            unsafe {
                let component = (*cursor).data;
                let raw = (api.cal_client_get_component_string)(client, component);
                if !raw.is_null() {
                    result.push(CStr::from_ptr(raw).to_string_lossy().into_owned());
                    (api.free)(raw.cast());
                }
                (api.object_unref)(component);
                cursor = (*cursor).next;
            }
        }
        unsafe { (api.slist_free)(list) };
        Ok(result)
    }

    fn free_component_list(api: &EdsApi, list: *mut GSList) {
        let mut cursor = list;
        while !cursor.is_null() {
            unsafe {
                (api.object_unref)((*cursor).data);
                cursor = (*cursor).next;
            }
        }
        unsafe { (api.slist_free)(list) };
    }

    pub(super) fn create_event_command(
        details: &MacOsCalendarEventPayload,
    ) -> MacOsCalendarEventWriteResult {
        with_session(|session| create_event(session, details, None)).unwrap_or_else(write_error)
    }

    pub(super) fn update_event_command(
        event_id: &str,
        details: &MacOsCalendarEventPayload,
    ) -> MacOsCalendarEventWriteResult {
        with_session(|session| update_event(session, event_id, details)).unwrap_or_else(write_error)
    }

    pub(super) fn delete_event_command(event_id: &str) -> MacOsCalendarEventWriteResult {
        with_session(|session| delete_event(session, event_id)).unwrap_or_else(write_error)
    }

    fn with_session<T>(
        operation: impl FnOnce(&Session<'_>) -> Result<T, String>,
    ) -> Result<T, String> {
        let api = eds_api()?;
        let session = Session::new(api)?;
        operation(&session)
    }

    fn create_event(
        session: &Session<'_>,
        details: &MacOsCalendarEventPayload,
        uid: Option<&str>,
    ) -> Result<MacOsCalendarEventWriteResult, String> {
        let source = session
            .ref_source(details.calendar_id.trim())
            .ok_or_else(|| "calendar-unavailable".to_string())?;
        let calendar = connect_calendar(session, source, true)?;
        let uid = uid.map(str::to_string).unwrap_or_else(random_event_uid);
        let component_text = build_event_component(details, &uid)?;
        let component_text = c_string(&component_text, "calendar event")?;
        let component = unsafe { (session.api.cal_util_parse_ics_string)(component_text.as_ptr()) };
        let component =
            ObjectRef::new(session.api, component).ok_or_else(|| "invalid-event".to_string())?;
        let mut created_uid = ptr::null_mut();
        let mut error = ptr::null_mut();
        let ok = unsafe {
            (session.api.cal_client_create_object_sync)(
                calendar.client.ptr,
                component.ptr,
                OPERATION_FLAGS_NONE,
                &mut created_uid,
                ptr::null_mut(),
                &mut error,
            )
        };
        if ok == 0 {
            return Err(unsafe { session.api.take_error(error, "calendar-create-failed") });
        }
        if !error.is_null() {
            unsafe { (session.api.error_free)(error) };
        }
        let final_uid = if created_uid.is_null() {
            uid
        } else {
            let value = unsafe { CStr::from_ptr(created_uid).to_string_lossy().into_owned() };
            unsafe { (session.api.free)(created_uid.cast()) };
            if value.trim().is_empty() {
                uid
            } else {
                value
            }
        };
        Ok(write_ok(Some(encode_event_id(
            details.calendar_id.trim(),
            &final_uid,
        ))))
    }

    fn update_event(
        session: &Session<'_>,
        event_id: &str,
        details: &MacOsCalendarEventPayload,
    ) -> Result<MacOsCalendarEventWriteResult, String> {
        let (old_calendar_id, uid) = decode_event_id(event_id)?;
        let source = session
            .ref_source(&old_calendar_id)
            .ok_or_else(|| "event-not-found".to_string())?;
        let old_calendar = connect_calendar(session, source, true)?;
        if !event_exists(session.api, old_calendar.client.ptr, &uid)? {
            return Err("event-not-found".to_string());
        }

        if old_calendar_id != details.calendar_id.trim() {
            let created = create_event(session, details, None)?;
            let Some(new_event_id) = created.event_id.clone() else {
                return Err("calendar-create-failed".to_string());
            };
            if let Err(error) = remove_event(session.api, old_calendar.client.ptr, &uid) {
                let _ = delete_event(session, &new_event_id);
                return Err(error);
            }
            return Ok(created);
        }

        let component_text = build_event_component(details, &uid)?;
        let component_text = c_string(&component_text, "calendar event")?;
        let component = unsafe { (session.api.cal_util_parse_ics_string)(component_text.as_ptr()) };
        let component =
            ObjectRef::new(session.api, component).ok_or_else(|| "invalid-event".to_string())?;
        let mut error = ptr::null_mut();
        let ok = unsafe {
            (session.api.cal_client_modify_object_sync)(
                old_calendar.client.ptr,
                component.ptr,
                OBJ_MOD_ALL,
                OPERATION_FLAGS_NONE,
                ptr::null_mut(),
                &mut error,
            )
        };
        if ok == 0 {
            return Err(unsafe { session.api.take_error(error, "calendar-update-failed") });
        }
        if !error.is_null() {
            unsafe { (session.api.error_free)(error) };
        }
        Ok(write_ok(Some(event_id.to_string())))
    }

    fn delete_event(
        session: &Session<'_>,
        event_id: &str,
    ) -> Result<MacOsCalendarEventWriteResult, String> {
        let (calendar_id, uid) = decode_event_id(event_id)?;
        let Some(source) = session.ref_source(&calendar_id) else {
            return Ok(write_ok(Some(event_id.to_string())));
        };
        let calendar = connect_calendar(session, source, true)?;
        if !event_exists(session.api, calendar.client.ptr, &uid)? {
            return Ok(write_ok(Some(event_id.to_string())));
        }
        remove_event(session.api, calendar.client.ptr, &uid)?;
        Ok(write_ok(Some(event_id.to_string())))
    }

    fn event_exists(api: &EdsApi, client: *mut c_void, uid: &str) -> Result<bool, String> {
        let uid = c_string(uid, "calendar event ID")?;
        let mut component = ptr::null_mut();
        let mut error = ptr::null_mut();
        let ok = unsafe {
            (api.cal_client_get_object_sync)(
                client,
                uid.as_ptr(),
                ptr::null(),
                &mut component,
                ptr::null_mut(),
                &mut error,
            )
        };
        if !component.is_null() {
            unsafe { (api.object_unref)(component) };
        }
        if ok != 0 {
            if !error.is_null() {
                unsafe { (api.error_free)(error) };
            }
            return Ok(true);
        }
        if error.is_null() {
            return Err("calendar-event-check-failed".to_string());
        }
        let not_found =
            unsafe { is_object_not_found_error(&*error, (api.cal_client_error_quark)()) };
        let message = unsafe { api.take_error(error, "calendar-event-check-failed") };
        if not_found {
            Ok(false)
        } else {
            Err(message)
        }
    }

    fn is_object_not_found_error(error: &GError, calendar_error_domain: u32) -> bool {
        error.domain == calendar_error_domain && error.code == CAL_CLIENT_ERROR_OBJECT_NOT_FOUND
    }

    fn remove_event(api: &EdsApi, client: *mut c_void, uid: &str) -> Result<(), String> {
        let uid = c_string(uid, "calendar event ID")?;
        let mut error = ptr::null_mut();
        let ok = unsafe {
            (api.cal_client_remove_object_sync)(
                client,
                uid.as_ptr(),
                ptr::null(),
                OBJ_MOD_ALL,
                OPERATION_FLAGS_NONE,
                ptr::null_mut(),
                &mut error,
            )
        };
        if ok == 0 {
            return Err(unsafe { api.take_error(error, "calendar-delete-failed") });
        }
        if !error.is_null() {
            unsafe { (api.error_free)(error) };
        }
        Ok(())
    }

    fn build_event_component(
        details: &MacOsCalendarEventPayload,
        uid: &str,
    ) -> Result<String, String> {
        let start = parse_datetime(&details.start)?;
        let end = parse_datetime(&details.end)?;
        if end <= start {
            return Err("invalid-event".to_string());
        }
        let dtstamp = format_datetime(OffsetDateTime::now_utc());
        let title = details.title.trim();
        let title = if title.is_empty() { "Task" } else { title };
        let mut lines = vec![
            "BEGIN:VEVENT".to_string(),
            format!("UID:{}", escape_ics_text(uid)),
            format!("DTSTAMP:{dtstamp}"),
            format!("SUMMARY:{}", escape_ics_text(title)),
        ];
        if details.all_day {
            let start_date = details
                .start_date
                .as_deref()
                .map(parse_date)
                .transpose()?
                .unwrap_or(start.date());
            let end_date = details
                .end_date
                .as_deref()
                .map(parse_date)
                .transpose()?
                .unwrap_or(end.date());
            if end_date <= start_date {
                return Err("invalid-event".to_string());
            }
            lines.push(format!("DTSTART;VALUE=DATE:{}", format_date(start_date)));
            lines.push(format!("DTEND;VALUE=DATE:{}", format_date(end_date)));
        } else {
            lines.push(format!("DTSTART:{}", format_datetime(start)));
            lines.push(format!("DTEND:{}", format_datetime(end)));
        }
        if let Some(notes) = details
            .notes
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            lines.push(format!("DESCRIPTION:{}", escape_ics_text(notes)));
        }
        if let Some(location) = details
            .location
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            lines.push(format!("LOCATION:{}", escape_ics_text(location)));
        }
        lines.push("END:VEVENT".to_string());
        Ok(lines.join("\r\n"))
    }

    fn parse_datetime(value: &str) -> Result<OffsetDateTime, String> {
        OffsetDateTime::parse(value, &Rfc3339)
            .map(|value| value.to_offset(UtcOffset::UTC))
            .map_err(|_| "invalid-event".to_string())
    }

    fn parse_date(value: &str) -> Result<Date, String> {
        let bytes = value.as_bytes();
        if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
            return Err("invalid-event".to_string());
        }
        let year = value[0..4]
            .parse::<i32>()
            .map_err(|_| "invalid-event".to_string())?;
        let month = value[5..7]
            .parse::<u8>()
            .map_err(|_| "invalid-event".to_string())?;
        let day = value[8..10]
            .parse::<u8>()
            .map_err(|_| "invalid-event".to_string())?;
        Date::from_calendar_date(
            year,
            Month::try_from(month).map_err(|_| "invalid-event".to_string())?,
            day,
        )
        .map_err(|_| "invalid-event".to_string())
    }

    fn format_datetime(value: OffsetDateTime) -> String {
        let value = value.to_offset(UtcOffset::UTC);
        format!(
            "{:04}{:02}{:02}T{:02}{:02}{:02}Z",
            value.year(),
            u8::from(value.month()),
            value.day(),
            value.hour(),
            value.minute(),
            value.second(),
        )
    }

    fn format_date(value: Date) -> String {
        format!(
            "{:04}{:02}{:02}",
            value.year(),
            u8::from(value.month()),
            value.day(),
        )
    }

    fn calendar_query(range_start: &str, range_end: &str) -> Result<String, String> {
        let start = parse_datetime(range_start).map_err(|_| "invalid-range".to_string())?;
        let end = parse_datetime(range_end).map_err(|_| "invalid-range".to_string())?;
        if end <= start {
            return Err("invalid-range".to_string());
        }
        Ok(format!(
            "(occur-in-time-range? (make-time \"{}\") (make-time \"{}\"))",
            format_datetime(start),
            format_datetime(end),
        ))
    }

    fn escape_ics_text(value: &str) -> String {
        value
            .replace('\\', "\\\\")
            .replace("\r\n", "\\n")
            .replace(['\r', '\n'], "\\n")
            .replace(';', "\\;")
            .replace(',', "\\,")
    }

    fn random_event_uid() -> String {
        format!("{:032x}@mindwtr", rand::random::<u128>())
    }

    fn encode_event_id(calendar_id: &str, uid: &str) -> String {
        serde_json::to_string(&[calendar_id, uid]).unwrap_or_default()
    }

    fn decode_event_id(event_id: &str) -> Result<(String, String), String> {
        let [calendar_id, uid]: [String; 2] =
            serde_json::from_str(event_id).map_err(|_| "invalid-event-id".to_string())?;
        if calendar_id.trim().is_empty() || uid.trim().is_empty() {
            return Err("invalid-event-id".to_string());
        }
        Ok((calendar_id, uid))
    }

    fn percent_encode(value: &str) -> String {
        let mut encoded = String::new();
        for byte in value.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                encoded.push(char::from(byte));
            } else {
                encoded.push_str(&format!("%{byte:02X}"));
            }
        }
        encoded
    }

    fn write_ok(event_id: Option<String>) -> MacOsCalendarEventWriteResult {
        MacOsCalendarEventWriteResult {
            ok: true,
            event_id,
            error: None,
        }
    }

    fn write_error(error: String) -> MacOsCalendarEventWriteResult {
        MacOsCalendarEventWriteResult {
            ok: false,
            event_id: None,
            error: Some(error),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn details(all_day: bool) -> MacOsCalendarEventPayload {
            MacOsCalendarEventPayload {
                calendar_id: "calendar-id".to_string(),
                title: "Plan, review; ship".to_string(),
                start: "2026-07-21T13:00:00.000Z".to_string(),
                end: "2026-07-21T14:00:00.000Z".to_string(),
                start_date: all_day.then(|| "2026-07-21".to_string()),
                end_date: all_day.then(|| "2026-07-22".to_string()),
                all_day,
                notes: Some("First line\nSecond line".to_string()),
                location: Some("Room 1".to_string()),
            }
        }

        #[test]
        fn builds_timed_event_and_round_trips_native_id() {
            let event = build_event_component(&details(false), "event@example").unwrap();
            assert!(event.contains("DTSTART:20260721T130000Z"));
            assert!(event.contains("SUMMARY:Plan\\, review\\; ship"));
            assert!(event.contains("DESCRIPTION:First line\\nSecond line"));

            let encoded = encode_event_id("calendar:id", "event@example");
            assert_eq!(
                decode_event_id(&encoded).unwrap(),
                ("calendar:id".to_string(), "event@example".to_string())
            );
        }

        #[test]
        fn preserves_local_date_for_all_day_event() {
            let event = build_event_component(&details(true), "event@example").unwrap();
            assert!(event.contains("DTSTART;VALUE=DATE:20260721"));
            assert!(event.contains("DTEND;VALUE=DATE:20260722"));
        }

        #[test]
        fn escapes_ics_text_specials_without_double_escaping_the_backslash() {
            for (raw, expected) in [
                ("plain", "plain"),
                (r"back\slash", r"back\\slash"),
                ("semi;colon", r"semi\;colon"),
                ("comma,separated", r"comma\,separated"),
                ("line\nbreak", r"line\nbreak"),
                ("crlf\r\nbreak", r"crlf\nbreak"),
                ("lone\rreturn", r"lone\nreturn"),
                (r"all\ of; it, \r\n", r"all\\ of\; it\, \\r\\n"),
            ] {
                assert_eq!(escape_ics_text(raw), expected, "escaping {raw:?}");
            }
        }

        #[test]
        fn builds_a_calendar_query_only_for_a_forward_rfc3339_range() {
            assert_eq!(
                calendar_query("2026-07-21T13:00:00.000Z", "2026-07-22T13:00:00.000Z").unwrap(),
                concat!(
                    "(occur-in-time-range? (make-time \"20260721T130000Z\") ",
                    "(make-time \"20260722T130000Z\"))"
                )
            );

            for (start, end) in [
                ("2026-07-21", "2026-07-22T13:00:00.000Z"),
                ("not-a-date", "2026-07-22T13:00:00.000Z"),
                ("2026-07-21T13:00:00.000Z", "2026-07-21T12:00:00.000Z"),
                ("2026-07-21T13:00:00.000Z", "2026-07-21T13:00:00.000Z"),
                ("", ""),
            ] {
                assert_eq!(
                    calendar_query(start, end),
                    Err("invalid-range".to_string()),
                    "range {start:?}..{end:?}"
                );
            }
        }

        #[test]
        fn keeps_writable_backends_and_drops_feed_only_ones() {
            assert!(is_writable_backend(Some("local")));
            assert!(is_writable_backend(Some("caldav")));
            assert!(is_writable_backend(Some("ews")));
            assert!(is_writable_backend(Some("google")));
            assert!(is_writable_backend(None));

            assert!(!is_writable_backend(Some("webcal")));
            assert!(!is_writable_backend(Some(" WebCal ")));
            assert!(!is_writable_backend(Some("weather")));
            assert!(!is_writable_backend(Some("contacts")));
            assert!(!is_writable_backend(Some("birthdays")));
        }

        #[test]
        fn distinguishes_missing_events_from_other_calendar_errors() {
            let calendar_error_domain = 42;
            let missing = GError {
                domain: calendar_error_domain,
                code: CAL_CLIENT_ERROR_OBJECT_NOT_FOUND,
                message: ptr::null_mut(),
            };
            let backend_failure = GError {
                domain: calendar_error_domain,
                code: CAL_CLIENT_ERROR_OBJECT_NOT_FOUND + 1,
                message: ptr::null_mut(),
            };
            let unrelated = GError {
                domain: calendar_error_domain + 1,
                code: CAL_CLIENT_ERROR_OBJECT_NOT_FOUND,
                message: ptr::null_mut(),
            };

            assert!(is_object_not_found_error(&missing, calendar_error_domain));
            assert!(!is_object_not_found_error(
                &backend_failure,
                calendar_error_domain
            ));
            assert!(!is_object_not_found_error(
                &unrelated,
                calendar_error_domain
            ));
        }
    }
}
