//! Bake the contributor credits into the binary as static Rust tables, and embed the craft-i18n
//! interface catalogs. Nothing is read at run time.
//!
//! - contributors/contributors.json: commit stats per GitHub username, with a mark for whose people.toml
//!   entry is verified.
//! - contributors/people.toml: the names people chose for themselves. A name is used only when the
//!   JSON says the entry was verified (`people_entry`).
//!
//! A missing or malformed file gives empty tables (or no names) and a warning.
//!
//! - `CRAFT_I18N_DIR`, a craft-i18n checkout (storytold/craft-i18n, at the SHA in
//!   `craft-i18n.rev`): `craft_i18n.rs` holds `CRAFT_I18N`, one (locale, shared catalog, PhotoCraft
//!   catalog) entry per locale that has a `photocraft.tsv`. Unset, or not a checkout (a warning),
//!   it is empty and the interface is English only; with `CRAFT_I18N_REQUIRED=1` (CI and releases)
//!   that is an error instead. Recipe: craft-i18n's `docs/integration.md`.
//!
//!   Pigment embeds the catalogs rebranded ([`rebrand_catalog`], docs/FORK.md): the product name
//!   `PhotoCraft` becomes `Pigment` in the English and the translated column alike, so the
//!   rebranded English strings in the code still find their rows, with the case endings some
//!   languages put on the name adjusted. The rebranded copies are written to `OUT_DIR/i18n/`.

use std::fmt::Write as _;

use serde_json::Value;

fn main() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../contributors");
    let json = read(&dir.join("contributors.json"), "the About window shows no contributors", |t| serde_json::from_str::<Value>(t).map_err(|e| e.to_string()))
        .unwrap_or(Value::Null);
    let people =
        read(&dir.join("people.toml"), "contributors are shown by username only", |t| t.parse::<toml::Table>().map_err(|e| e.to_string())).unwrap_or_default();
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap_or_default()).join("credits.rs");
    if let Err(e) = std::fs::write(&out, generate(&json, &people)) {
        println!("cargo::warning=writing {}: {e}", out.display());
    }
    let out = out.with_file_name("craft_i18n.rs");
    if let Err(e) = std::fs::write(&out, craft_i18n()) {
        println!("cargo::error=writing {}: {e}", out.display());
    }
}

/// The catalog this app reads in each locale: `locales/<locale>/photocraft.tsv`.
const APP_CATALOG: &str = "photocraft.tsv";

/// `CRAFT_I18N` from `CRAFT_I18N_DIR`: the `Embedded` list the craft-i18n crate reads.
fn craft_i18n() -> String {
    println!("cargo::rerun-if-env-changed=CRAFT_I18N_DIR");
    println!("cargo::rerun-if-env-changed=CRAFT_I18N_REQUIRED");
    let required = std::env::var("CRAFT_I18N_REQUIRED").is_ok_and(|v| v.trim() == "1");
    let entries = match std::env::var_os("CRAFT_I18N_DIR").filter(|d| !d.is_empty()) {
        // Not canonicalized: on Windows that gives `\\?\C:\…`, which `include_str!` can't read.
        Some(dir) => match locales(&std::path::PathBuf::from(dir).join("locales")) {
            Ok(entries) => entries,
            Err(e) => {
                let level = if required { "error" } else { "warning" };
                println!("cargo::{level}=CRAFT_I18N_DIR: {e}; the interface is English only");
                Vec::new()
            }
        },
        None => {
            if required {
                println!("cargo::error=CRAFT_I18N_REQUIRED=1 but CRAFT_I18N_DIR is unset: a release must embed the translations");
            }
            Vec::new()
        }
    };
    let mut o = String::from("/// (locale, shared catalog, PhotoCraft's catalog), one entry per locale; `\"\"` for a missing file.\n");
    o.push_str("pub static CRAFT_I18N: &craft_i18n::Embedded = &[\n");
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap_or_default()).join("i18n");
    for (code, shared, app) in entries {
        // `{:?}` escapes the path (Windows backslashes) as a Rust string literal.
        let shared = match shared.map(|p| rebranded(&p, &out.join(&code))) {
            None => "\"\"".to_string(),
            Some(Ok(p)) => format!("include_str!({p:?})"),
            Some(Err(e)) => {
                println!("cargo::error={e}");
                "\"\"".to_string()
            }
        };
        match rebranded(&app, &out.join(&code)) {
            Ok(app) => {
                let _ = writeln!(o, "    ({code:?}, {shared}, include_str!({app:?})),");
            }
            Err(e) => println!("cargo::error={e}"),
        }
    }
    o.push_str("];\n");
    o
}

