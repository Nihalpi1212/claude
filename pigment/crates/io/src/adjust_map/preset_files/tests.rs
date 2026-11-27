use photocraft_doc::Adjustment;
use photocraft_doc::adjust::{CurvePoint, HueRange, LevelsChannel, ToneSpace};

use super::{KINDS, extension, kind_for_extension, read, write};

const FIXTURES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/adjust-presets");

fn fixture(name: &str) -> Vec<u8> {
    std::fs::read(format!("{FIXTURES}/{name}")).unwrap_or_else(|e| panic!("{name}: {e}"))
}

fn pts(p: &[(u16, u16)]) -> Vec<CurvePoint> {
    p.iter().map(|&(i, o)| CurvePoint { input: f32::from(i) / 255.0, output: f32::from(o) / 255.0 }).collect()
}

fn lv(in_black: u16, in_white: u16, gamma: f32, out_black: u16, out_white: u16) -> LevelsChannel {
    let l = |v: u16| f32::from(v) / 255.0;
    LevelsChannel { in_black: l(in_black), in_white: l(in_white), gamma, out_black: l(out_black), out_white: l(out_white) }
}

fn line() -> Vec<CurvePoint> {
    pts(&[(0, 0), (255, 255)])
}

fn kind_of(adj: &Adjustment) -> &'static str {
    match adj {
        Adjustment::Levels { .. } => "levels",
        Adjustment::Curves { .. } => "curves",
        Adjustment::HueSaturation { .. } => "hueSaturation",
        Adjustment::ChannelMixer { .. } => "channelMixer",
        Adjustment::SelectiveColor { .. } => "selectiveColor",
        Adjustment::BlackWhite { .. } => "blackWhite",
        _ => "other",
    }
}

/// One non-trivial setting of each kind with a file.
fn settings() -> Vec<Adjustment> {
    let mut ranges = HueRange::defaults();
    ranges[0] = HueRange { hue: 10.0, saturation: 30.0, lightness: -5.0, bounds: HueRange::canonical_bounds([310.0, 340.0, 20.0, 50.0]) };
    ranges[4].saturation = -40.0;
    let mut selective = [[0.0; 4]; 9];
    selective[0] = [-20.0, 10.0, 30.0, 0.0];
    selective[7] = [0.0, 0.0, 0.0, 15.0];
    vec![
        Adjustment::Curves {
            master: pts(&[(0, 0), (64, 40), (192, 220), (255, 255)]),
            per_channel: [pts(&[(0, 0), (128, 150), (255, 255)]), line(), pts(&[(0, 20), (255, 235)])],
            space: ToneSpace::Rgb,
            black: Vec::new(),
            pencil: false,
        },
        Adjustment::Levels {
            master: lv(12, 240, 1.2, 5, 250),
            per_channel: [lv(20, 255, 0.8, 0, 255), LevelsChannel::default(), lv(0, 255, 1.0, 0, 230)],
            space: ToneSpace::Rgb,
            black: LevelsChannel::default(),
        },
        Adjustment::HueSaturation { hue: 205.0, saturation: 30.0, lightness: -10.0, colorize: true, ranges },
        Adjustment::ChannelMixer { matrix: [[0.5, 0.3, 0.2, 0.05], [0.0, 1.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0]], monochrome: true },
        Adjustment::SelectiveColor { relative: false, adjustments: selective },
        Adjustment::BlackWhite { weights: [55.0, 70.0, 30.0, 60.0, -10.0, 90.0], tint: Some([0.625, 0.5, 0.375]) },
    ]
}

#[test]
fn every_kind_writes_and_reads_back_the_same_setting() {
    for adj in settings() {
        let kind = kind_of(&adj);
        let bytes = write(&adj).unwrap_or_else(|e| panic!("{kind}: {e}"));
        let (back, report) = read(kind, &bytes).unwrap_or_else(|e| panic!("{kind}: {e}"));
        assert_eq!(back, adj, "{kind}");
        assert!(report.is_empty(), "{kind}: {report:?}");
    }
}

