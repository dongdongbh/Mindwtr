#[cfg(target_os = "linux")]
mod imp {
    use std::collections::HashMap;
    #[cfg(test)]
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::OnceLock;
    use std::time::Duration;

    use tokio::sync::Mutex;
    use zbus::zvariant::Value;
    use zbus::{Connection, Error, Proxy};

    const NOTIFICATION_SERVICE: &str = "org.freedesktop.Notifications";
    const NOTIFICATION_PATH: &str = "/org/freedesktop/Notifications";
    const NOTIFICATION_INTERFACE: &str = "org.freedesktop.Notifications";
    const DELIVERY_TIMEOUT: Duration = Duration::from_secs(5);

    // Embed the pixels rather than relying on an installed icon theme or a resource path:
    // an unintegrated AppImage must also have a logo. Decode this small PNG once.
    fn notification_logo() -> Option<&'static tauri::image::Image<'static>> {
        static LOGO: OnceLock<Option<tauri::image::Image<'static>>> = OnceLock::new();
        LOGO.get_or_init(|| {
            tauri::image::Image::from_bytes(include_bytes!("../icons/64x64.png")).ok()
        })
        .as_ref()
    }

    #[derive(Clone)]
    struct NotificationEndpoint {
        service: String,
        path: String,
        interface: String,
    }

    impl Default for NotificationEndpoint {
        fn default() -> Self {
            Self {
                service: NOTIFICATION_SERVICE.to_string(),
                path: NOTIFICATION_PATH.to_string(),
                interface: NOTIFICATION_INTERFACE.to_string(),
            }
        }
    }

    /// Owns the direct session-bus connection for the app lifetime. A clone is used for each
    /// method call, but every clone shares the same zbus connection and executor.
    pub(crate) struct LinuxNotificationState {
        connection: Mutex<Option<Connection>>,
        /// The daemon's id for the last notification of each tag (one tag per task): passed back as
        /// `replaces_id`, so a task's next reminder replaces the one shown instead of stacking.
        replaced_ids: Mutex<HashMap<String, u32>>,
        endpoint: NotificationEndpoint,
        delivery_timeout: Duration,
        #[cfg(test)]
        connection_creations: AtomicUsize,
    }

    impl Default for LinuxNotificationState {
        fn default() -> Self {
            Self {
                connection: Mutex::new(None),
                replaced_ids: Mutex::new(HashMap::new()),
                endpoint: NotificationEndpoint::default(),
                delivery_timeout: DELIVERY_TIMEOUT,
                #[cfg(test)]
                connection_creations: AtomicUsize::new(0),
            }
        }
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    enum DeliveryError {
        InvalidTitle,
        SessionBusUnavailable,
        ServiceUnavailable,
        DaemonRejected,
        ProtocolError,
        TimedOut,
    }

    impl DeliveryError {
        fn code(self) -> &'static str {
            match self {
                Self::InvalidTitle => "invalid_title",
                Self::SessionBusUnavailable => "session_bus_unavailable",
                Self::ServiceUnavailable => "service_unavailable",
                Self::DaemonRejected => "daemon_rejected",
                Self::ProtocolError => "protocol_error",
                Self::TimedOut => "delivery_timeout",
            }
        }
    }

    impl LinuxNotificationState {
        async fn connection(&self) -> Result<Connection, DeliveryError> {
            let mut slot = self.connection.lock().await;
            if let Some(connection) = slot.as_ref() {
                return Ok(connection.clone());
            }

            let connection = Connection::session()
                .await
                .map_err(|_| DeliveryError::SessionBusUnavailable)?;
            #[cfg(test)]
            self.connection_creations.fetch_add(1, Ordering::SeqCst);
            *slot = Some(connection.clone());
            Ok(connection)
        }

        async fn send_unbounded(
            &self,
            title: &str,
            body: Option<&str>,
            tag: Option<&str>,
        ) -> Result<(), DeliveryError> {
            let connection = self.connection().await?;
            let proxy = Proxy::new(
                &connection,
                self.endpoint.service.as_str(),
                self.endpoint.path.as_str(),
                self.endpoint.interface.as_str(),
            )
            .await
            .map_err(|error| classify_zbus_error(&error))?;

            let actions: Vec<&str> = Vec::new();
            let mut hints: HashMap<&str, Value<'_>> = HashMap::new();
            // Tauri's visible Linux launcher is Mindwtr.desktop; its theme icon is lowercase.
            hints.insert("desktop-entry", Value::from("Mindwtr"));
            let logo = notification_logo();
            if let Some(logo) = logo {
                // Freedesktop image-data: width, height, rowstride, alpha, bits, channels, RGBA.
                hints.insert(
                    "image-data",
                    Value::from((
                        logo.width() as i32,
                        logo.height() as i32,
                        logo.width() as i32 * 4,
                        true,
                        8i32,
                        4i32,
                        logo.rgba(),
                    )),
                );
            }
            let body = body.unwrap_or_default();
            // A daemon that no longer shows the replaced notification (closed, expired) shows this
            // one as new, which is what a reminder wants too.
            let replaces_id = match tag {
                Some(tag) => self
                    .replaced_ids
                    .lock()
                    .await
                    .get(tag)
                    .copied()
                    .unwrap_or(0),
                None => 0,
            };
            let id: u32 = proxy
                .call(
                    "Notify",
                    &(
                        "Mindwtr",
                        replaces_id,
                        "mindwtr",
                        title,
                        body,
                        actions,
                        hints,
                        -1i32,
                    ),
                )
                .await
                .map_err(|error| classify_zbus_error(&error))?;
            if let Some(tag) = tag {
                self.replaced_ids.lock().await.insert(tag.to_string(), id);
            }

            Ok(())
        }