/// The catalog at `from`, rebranded ([`rebrand_catalog`]) into a file of the same name in `dir`:
/// that file's path.
fn rebranded(from: &std::path::Path, dir: &std::path::Path) -> Result<std::path::PathBuf, String> {
    let text = std::fs::read_to_string(from).map_err(|e| format!("reading {}: {e}", from.display()))?;
    let to = dir.join(from.file_name().unwrap_or_default());
    std::fs::create_dir_all(dir).and_then(|()| std::fs::write(&to, rebrand_catalog(&text))).map_err(|e| format!("writing {}: {e}", to.display()))?;
    Ok(to)
}

/// The product name in the catalogs and what Pigment's catalogs say instead.
const UPSTREAM_NAME: &str = "PhotoCraft";
const NAME: &str = "Pigment";

/// Case endings some languages join to the name, as they read after "Pigment" (vowel harmony in
/// Finnish, Hungarian and Turkish; the particle after a final consonant in Korean). Any other
/// ending is kept as it is (`PhotoCraftu` → `Pigmentu`, `PhotoCraft-ში` → `Pigment-ში`).
const INFLECTIONS: &[(&str, &str)] = &[
    ("ia", "iä"),     // fi partitive
    ("issa", "issä"), // fi inessive
    ("ista", "istä"), // fi elative
    ("ban", "ben"),   // hu inessive
    ("ból", "ből"),   // hu elative
    ("'ın", "'in"),   // tr genitive
    ("'ı", "'i"),     // tr accusative
    ("'a", "'e"),     // tr dative
    ("가", "이"),     // ko subject particle
    ("는", "은"),     // ko topic particle
    ("를", "을"),     // ko object particle
    ("와", "과"),     // ko "and"
    ("로", "으로"),   // ko "with/to"
];

/// PhotoCraft's native extension in interface text, and Pigment's: the two hold the same format,
/// and Pigment's interface names its own (Save Full-Size Composite in .pigment Files).
const EXTENSION: (&str, &str) = (".pcraft", ".pigment");

/// The name as Tamil writes it, without its last vowel sign, and Pigment's.
const TAMIL: (&str, &str) = ("போட்டோகிராப்ட", "பிக்மென்ட");

/// A craft-i18n catalog with the product name rebranded on every row (both columns; comment lines
/// are left as they are), and `.pcraft` named `.pigment` ([`EXTENSION`]). `PhotoCraft` as a word, not inside an identifier (`PhotoCraft_x`,
/// `xPhotoCraft` with an ASCII `x`), becomes `Pigment` with its case ending (see [`INFLECTIONS`]).
fn rebrand_catalog(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        if line.starts_with('#') || !(line.contains(UPSTREAM_NAME) || line.contains(TAMIL.0) || line.contains(EXTENSION.0)) {
            out.push_str(line);
            continue;
        }
        let line = line.replace(TAMIL.0, TAMIL.1).replace(EXTENSION.0, EXTENSION.1);
        let mut rest = line.as_str();
        while let Some(i) = rest.find(UPSTREAM_NAME) {
            let (before, after) = (&rest[..i], &rest[i + UPSTREAM_NAME.len()..]);
            out.push_str(before);
            // Only an ASCII letter or digit joins the name into an identifier: Thai and Khmer write it
            // straight after a word (`อัพเดตPhotoCraft`).
            let joined = |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '%');
            if joined(before.chars().next_back()) || after.starts_with('_') {
                out.push_str(UPSTREAM_NAME);
                rest = after;
                continue;
            }
            out.push_str(NAME);
            rest = after;
            if let Some((from, to)) =
                INFLECTIONS.iter().find(|(from, _)| after.strip_prefix(from).is_some_and(|tail| !tail.chars().next().is_some_and(char::is_alphabetic)))
            {
                out.push_str(to);
                rest = &after[from.len()..];
            }
        }
        out.push_str(rest);
    }
    out
}

/// One embedded locale: its code, its `common.tsv` if it has one, and its PhotoCraft catalog.
type Locale = (String, Option<std::path::PathBuf>, std::path::PathBuf);

