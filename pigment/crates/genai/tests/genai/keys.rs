//! Key handling: validation, the 0600 key file, accounts status that never shows a key, settings
//! that never hold one, and the platform store.

use pigment_genai::keys::{ApiKey, FileStore, KEY_FILE, MemoryStore, SecretStore};
use pigment_genai::provider::ModelKind;
use pigment_genai::settings::PromptFeature;
use pigment_genai::{AiAccounts, AiSettings, ErrorKind, ProviderId};

use crate::common::{GEMINI_KEY, OPENAI_KEY, temp_dir};

#[test]
fn keys_are_checked_and_never_printed() {
    let k = ApiKey::new(&format!("  {OPENAI_KEY}\n")).unwrap();
    assert_eq!(format!("{k:?}"), "ApiKey([redacted])");
    assert_eq!(k.hint(), "WXYZ");
    assert_eq!(ApiKey::new("short1").unwrap().hint(), "");
    for bad in ["", "   ", "sk-abc def", "sk-ünïcode", &"x".repeat(600)] {
        assert_eq!(ApiKey::new(bad).unwrap_err().kind, ErrorKind::BadRequest, "{bad:?}");
    }
    // The credential store service is the application id's.
    assert_eq!(pigment_genai::keys::service(), format!("{}.ai", photocraft_format::brand::APP_ID));
}

#[test]
fn the_key_file_is_private_and_atomic() {
    let dir = temp_dir("file");
    assert_eq!(KEY_FILE, "ai-keys.json");
    let store = FileStore::new(dir.join(KEY_FILE));
    assert!(store.get(ProviderId::OpenAi).unwrap().is_none());
    store.set(ProviderId::OpenAi, &ApiKey::new(OPENAI_KEY).unwrap()).unwrap();
    store.set(ProviderId::Gemini, &ApiKey::new(GEMINI_KEY).unwrap()).unwrap();
    assert_eq!(store.get(ProviderId::OpenAi).unwrap(), Some(ApiKey::new(OPENAI_KEY).unwrap()));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(store.path()).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "{mode:o}");
    }
    // No temporary file is left behind.
    let names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec![KEY_FILE.to_string()]);
    store.clear(ProviderId::OpenAi).unwrap();
    assert!(store.get(ProviderId::OpenAi).unwrap().is_none());
    assert!(store.get(ProviderId::Gemini).unwrap().is_some());
    store.clear(ProviderId::Gemini).unwrap();
    assert!(!store.path().exists(), "the file goes with the last key");
    // A damaged file reads as no keys rather than failing.
    std::fs::write(store.path(), "{oops").unwrap();
    assert!(store.get(ProviderId::OpenAi).unwrap().is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(unix)]
#[test]
fn a_key_file_others_can_read_is_made_private_when_read() {
    use std::os::unix::fs::PermissionsExt;
    let dir = temp_dir("loose");
    let store = FileStore::new(dir.join(KEY_FILE));
    std::fs::write(store.path(), format!("{{\"openai\":\"{OPENAI_KEY}\"}}")).unwrap();
    std::fs::set_permissions(store.path(), std::fs::Permissions::from_mode(0o644)).unwrap();
    assert_eq!(store.get(ProviderId::OpenAi).unwrap(), Some(ApiKey::new(OPENAI_KEY).unwrap()), "the key still works");
    let mode = std::fs::metadata(store.path()).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600, "{mode:o}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn accounts_report_status_without_keys() {
    let mut a = AiAccounts::in_memory();
    assert_eq!(a.default_provider(), None);
    assert_eq!(a.provider(ProviderId::Gemini).err().unwrap().kind, ErrorKind::MissingKey);
    a.set_key(ProviderId::Gemini, GEMINI_KEY).unwrap();
    assert_eq!(a.default_provider(), Some(ProviderId::Gemini), "the first provider with a key");
    a.settings.default_provider = Some(ProviderId::OpenAi);
    assert_eq!(a.default_provider(), Some(ProviderId::Gemini), "a preferred provider without a key gives way");
    a.set_key(ProviderId::OpenAi, OPENAI_KEY).unwrap();
    assert_eq!(a.default_provider(), Some(ProviderId::OpenAi));
    let status = a.status();
    let text = serde_json::to_string(&status).unwrap();
    assert!(!text.contains(OPENAI_KEY) && !text.contains(GEMINI_KEY), "{text}");
    assert!(status.iter().all(|s| s.connected));
    assert_eq!(status[0].hint, "WXYZ");
    assert!(status[0].is_default && !status[1].is_default);
    // Automatic models show the known model until a catalog was read.
    assert_eq!((status[1].chat_model.as_str(), status[1].chat_model_automatic), ("gemini-2.5-flash", true));
    a.cache_catalog(
        ProviderId::OpenAi,
        vec![
            pigment_genai::ModelInfo { id: "gpt-image-1.5-2025".into(), kind: ModelKind::Image },
            pigment_genai::ModelInfo { id: "gpt-image-1".into(), kind: ModelKind::Image },
        ],
    );
    assert_eq!(a.shown_model(ProviderId::OpenAi, ModelKind::Image), ("gpt-image-1".to_string(), true), "an exact preferred id before a prefix match");
    a.clear_key(ProviderId::OpenAi).unwrap();
    assert!(!a.has_key(ProviderId::OpenAi));
    assert!(a.set_base_url(ProviderId::OpenAi, "https://evil.example/v1").is_err(), "only loopback replaces the address");
    assert!(a.set_models(ProviderId::Gemini, Some("bad model id!"), None).is_err());
}

