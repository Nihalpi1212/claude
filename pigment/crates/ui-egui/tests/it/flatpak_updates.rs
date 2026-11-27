//! Release and source Flatpaks agree on their permissions. Pigment installs no updates and never
//! reads the ArtCraft Launcher's folders (docs/FORK.md), so neither has update or launcher access.
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
        include_str!("../../../../packaging/linux/flatpak/io.github.nihalpi1212.pigment.bundle.yml"),
        include_str!("../../../../packaging/linux/flatpak/io.github.nihalpi1212.pigment.yml"),
    ];
    let args = manifests.map(finish_args);
    assert_eq!(args[0], args[1], "source and release permissions must agree");
    for permissions in args {
        // Printing to a CUPS server and the --control server still need the network.
        assert!(permissions.contains(&"--share=network"), "{permissions:?}");
        for removed in ["--talk-name=org.freedesktop.Flatpak", "--filesystem=xdg-data/ArtCraft/versions:ro"] {
            assert!(!permissions.contains(&removed), "Pigment has no update or launcher permission: {removed}");
        }
        assert!(!permissions.iter().any(|p| p.contains("ArtCraft")), "{permissions:?}");
    }
}
