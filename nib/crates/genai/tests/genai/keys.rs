//! Key handling: validation, the 0600 key file, accounts status that never shows a key, settings
//! that never hold one.

use nib_genai::keys::{ApiKey, FileStore, KEY_FILE, SecretStore};
use nib_genai::{AiAccounts, AiSettings, ErrorKind, ProviderKind};

use crate::common::{GEMINI_KEY, OPENAI_KEY};

fn temp_dir(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("nib-genai-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn keys_are_checked_and_never_printed() {
    let k = ApiKey::new(&format!("  {OPENAI_KEY}\n")).unwrap();
    assert_eq!(format!("{k:?}"), "ApiKey([redacted])");
    assert_eq!(k.hint(), "WXYZ");
    assert_eq!(ApiKey::new("short1").unwrap().hint(), "");
    for bad in ["", "   ", "sk-abc def", "sk-ünïcode", &"x".repeat(600)] {
        assert_eq!(ApiKey::new(bad).unwrap_err().kind, ErrorKind::BadRequest, "{bad:?}");
    }
}

#[test]
fn the_key_file_is_private_and_atomic() {
    let dir = temp_dir("file");
    let store = FileStore::new(dir.join(KEY_FILE));
    assert!(store.get(ProviderKind::OpenAi).unwrap().is_none());
    store.set(ProviderKind::OpenAi, &ApiKey::new(OPENAI_KEY).unwrap()).unwrap();
    store.set(ProviderKind::Gemini, &ApiKey::new(GEMINI_KEY).unwrap()).unwrap();
    assert_eq!(store.get(ProviderKind::OpenAi).unwrap(), Some(ApiKey::new(OPENAI_KEY).unwrap()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(store.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{mode:o}");
    }
    // No temporary file is left behind.
    let names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec![KEY_FILE.to_string()]);
    store.clear(ProviderKind::OpenAi).unwrap();
    assert!(store.get(ProviderKind::OpenAi).unwrap().is_none());
    assert!(store.get(ProviderKind::Gemini).unwrap().is_some());
    store.clear(ProviderKind::Gemini).unwrap();
    assert!(!store.path().exists(), "the file goes with the last key");
    // A damaged file reads as no keys rather than failing.
    std::fs::write(store.path(), "{oops").unwrap();
    assert!(store.get(ProviderKind::OpenAi).unwrap().is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn accounts_report_status_without_keys() {
    let mut a = AiAccounts::in_memory();
    assert_eq!(a.default_provider(), None);
    assert_eq!(a.provider(None).err().unwrap().kind, ErrorKind::MissingKey);
    assert_eq!(a.provider(Some(ProviderKind::Gemini)).err().unwrap().kind, ErrorKind::MissingKey);
    a.set_key(ProviderKind::Gemini, GEMINI_KEY).unwrap();
    assert_eq!(a.default_provider(), Some(ProviderKind::Gemini), "the first provider with a key");
    a.settings.default_provider = Some(ProviderKind::OpenAi);
    assert_eq!(a.default_provider(), Some(ProviderKind::Gemini), "a default without a key gives way");
    a.set_key(ProviderKind::OpenAi, OPENAI_KEY).unwrap();
    assert_eq!(a.default_provider(), Some(ProviderKind::OpenAi));
    let status = a.status();
    let text = serde_json::to_string(&status).unwrap();
    assert!(!text.contains(OPENAI_KEY) && !text.contains(GEMINI_KEY), "{text}");
    assert!(status.iter().all(|s| s.connected));
    assert_eq!(status[0].hint, "WXYZ");
    assert!(status[0].is_default && !status[1].is_default);
    assert_eq!(status[1].text_model, "gemini-2.5-flash");
    a.clear_key(ProviderKind::OpenAi).unwrap();
    assert!(!a.has_key(ProviderKind::OpenAi));
    assert!(a.set_base_url(ProviderKind::OpenAi, "https://evil.example/v1").is_err(), "only loopback replaces the address");
    assert!(a.set_models(ProviderKind::Gemini, Some("bad model id!"), None).is_err());
}

#[test]
fn settings_never_hold_keys_and_survive_a_restart() {
    let dir = temp_dir("settings");
    let mut a = AiAccounts::with_store(Box::new(nib_genai::keys::MemoryStore::default()), AiSettings::default(), Some(dir.clone()));
    a.set_key(ProviderKind::OpenAi, OPENAI_KEY).unwrap();
    a.set_default_provider(ProviderKind::OpenAi).unwrap();
    a.set_models(ProviderKind::OpenAi, Some("gpt-4.1"), Some("")).unwrap();
    a.set_consented(true).unwrap();
    let text = std::fs::read_to_string(AiSettings::path(&dir)).unwrap();
    assert!(!text.contains(OPENAI_KEY), "{text}");
    let back = AiSettings::load(&dir);
    assert_eq!(back.default_provider, Some(ProviderKind::OpenAi));
    assert_eq!(back.openai.text, "gpt-4.1");
    assert_eq!(back.openai.image, "gpt-image-1", "an empty model goes back to the default");
    assert!(back.consented);
    assert_eq!(back.provider_config(ProviderKind::OpenAi).text_model, "gpt-4.1");
    // A missing or damaged file gives the defaults.
    std::fs::write(AiSettings::path(&dir), "[]").unwrap();
    assert_eq!(AiSettings::load(&dir), AiSettings::default());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn platform_store_on_this_system() {
    let dir = temp_dir("platform");
    let store = nib_genai::keys::default_store(&dir);
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        assert_ne!(store.backend(), "file");
    } else {
        assert_eq!(store.backend(), "file");
        store.set(ProviderKind::Gemini, &ApiKey::new(GEMINI_KEY).unwrap()).unwrap();
        assert!(dir.join(KEY_FILE).exists());
        store.clear(ProviderKind::Gemini).unwrap();
    }
    let _ = std::fs::remove_dir_all(&dir);
}
