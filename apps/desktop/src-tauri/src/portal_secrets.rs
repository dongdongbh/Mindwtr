use fs2::FileExt;
use oo7::{file::Keyring, Secret};
use std::{
    collections::HashMap, fs::OpenOptions, os::unix::fs::OpenOptionsExt, path::Path, sync::OnceLock,
};

static PORTAL_SECRET: OnceLock<Result<Vec<u8>, String>> = OnceLock::new();

fn once_per_process(
    cell: &OnceLock<Result<Vec<u8>, String>>,
    retrieve: impl FnOnce() -> Result<Vec<u8>, String>,
) -> Result<Secret, String> {
    cell.get_or_init(retrieve).clone().map(Secret::from)
}

async fn retrieve_portal_secret() -> Result<Vec<u8>, String> {
    let started = std::time::Instant::now();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(30),
        ashpd::desktop::secret::retrieve(),
    )
    .await
    .map_err(|_| "Secret portal timed out".to_owned())
    .and_then(|answer| {
        answer.map_err(|_| "Secret portal is unavailable or access was declined".to_owned())
    });
    log::info!(
        "Secret portal asked once for this session outcome={} elapsedMs={}",
        if result.is_ok() { "answered" } else { "failed" },
        started.elapsed().as_millis()
    );
    result
}

enum Operation {
    Read,
    Write(Option<String>),
}

pub(crate) fn get(path: &Path, service: &str, account: &str) -> Result<Option<String>, String> {
    run(path, service, account, Operation::Read)
}

pub(crate) fn set(
    path: &Path,
    service: &str,
    account: &str,
    value: Option<String>,
) -> Result<(), String> {
    let value = value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    run(path, service, account, Operation::Write(value)).map(|_| ())
}

fn run(
    path: &Path,
    service: &str,
    account: &str,
    operation: Operation,
) -> Result<Option<String>, String> {
    std::thread::scope(|scope| {
        scope
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .map_err(|_| "Cannot start credential runtime")?;

                let secret = once_per_process(&PORTAL_SECRET, || {
                    runtime.block_on(retrieve_portal_secret())
                })?;
                let parent = path.parent().ok_or("Credential directory is missing")?;
                std::fs::create_dir_all(parent)
                    .map_err(|_| "Cannot create credential directory")?;
                let lock = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .create(true)
                    .truncate(false)
                    .mode(0o600)
                    .open(path.with_extension("lock"))
                    .map_err(|_| "Cannot open credential lock")?;
                lock.lock_exclusive()
                    .map_err(|_| "Cannot lock credential store")?;
                runtime.block_on(execute(path, secret, service, account, operation))
            })
            .join()
            .map_err(|_| "Credential worker failed".to_owned())?
    })
}

async fn read(store: &Keyring, attributes: &HashMap<&str, &str>) -> Result<Option<String>, String> {
    let item = store
        .lookup_item(attributes)
        .await
        .map_err(|_| "Cannot read encrypted credentials")?;
    item.map(|item| {
        String::from_utf8(item.secret().as_bytes().to_vec())
            .map_err(|_| "Stored credential is not valid text".to_owned())
    })
    .transpose()
}

async fn execute(
    path: &Path,
    secret: Secret,
    service: &str,
    account: &str,
    operation: Operation,
) -> Result<Option<String>, String> {
    let store = Keyring::load(path, secret.clone())
        .await
        .map_err(|_| "Cannot unlock encrypted credentials".to_owned())?;
    let attributes = HashMap::from([("service", service), ("account", account)]);
    match operation {
        Operation::Read => read(&store, &attributes).await,
        Operation::Write(value) => {
            match &value {
                Some(value) => store
                    .create_item("Mindwtr credential", &attributes, value.as_str(), true)
                    .await
                    .map(|_| ()),
                None => store.delete(&attributes).await,
            }
            .map_err(|_| "Cannot save encrypted credentials".to_owned())?;

            std::fs::File::open(path.parent().ok_or("Credential directory is missing")?)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| "Cannot persist encrypted credentials".to_owned())?;
            let persisted = Keyring::load(path, secret)
                .await
                .map_err(|_| "Cannot verify encrypted credentials".to_owned())?;
            if read(&persisted, &attributes).await? != value {
                return Err("Encrypted credential verification failed".to_owned());
            }
            log::info!(
                "Portal credential write verified"
            );
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn a_portal_answer_is_asked_once_and_reused_even_when_it_failed() {
        let cell = OnceLock::new();
        let mut asked = 0;
        assert!(once_per_process(&cell, || {
            asked += 1;
            Err("Secret portal timed out".to_owned())
        })
        .is_err());
        assert!(once_per_process(&cell, || {
            asked += 1;
            Ok(vec![1; 64])
        })
        .is_err());
        assert_eq!(asked, 1);
    }

    #[tokio::test]
    async fn encrypted_credentials_survive_reopen_replace_and_delete_without_touching_other_accounts(
    ) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("credentials.keyring");
        let secret = Secret::from(vec![42; 64]);
        for (account, value) in [("dropbox", "test-token"), ("webdav", "other-secret")] {
            execute(
                &path,
                secret.clone(),
                "test:secrets",
                account,
                Operation::Write(Some(value.into())),
            )
            .await
            .unwrap();
        }
        let bytes = std::fs::read(&path).unwrap();
        assert!(!bytes.windows(10).any(|window| window == b"test-token"));
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            execute(
                &path,
                secret.clone(),
                "test:secrets",
                "dropbox",
                Operation::Read
            )
            .await
            .unwrap()
            .as_deref(),
            Some("test-token")
        );
        assert!(execute(
            &path,
            Secret::from(vec![43; 64]),
            "test:secrets",
            "dropbox",
            Operation::Write(Some("wrong".into()))
        )
        .await
        .is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        execute(
            &path,
            secret.clone(),
            "test:secrets",
            "dropbox",
            Operation::Write(Some("replacement".into())),
        )
        .await
        .unwrap();
        assert_eq!(
            execute(
                &path,
                secret.clone(),
                "test:secrets",
                "dropbox",
                Operation::Read
            )
            .await
            .unwrap()
            .as_deref(),
            Some("replacement")
        );
        execute(
            &path,
            secret.clone(),
            "test:secrets",
            "dropbox",
            Operation::Write(None),
        )
        .await
        .unwrap();
        assert_eq!(
            execute(
                &path,
                secret.clone(),
                "test:secrets",
                "dropbox",
                Operation::Read
            )
            .await
            .unwrap(),
            None
        );
        assert_eq!(
            execute(
                &path,
                secret.clone(),
                "test:secrets",
                "webdav",
                Operation::Read
            )
            .await
            .unwrap()
            .as_deref(),
            Some("other-secret")
        );
        assert_eq!(
            execute(
                &path,
                secret,
                "another-app:secrets",
                "webdav",
                Operation::Read
            )
            .await
            .unwrap(),
            None
        );
    }
}