#[test]
fn settings_never_hold_keys_and_survive_a_restart() {
    let dir = temp_dir("settings");
    let mut a = AiAccounts::with_store(Box::new(MemoryStore::default()), AiSettings::default(), Some(dir.clone()));
    a.set_key(ProviderId::OpenAi, OPENAI_KEY).unwrap();
    a.set_default_provider(ProviderId::Gemini).unwrap();
    a.set_models(ProviderId::OpenAi, Some("gpt-4.1"), Some("")).unwrap();
    a.set_consented(true).unwrap();
    a.set_allow_agents(true).unwrap();
    a.settings.set_last_prompt(PromptFeature::Sky, &format!("  a stormy sky {}", "x".repeat(5000)));
    assert!(a.settings.assistant_attach, "the Assistant attaches the image until that is turned off");
    a.settings.assistant_attach = false;
    a.save().unwrap();
    let text = std::fs::read_to_string(AiSettings::path(&dir)).unwrap();
    assert!(!text.contains(OPENAI_KEY), "{text}");
    for field in ["defaultProvider", "imageProvider", "chatProvider", "chatModel", "imageModel", "allowAgents", "lastSkyPrompt", "timeoutSecs"] {
        assert!(text.contains(field), "{field} in {text}");
    }
    let back = AiSettings::load(&dir);
    assert_eq!(back.default_provider, Some(ProviderId::Gemini));
    assert_eq!((back.image_provider, back.chat_provider), (Some(ProviderId::Gemini), Some(ProviderId::Gemini)), "the preferred provider resets both");
    assert_eq!(back.openai.chat_model.as_deref(), Some("gpt-4.1"));
    assert_eq!(back.openai.image_model, None, "an empty model is automatic");
    assert!(back.consented && back.allow_agents && !back.assistant_attach);
    assert!(text.contains("\"assistantAttach\": false"), "{text}");
    let older: AiSettings = serde_json::from_str("{\"consented\":true}").unwrap();
    assert!(older.consented && older.assistant_attach, "a settings file from before the Assistant");
    let sky = back.last_prompt(PromptFeature::Sky).unwrap();
    assert!(sky.starts_with("a stormy sky") && sky.chars().count() == 4000, "trimmed and cut to the prompt limit");
    assert_eq!(PromptFeature::of_command("ai.replaceSky"), Some(PromptFeature::Sky));
    // Another process changed the file: reload sees it.
    let mut other = back.clone();
    other.allow_agents = false;
    other.save(&dir).unwrap();
    a.reload();
    assert!(!a.settings.allow_agents);
    // A missing or damaged file gives the defaults.
    std::fs::write(AiSettings::path(&dir), "[]").unwrap();
    assert_eq!(AiSettings::load(&dir), AiSettings::default());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn platform_store_on_this_system() {
    let dir = temp_dir("platform");
    let store = pigment_genai::keys::default_store(&dir);
    if cfg!(any(target_os = "macos", target_os = "windows")) {
        assert_ne!(store.backend(), pigment_genai::keys::FILE_BACKEND);
    } else {
        assert_eq!(store.backend(), pigment_genai::keys::FILE_BACKEND);
        store.set(ProviderId::Gemini, &ApiKey::new(GEMINI_KEY).unwrap()).unwrap();
        assert!(dir.join(KEY_FILE).exists());
        store.clear(ProviderId::Gemini).unwrap();
    }
    let _ = std::fs::remove_dir_all(&dir);
}

/// The OS credential store round trip; ignored because CI's macOS and Windows runners may have no
/// unlocked keychain (run it by hand there with `--ignored`).
#[test]
#[ignore = "touches the real OS credential store"]
fn os_store_round_trip() {
    let dir = temp_dir("os");
    let store = pigment_genai::keys::default_store(&dir);
    store.set(ProviderId::Gemini, &ApiKey::new(GEMINI_KEY).unwrap()).unwrap();
    assert_eq!(store.get(ProviderId::Gemini).unwrap(), Some(ApiKey::new(GEMINI_KEY).unwrap()));
    store.clear(ProviderId::Gemini).unwrap();
    assert!(store.get(ProviderId::Gemini).unwrap().is_none());
    let _ = std::fs::remove_dir_all(&dir);
}
