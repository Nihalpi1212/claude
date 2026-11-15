//! Where API keys are kept (ported from Nib).
//!
//! * macOS and Windows: the OS credential store (Keychain, Credential Manager) through the
//!   `keyring` crate, service [`service()`] (`<application id>.ai`), account = the provider id.
//! * Linux and the BSDs: [`KEY_FILE`] in Pigment's config folder, created with permissions 0600
//!   (owner read/write only) and replaced atomically. keyring's Secret Service backends need D-Bus
//!   C libraries or an async runtime, which Pigment's pure-Rust build does not take; the file is the
//!   documented fallback, and AI Accounts says the key is kept in a file only you can read. In
//!   portable mode it lives in the portable data folder.
//!
//! A key never leaves this module except through [`ApiKey::expose`], which only the providers
//! call to set the request header. [`ApiKey`]'s `Debug` prints `[redacted]` and it has no
//! `Display` or `Serialize`, so it can't be logged or written by accident.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::{AiError, ErrorKind, ProviderId, Result};

/// The credential store service name: the application id (`brand::APP_ID`) and `.ai`.
pub fn service() -> String {
    format!("{}.ai", photocraft_format::brand::APP_ID)
}

/// The fallback file, in Pigment's config folder.
pub const KEY_FILE: &str = "ai-keys.json";
/// Longest key accepted.
const MAX_KEY_LEN: usize = 512;

/// An API key. Not `Display`, not `Serialize`; `Debug` hides it.
#[derive(Clone, PartialEq, Eq)]
pub struct ApiKey(String);

impl ApiKey {
    /// A key as pasted: trimmed, then refused when empty, too long, or holding spaces or
    /// non-ASCII characters (a pasted sentence, a line break in the middle).
    pub fn new(raw: &str) -> Result<Self> {
        let k = raw.trim();
        if k.is_empty() {
            return Err(AiError::bad_request("Enter an API key."));
        }
        if k.len() > MAX_KEY_LEN || !k.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(AiError::bad_request("An API key contains no spaces or special characters. Check what you pasted."));
        }
        Ok(Self(k.to_string()))
    }

    /// The key itself, for a request header. Nothing else should call this.
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }

    /// The last four characters, for "connected (…abcd)" in AI Accounts; empty for short keys.
    pub fn hint(&self) -> String {
        let n = self.0.chars().count();
        if n < 12 {
            return String::new();
        }
        self.0.chars().skip(n - 4).collect()
    }
}

impl std::fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ApiKey([redacted])")
    }
}

/// A place keys are kept.
pub trait SecretStore: Send + Sync {
    fn get(&self, provider: ProviderId) -> Result<Option<ApiKey>>;
    fn set(&self, provider: ProviderId, key: &ApiKey) -> Result<()>;
    fn clear(&self, provider: ProviderId) -> Result<()>;
    /// What AI Accounts says the keys are kept in ("macOS Keychain", "a file only you can read").
    fn backend(&self) -> &'static str;
}

/// What [`FileStore::backend`] says.
pub const FILE_BACKEND: &str = "a file only you can read";

/// The store for this platform: the OS credential store where there is one, else the file in
/// `config_dir`.
pub fn default_store(config_dir: &Path) -> Box<dyn SecretStore> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let _ = config_dir;
        Box::new(os::OsStore)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Box::new(FileStore::new(config_dir.join(KEY_FILE)))
    }
}

fn store_error(what: &str, e: impl std::fmt::Display) -> AiError {
    AiError::new(ErrorKind::KeyStore, format!("Pigment could not {what} the API key: {e}."))
}

/// Keys in memory only (tests, sessions that save nothing).
#[derive(Default)]
pub struct MemoryStore(Mutex<BTreeMap<&'static str, ApiKey>>);

impl SecretStore for MemoryStore {
    fn get(&self, p: ProviderId) -> Result<Option<ApiKey>> {
        Ok(self.0.lock().map_err(|_| store_error("read", "lock poisoned"))?.get(p.id()).cloned())
    }
    fn set(&self, p: ProviderId, key: &ApiKey) -> Result<()> {
        self.0.lock().map_err(|_| store_error("store", "lock poisoned"))?.insert(p.id(), key.clone());
        Ok(())
    }
    fn clear(&self, p: ProviderId) -> Result<()> {
        self.0.lock().map_err(|_| store_error("remove", "lock poisoned"))?.remove(p.id());
        Ok(())
    }
    fn backend(&self) -> &'static str {
        "memory"
    }
}