#[test]
fn file_sizes_are_photoshops() {
    let size = |kind: &str| write(settings().iter().find(|a| kind_of(a) == kind).unwrap()).unwrap().len();
    assert_eq!(size("levels"), 2 + 29 * 10);
    assert_eq!(size("hueSaturation"), 100);
    assert_eq!(size("channelMixer"), 44);
    assert_eq!(size("selectiveColor"), 84);
    // Version, count, then (count, points) per curve: 4 + 3 + 2 + 2 points.
    assert_eq!(size("curves"), 4 + (2 + 4 * 4) + (2 + 3 * 4) + (2 + 2 * 4) + (2 + 2 * 4));
    let blw = write(settings().iter().find(|a| kind_of(a) == "blackWhite").unwrap()).unwrap();
    assert_eq!(&blw[..6], &[0, 1, 0, 0, 0, 16]);
}

#[test]
fn kinds_and_extensions() {
    assert_eq!(KINDS.len(), 6);
    assert_eq!(extension("curves"), Some("acv"));
    assert_eq!(extension("exposure"), None);
    assert_eq!(kind_for_extension("BLW"), Some("blackWhite"));
    assert_eq!(kind_for_extension("hdt"), None);
    assert!(write(&Adjustment::Exposure { exposure: 1.0, offset: 0.0, gamma: 1.0 }).unwrap_err().contains("Exposure"));
    assert!(read("exposure", &[0; 64]).is_err());
}

// ------------------------------------------------------------------ files the JavaScript Pigment wrote

#[test]
fn reads_the_javascript_curves_file() {
    let (adj, report) = read("curves", &fixture("curves.acv")).unwrap();
    assert!(report.is_empty());
    let Adjustment::Curves { master, per_channel, space, pencil, .. } = adj else { panic!("{adj:?}") };
    assert_eq!(master, pts(&[(0, 0), (64, 40), (192, 220), (255, 255)]));
    assert_eq!(per_channel, [pts(&[(0, 0), (128, 150), (255, 255)]), line(), pts(&[(0, 20), (255, 235)])]);
    assert_eq!((space, pencil), (ToneSpace::Rgb, false));
}

#[test]
fn reads_the_javascript_levels_file() {
    let (adj, report) = read("levels", &fixture("levels.alv")).unwrap();
    assert!(report.is_empty());
    let Adjustment::Levels { master, per_channel, .. } = adj else { panic!("{adj:?}") };
    assert_eq!(master, lv(12, 240, 1.2, 5, 250));
    assert_eq!(per_channel, [lv(20, 255, 0.8, 0, 255), LevelsChannel::default(), lv(0, 255, 1.0, 0, 230)]);
}

#[test]
fn reads_the_javascript_hue_saturation_files() {
    let (adj, _) = read("hueSaturation", &fixture("hue-saturation.ahu")).unwrap();
    let Adjustment::HueSaturation { hue, saturation, lightness, colorize, ranges } = adj else { panic!("{adj:?}") };
    assert_eq!((hue, saturation, lightness, colorize), (15.0, -20.0, 5.0, false));
    assert_eq!((ranges[0].hue, ranges[0].saturation, ranges[0].lightness), (10.0, 30.0, -5.0));
    assert_eq!(ranges[0].bounds, HueRange::canonical_bounds([310.0, 340.0, 20.0, 50.0]));
    assert_eq!(ranges[4].saturation, -40.0);
    assert_eq!(ranges[4].bounds, HueRange::defaults()[4].bounds);
    for r in [1, 2, 3, 5] {
        assert_eq!(ranges[r], HueRange::defaults()[r], "range {r}");
    }
    let (adj, _) = read("hueSaturation", &fixture("sepia.ahu")).unwrap();
    let Adjustment::HueSaturation { hue, saturation, lightness, colorize, .. } = adj else { panic!("{adj:?}") };
    // The colorize hue is stored signed (205 as -155) and read back in 0..360.
    assert_eq!((hue, saturation, lightness, colorize), (205.0, 30.0, -10.0, true));
}