/// Every locale under `dir` with PhotoCraft's catalog, by code. An error when `dir` isn't a
/// craft-i18n `locales/` directory.
fn locales(dir: &std::path::Path) -> Result<Vec<Locale>, String> {
    // Build scripts run in the crate's directory and `include_str!` resolves against the
    // generated file, so a relative path would mean two different places.
    if !dir.is_absolute() {
        return Err(format!("{} is not an absolute path", dir.display()));
    }
    // Before read_dir, so a checkout that appears later reruns the script.
    println!("cargo::rerun-if-changed={}", dir.display());
    let list = std::fs::read_dir(dir).map_err(|e| format!("{} is not a craft-i18n checkout ({e})", dir.display()))?;
    let mut out = Vec::new();
    for entry in list.flatten() {
        let path = entry.path();
        let Some(code) = path.file_name().and_then(|n| n.to_str()).map(str::to_string) else { continue };
        let app = path.join(APP_CATALOG);
        if !app.is_file() {
            continue;
        }
        println!("cargo::rerun-if-changed={}", app.display());
        let shared = Some(path.join("common.tsv")).filter(|p| p.is_file());
        if let Some(p) = &shared {
            println!("cargo::rerun-if-changed={}", p.display());
        }
        out.push((code, shared, app));
    }
    if out.is_empty() {
        return Err(format!("{} has no locale with a {APP_CATALOG}", dir.display()));
    }
    out.sort();
    Ok(out)
}

fn read<T>(path: &std::path::Path, fallback: &str, parse: impl Fn(&str) -> Result<T, String>) -> Option<T> {
    println!("cargo::rerun-if-changed={}", path.display());
    let r = std::fs::read_to_string(path).map_err(|e| e.to_string()).and_then(|t| parse(&t));
    if let Err(e) = &r {
        println!("cargo::warning={}: {e}; {fallback}", path.display());
    }
    r.ok()
}

/// A non-empty string field of someone's people.toml entry, as a Rust `Option<&str>` literal.
fn name(v: Option<&str>) -> String {
    match v.map(str::trim).filter(|s| !s.is_empty()) {
        Some(x) => format!("Some({x:?})"),
        None => "None".into(),
    }
}

fn s(v: &Value, k: &str) -> String {
    format!("{:?}", v.get(k).and_then(Value::as_str).unwrap_or(""))
}

fn n(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

fn rows(json: &Value, k: &str) -> Vec<Value> {
    json.get(k).and_then(Value::as_array).cloned().unwrap_or_default()
}

fn generate(json: &Value, people: &toml::Table) -> String {
    let mut o = String::new();
    let _ = writeln!(o, "pub static TOTAL_COMMITS: u64 = {};", n(json, "commits"));
    let _ = writeln!(o, "pub static CONTRIBUTORS: &[Contributor] = &[");
    for c in rows(json, "contributors") {
        let login = c.get("login").and_then(Value::as_str).unwrap_or("");
        if login.is_empty() {
            continue;
        }
        // Names only from a verified, self-chosen people.toml entry.
        let entry = people.get("people").and_then(|p| p.get(login)).filter(|_| c.get("people_entry").and_then(Value::as_bool) == Some(true));
        let field = |k: &str| entry.and_then(|e| e.get(k)).and_then(toml::Value::as_str);
        let synced = entry.and_then(|e| e.get("sync_github_name")).and_then(toml::Value::as_bool) == Some(true);
        let display =
            field("display_name").filter(|s| !s.trim().is_empty()).or_else(|| if synced { c.get("github_name").and_then(Value::as_str) } else { None });
        let _ = writeln!(
            o,
            "    Contributor {{ login: {login:?}, display_name: {}, real_name: {}, prs: {}, commits: {}, lines_added: {}, lines_deleted: {}, binary_added: {}, binary_deleted: {}, first_commit: {}, last_commit: {} }},",
            name(display),
            name(field("real_name")),
            n(&c, "prs"),
            n(&c, "commits"),
            n(&c, "lines_added"),
            n(&c, "lines_deleted"),
            n(&c, "binary_added"),
            n(&c, "binary_deleted"),
            s(&c, "first_commit"),
            s(&c, "last_commit"),
        );
    }
    let _ = writeln!(o, "];");
    let _ = writeln!(o, "pub static MODELS: &[Model] = &[");
    for m in rows(json, "models") {
        let _ = writeln!(
            o,
            "    Model {{ company: {}, model: {}, version: {}, commits: {}, lines_added: {}, lines_deleted: {} }},",
            s(&m, "company"),
            s(&m, "model"),
            s(&m, "version"),
            n(&m, "commits"),
            n(&m, "lines_added"),
            n(&m, "lines_deleted"),
        );
    }
    let _ = writeln!(o, "];");
    o
}