        async fn send(
            &self,
            title: &str,
            body: Option<&str>,
            tag: Option<&str>,
        ) -> Result<(), DeliveryError> {
            let title = title.trim();
            if title.is_empty() {
                return Err(DeliveryError::InvalidTitle);
            }
            let body = body.map(str::trim).filter(|value| !value.is_empty());
            let tag = tag.map(str::trim).filter(|value| !value.is_empty());

            tokio::time::timeout(self.delivery_timeout, self.send_unbounded(title, body, tag))
                .await
                .map_err(|_| DeliveryError::TimedOut)?
        }

        #[cfg(test)]
        fn for_test(service: String, delivery_timeout: Duration) -> Self {
            Self {
                connection: Mutex::new(None),
                replaced_ids: Mutex::new(HashMap::new()),
                endpoint: NotificationEndpoint {
                    service,
                    ..NotificationEndpoint::default()
                },
                delivery_timeout,
                connection_creations: AtomicUsize::new(0),
            }
        }
    }

    fn classify_zbus_error(error: &Error) -> DeliveryError {
        match error {
            Error::MethodError(name, _, _)
                if matches!(
                    name.as_str(),
                    "org.freedesktop.DBus.Error.ServiceUnknown"
                        | "org.freedesktop.DBus.Error.NameHasNoOwner"
                ) =>
            {
                DeliveryError::ServiceUnavailable
            }
            Error::MethodError(_, _, _) => DeliveryError::DaemonRejected,
            Error::InputOutput(_) => DeliveryError::SessionBusUnavailable,
            _ => DeliveryError::ProtocolError,
        }
    }

    pub(crate) async fn send_notification(
        state: &LinuxNotificationState,
        title: String,
        body: Option<String>,
        tag: Option<String>,
    ) -> Result<(), String> {
        state
            .send(&title, body.as_deref(), tag.as_deref())
            .await
            .map_err(|error| error.code().to_string())
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::sync::Arc;

        use zbus::connection::Builder;
        use zbus::zvariant::OwnedValue;

        static SERVICE_SEQUENCE: AtomicUsize = AtomicUsize::new(0);

        #[derive(Clone, Copy)]
        enum MockBehavior {
            Accept,
            Reject,
            Delay(Duration),
        }

        struct MockNotifications {
            behavior: MockBehavior,
            calls: Arc<AtomicUsize>,
            received: Arc<Mutex<Vec<ReceivedNotification>>>,
        }

        #[derive(Debug)]
        struct ReceivedNotification {
            replaces_id: u32,
            app_icon: String,
            hints: HashMap<String, OwnedValue>,
        }

        #[zbus::interface(name = "org.freedesktop.Notifications")]
        impl MockNotifications {
            async fn notify(
                &self,
                _app_name: &str,
                replaces_id: u32,
                app_icon: &str,
                _summary: &str,
                _body: &str,
                _actions: Vec<String>,
                hints: HashMap<String, OwnedValue>,
                _expire_timeout: i32,
            ) -> zbus::fdo::Result<u32> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                self.received.lock().await.push(ReceivedNotification {
                    replaces_id,
                    app_icon: app_icon.to_string(),
                    hints,
                });
                match self.behavior {
                    MockBehavior::Accept => Ok(41),
                    MockBehavior::Reject => Err(zbus::fdo::Error::Failed(
                        "mock rejection includes private task text".to_string(),
                    )),
                    MockBehavior::Delay(delay) => {
                        tokio::time::sleep(delay).await;
                        Ok(42)
                    }
                }
            }
        }

        fn assert_isolated_session() {
            assert_eq!(
                std::env::var("MINDWTR_TEST_ISOLATED_DBUS").as_deref(),
                Ok("1"),
                "run this ignored test through dbus-run-session"
            );
        }

        fn unique_service_name() -> String {
            let sequence = SERVICE_SEQUENCE.fetch_add(1, Ordering::SeqCst);
            format!(
                "org.mindwtr.NotificationTest.p{}.n{sequence}",
                std::process::id()
            )
        }

        async fn mock_service(
            behavior: MockBehavior,
        ) -> (
            Connection,
            LinuxNotificationState,
            Arc<AtomicUsize>,
            Arc<Mutex<Vec<ReceivedNotification>>>,
        ) {
            let service = unique_service_name();
            let calls = Arc::new(AtomicUsize::new(0));
            let received = Arc::new(Mutex::new(Vec::new()));
            let connection = Builder::session()
                .expect("isolated session bus")
                .name(service.as_str())
                .expect("valid test service name")
                .serve_at(
                    NOTIFICATION_PATH,
                    MockNotifications {
                        behavior,
                        calls: calls.clone(),
                        received: received.clone(),
                    },
                )
                .expect("serve notification mock")
                .build()
                .await
                .expect("start notification mock");
            let state = LinuxNotificationState::for_test(service, Duration::from_secs(1));
            (connection, state, calls, received)
        }