#[test]
fn reads_the_javascript_channel_mixer_file() {
    // The app wrote the red output in the first record and the gray mix in the fourth.
    let (adj, report) = read("channelMixer", &fixture("channel-mixer.cha")).unwrap();
    assert!(report.is_empty());
    let Adjustment::ChannelMixer { matrix, monochrome } = adj else { panic!("{adj:?}") };
    assert!(monochrome);
    assert_eq!(matrix[0], [0.5, 0.3, 0.2, 0.05]);
}

#[test]
fn reads_the_javascript_selective_color_file() {
    let (adj, _) = read("selectiveColor", &fixture("selective-color.asv")).unwrap();
    let Adjustment::SelectiveColor { relative, adjustments } = adj else { panic!("{adj:?}") };
    assert!(!relative);
    assert_eq!(adjustments[0], [-20.0, 10.0, 30.0, 0.0]);
    assert_eq!(adjustments[7], [0.0, 0.0, 0.0, 15.0]);
    assert_eq!(adjustments[8], [5.0, 5.0, 5.0, -10.0]);
    assert!(adjustments[1..7].iter().all(|r| *r == [0.0; 4]));
}

#[test]
fn reads_the_javascript_black_white_file() {
    let (adj, _) = read("blackWhite", &fixture("black-white.blw")).unwrap();
    let Adjustment::BlackWhite { weights, tint } = adj else { panic!("{adj:?}") };
    assert_eq!(weights, [55.0, 70.0, 30.0, 60.0, -10.0, 90.0]);
    // The app stored its tint (hue 35, saturation 25) as the colour at 50% lightness.
    let tint = tint.expect("tint");
    for (got, want) in tint.iter().zip([0.625, 0.520_833, 0.375]) {
        assert!((got - want).abs() < 1e-4, "{tint:?}");
    }
}

// ------------------------------------------------------------------ edge cases

#[test]
fn drawn_and_crowded_curves_are_written_as_points() {
    let ramp: Vec<f32> = (0..256).map(|i| (i as f32 / 255.0).powf(0.5)).collect();
    let drawn = photocraft_doc::adjust::curve_map(&ramp);
    let adj = Adjustment::Curves { master: drawn, per_channel: [line(), line(), line()], space: ToneSpace::Rgb, black: Vec::new(), pencil: true };
    let (back, _) = read("curves", &write(&adj).unwrap()).unwrap();
    let Adjustment::Curves { master, pencil, .. } = back else { panic!() };
    assert!(!pencil);
    assert_eq!(master.len(), 17);
    assert_eq!((master[0].input, master[16].input), (0.0, 1.0));
    assert!((master[4].output - (64.0f32 / 255.0).sqrt()).abs() < 1.5 / 255.0, "{:?}", master[4]);
    // A file with more points than Photoshop's 19 (the app accepted 64) is sampled down.
    let mut v = vec![0, 1, 0, 1, 0, 30];
    for k in 0..30u16 {
        let x = k * 8;
        v.extend_from_slice(&x.to_be_bytes());
        v.extend_from_slice(&x.to_be_bytes());
    }
    let (Adjustment::Curves { master, .. }, _) = read("curves", &v).unwrap() else { panic!() };
    assert_eq!(master.len(), 17);
}

