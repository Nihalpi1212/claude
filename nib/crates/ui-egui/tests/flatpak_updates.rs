//! Release and source Flatpaks agree on their permissions, and give Nib no host update helper:
//! Nib never updates itself (see docs/FORK.md).
fn finish_args(manifest: &str) -> Vec<&str> {
    manifest
        .split("finish-args:")
        .nth(1)
        .unwrap_or_default()
        .lines()
        .take_while(|line| line.is_empty() || line.starts_with(' ') || line.starts_with('#'))
        .filter_map(|line| line.trim().strip_prefix("- "))
        .map(|arg| arg.trim_matches(['\'', '"']))
        .collect()
}

#[test]
fn flatpak_update_permissions() {
    let manifests = [
        include_str!("../../../packaging/linux/flatpak/io.github.nihalpi1212.nib.bundle.yml"),
        include_str!("../../../packaging/linux/flatpak/io.github.nihalpi1212.nib.yml"),
    ];
    let args = manifests.map(finish_args);
    assert_eq!(args[0], args[1], "source and release permissions must agree");
    for permissions in args {
        // Network stays for printing to a CUPS server over the network (lp).
        assert!(permissions.contains(&"--share=network"), "missing network for printing");
        for forbidden in ["--talk-name=org.freedesktop.Flatpak", "--filesystem=xdg-data/ArtCraft/versions:ro"] {
            assert!(!permissions.contains(&forbidden), "an update permission is left: {forbidden}");
        }
    }
}