/// `{"openai": "…", "gemini": "…"}` in a file only its owner can read.
pub struct FileStore {
    path: PathBuf,
    lock: Mutex<()>,
}

/// Largest key file read (a few keys).
const MAX_FILE: u64 = 64 * 1024;

impl FileStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path, lock: Mutex::new(()) }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn read(&self) -> Result<BTreeMap<String, String>> {
        let meta = match std::fs::metadata(&self.path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
            Err(e) => return Err(store_error("read", e)),
        };
        if meta.len() > MAX_FILE {
            return Err(store_error("read", "the key file is too large"));
        }
        // A key file others can read (copied by hand, restored from a backup) is made owner-only
        // before it is read, best effort: the key still works where the file system has no modes.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o077 != 0 {
                let _ = std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600));
            }
        }
        let text = std::fs::read_to_string(&self.path).map_err(|e| store_error("read", e))?;
        Ok(serde_json::from_str(&text).unwrap_or_default())
    }

    fn write(&self, keys: &BTreeMap<String, String>) -> Result<()> {
        if keys.is_empty() {
            return match std::fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(store_error("remove", e)),
            };
        }
        let dir = self.path.parent().ok_or_else(|| store_error("store", "no folder for the key file"))?;
        std::fs::create_dir_all(dir).map_err(|e| store_error("store", e))?;
        let text = serde_json::to_string_pretty(keys).map_err(|e| store_error("store", e))?;
        let tmp = dir.join(format!(".{KEY_FILE}.{}.tmp", std::process::id()));
        write_private(&tmp, text.as_bytes()).map_err(|e| store_error("store", e))?;
        std::fs::rename(&tmp, &self.path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            store_error("store", e)
        })
    }
}

/// Write `bytes` to a new file at `path` that only its owner can read or write.
pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let _ = std::fs::remove_file(path);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

impl SecretStore for FileStore {
    fn get(&self, p: ProviderId) -> Result<Option<ApiKey>> {
        let _g = self.lock.lock().map_err(|_| store_error("read", "lock poisoned"))?;
        Ok(self.read()?.get(p.id()).and_then(|k| ApiKey::new(k).ok()))
    }
    fn set(&self, p: ProviderId, key: &ApiKey) -> Result<()> {
        let _g = self.lock.lock().map_err(|_| store_error("store", "lock poisoned"))?;
        let mut keys = self.read()?;
        keys.insert(p.id().to_string(), key.expose().to_string());
        self.write(&keys)
    }
    fn clear(&self, p: ProviderId) -> Result<()> {
        let _g = self.lock.lock().map_err(|_| store_error("remove", "lock poisoned"))?;
        let mut keys = self.read()?;
        if keys.remove(p.id()).is_none() {
            return Ok(());
        }
        self.write(&keys)
    }
    fn backend(&self) -> &'static str {
        FILE_BACKEND
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod os {
    use super::{ApiKey, ProviderId, Result, SecretStore, service, store_error};

    /// The OS credential store.
    pub struct OsStore;

    fn entry(p: ProviderId) -> Result<keyring::Entry> {
        keyring::Entry::new(&service(), p.id()).map_err(|e| store_error("open the credential store for", e))
    }

    impl SecretStore for OsStore {
        fn get(&self, p: ProviderId) -> Result<Option<ApiKey>> {
            match entry(p)?.get_password() {
                Ok(k) => Ok(ApiKey::new(&k).ok()),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(store_error("read", e)),
            }
        }
        fn set(&self, p: ProviderId, key: &ApiKey) -> Result<()> {
            entry(p)?.set_password(key.expose()).map_err(|e| store_error("store", e))
        }
        fn clear(&self, p: ProviderId) -> Result<()> {
            match entry(p)?.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(store_error("remove", e)),
            }
        }
        fn backend(&self) -> &'static str {
            if cfg!(target_os = "macos") { "macOS Keychain" } else { "Windows Credential Manager" }
        }
    }
}