#[test]
fn records_beyond_rgb_are_reported() {
    let cmyk = Adjustment::Curves {
        master: line(),
        per_channel: [pts(&[(0, 10), (255, 255)]), line(), line()],
        space: ToneSpace::Cmyk,
        black: pts(&[(0, 0), (128, 100), (255, 255)]),
        pencil: false,
    };
    let (adj, report) = read("curves", &write(&cmyk).unwrap()).unwrap();
    assert_eq!(report, ["1 more channel curve skipped"]);
    let Adjustment::Curves { per_channel, space, .. } = adj else { panic!() };
    assert_eq!((per_channel[0].clone(), space), (pts(&[(0, 10), (255, 255)]), ToneSpace::Rgb));
    let levels = Adjustment::Levels { master: LevelsChannel::default(), per_channel: Default::default(), space: ToneSpace::Cmyk, black: lv(0, 200, 1.0, 0, 255) };
    let (_, report) = read("levels", &write(&levels).unwrap()).unwrap();
    assert_eq!(report, ["1 more channel setting skipped"]);
}

#[test]
fn old_versions_and_short_files() {
    let mut ahu = fixture("hue-saturation.ahu");
    ahu[1] = 1;
    let (_, report) = read("hueSaturation", &ahu).unwrap();
    assert_eq!(report.len(), 1, "{report:?}");
    ahu[1] = 3;
    assert!(read("hueSaturation", &ahu).unwrap_err().contains("version 3"));
    // A monochrome Channel Mixer file holding only its first record: the gray mix is that one.
    let cha = fixture("channel-mixer.cha");
    let mut short = cha[..14].to_vec();
    short[4..14].copy_from_slice(&cha[34..44]);
    let (Adjustment::ChannelMixer { matrix, monochrome }, report) = read("channelMixer", &short).unwrap() else { panic!() };
    assert!(monochrome && !report.is_empty());
    assert_eq!(matrix[0], [0.5, 0.3, 0.2, 0.05]);
    // Levels files with fewer records keep the rest neutral.
    let alv = fixture("levels.alv");
    let (Adjustment::Levels { master, per_channel, .. }, _) = read("levels", &alv[..12]).unwrap() else { panic!() };
    assert_eq!((master, per_channel[0].clone()), (lv(12, 240, 1.2, 5, 250), LevelsChannel::default()));
}

#[test]
fn wrong_files_are_refused() {
    let files = ["curves.acv", "levels.alv", "hue-saturation.ahu", "channel-mixer.cha", "selective-color.asv", "black-white.blw"];
    for (name, (kind, ..)) in files.iter().zip(KINDS.iter().cycle().skip(1)) {
        // Every file read as the next kind: refused or read, never a panic.
        let _ = read(kind, &fixture(name));
    }
    assert!(read("curves", b"\0\x02\0\x01\0\x02").is_err(), "version 2");
    assert!(read("curves", b"\0\x01\0\0").is_err(), "no curves");
    assert!(read("levels", &[0, 2, 1, 0, 0, 255, 0, 0, 0, 255, 0, 100]).is_err(), "input floor 256");
    assert!(read("levels", &[0, 2, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0]).is_err(), "gamma 0");
    assert!(read("selectiveColor", &[0; 84]).is_err(), "version 0");
    assert!(read("blackWhite", &[0; 40]).is_err());
    let mut blw = fixture("black-white.blw");
    blw[5] = 15;
    assert!(read("blackWhite", &blw).is_err(), "descriptor version 15");
}

#[test]
fn damaged_files_never_panic() {
    let files = [
        ("curves", "curves.acv"),
        ("levels", "levels.alv"),
        ("hueSaturation", "hue-saturation.ahu"),
        ("channelMixer", "channel-mixer.cha"),
        ("selectiveColor", "selective-color.asv"),
        ("blackWhite", "black-white.blw"),
    ];
    for (kind, name) in files {
        let bytes = fixture(name);
        for n in 0..bytes.len() {
            // Truncated: an error or a setting, never a panic.
            let _ = read(kind, &bytes[..n]);
        }
        for i in 0..bytes.len() {
            for x in [0x00, 0x7f, 0x80, 0xff] {
                let mut b = bytes.clone();
                b[i] = x;
                if let Ok((adj, _)) = read(kind, &b) {
                    // Whatever reads also writes.
                    assert!(write(&adj).is_ok(), "{name} byte {i} = {x:#x}");
                }
            }
        }
    }
}