        #[ignore = "requires an isolated session bus"]
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn notification_carries_bundled_logo_without_an_installed_icon_theme() {
            assert_isolated_session();
            let (_service, state, _calls, received) = mock_service(MockBehavior::Accept).await;

            send_notification(&state, "Logo test".to_string(), None, None)
                .await
                .expect("Notify acknowledgement");

            let notification = received.lock().await.pop().expect("captured Notify");
            assert_eq!(notification.app_icon, "mindwtr");
            assert_eq!(
                <&str>::try_from(notification.hints.get("desktop-entry").unwrap()).unwrap(),
                "Mindwtr"
            );
            let (width, height, stride, alpha, bits, channels, pixels): (
                i32,
                i32,
                i32,
                bool,
                i32,
                i32,
                Vec<u8>,
            ) = notification.hints["image-data"]
                .try_clone()
                .unwrap()
                .try_into()
                .unwrap();
            assert_eq!(
                (width, height, stride, alpha, bits, channels),
                (64, 64, 256, true, 8, 4)
            );
            assert_eq!(pixels.len(), 64 * 64 * 4);
            let logo = tauri::image::Image::from_bytes(include_bytes!("../icons/64x64.png"))
                .expect("valid bundled PNG");
            assert_eq!(pixels, logo.rgba());
        }

        #[ignore = "requires an isolated session bus"]
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn async_notify_is_acknowledged_and_reuses_one_connection() {
            assert_isolated_session();
            let (_service, state, calls, _received) = mock_service(MockBehavior::Accept).await;

            send_notification(&state, "First".to_string(), None, None)
                .await
                .expect("first Notify acknowledgement");
            send_notification(&state, "Second".to_string(), Some("Body".to_string()), None)
                .await
                .expect("second Notify acknowledgement");

            assert_eq!(calls.load(Ordering::SeqCst), 2);
            assert_eq!(state.connection_creations.load(Ordering::SeqCst), 1);
        }

        #[ignore = "requires an isolated session bus"]
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn a_tagged_reminder_replaces_its_tags_last_notification() {
            assert_isolated_session();
            let (_service, state, _calls, received) = mock_service(MockBehavior::Accept).await;
            let task = Some("mindwtr-reminder:task:a".to_string());

            for (title, tag) in [
                ("Due", task.clone()),
                ("Repeat", task.clone()),
                ("Other task", Some("mindwtr-reminder:task:b".to_string())),
                ("Untagged", None),
            ] {
                send_notification(&state, title.to_string(), None, tag)
                    .await
                    .expect("Notify acknowledgement");
            }

            let replaced: Vec<u32> = received
                .lock()
                .await
                .iter()
                .map(|notification| notification.replaces_id)
                .collect();
            // The mock daemon answers every Notify with id 41.
            assert_eq!(replaced, vec![0, 41, 0, 0]);
        }

        #[ignore = "requires an isolated session bus"]
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn daemon_errors_are_classified_without_remote_text() {
            assert_isolated_session();
            let (_service, state, calls, _received) = mock_service(MockBehavior::Reject).await;

            let error = send_notification(
                &state,
                "Private title".to_string(),
                Some("Private body".to_string()),
                None,
            )
            .await
            .expect_err("mock daemon rejects Notify");

            assert_eq!(error, "daemon_rejected");
            assert!(!error.contains("private"));
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }

        #[ignore = "requires an isolated session bus"]
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn missing_daemon_is_classified() {
            assert_isolated_session();
            let state =
                LinuxNotificationState::for_test(unique_service_name(), Duration::from_secs(1));

            let error = send_notification(&state, "Reminder".to_string(), None, None)
                .await
                .expect_err("no service owns the test name");

            assert_eq!(error, "service_unavailable");
        }

        #[ignore = "requires an isolated session bus"]
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn ambiguous_timeout_is_not_retried() {
            assert_isolated_session();
            let (_service, mut state, calls, _received) =
                mock_service(MockBehavior::Delay(Duration::from_millis(200))).await;
            state.delivery_timeout = Duration::from_millis(20);

            let error = send_notification(&state, "Reminder".to_string(), None, None)
                .await
                .expect_err("mock acknowledgement is delayed past the bound");
            tokio::time::sleep(Duration::from_millis(50)).await;

            assert_eq!(error, "delivery_timeout");
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    #[derive(Default)]
    pub(crate) struct LinuxNotificationState;

    pub(crate) async fn send_notification(
        _state: &LinuxNotificationState,
        _title: String,
        _body: Option<String>,
        _tag: Option<String>,
    ) -> Result<(), String> {
        Err("unsupported_platform".to_string())
    }
}

pub(crate) use imp::{send_notification, LinuxNotificationState};
