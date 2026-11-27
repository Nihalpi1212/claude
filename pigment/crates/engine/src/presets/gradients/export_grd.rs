//! Pigment: Gradients › Save Gradients… and the Preset Manager's Save Set… (P1a):
//! `gradient.presets.exportGrd` writes gradient presets as a Photoshop `.grd` (version 5) through
//! `craft_psd::grd::write`, the format `gradient.presets.importGrd` reads.
//!
//! Colour stops keep their kind (a fixed RGB colour, or the live foreground or background
//! colour), transparency stops their opacity; midpoints are 50 %, as PhotoCraft draws them. A
//! preset with no transparency stops is written opaque at both ends, as Photoshop writes one. A
//! noise gradient (P3) is written as one (`ClNs` and its settings, no stops).

use craft_psd::grd::{GrdColor, GrdGradient, GrdStop};
use serde_json::{Value, json};

use super::{GradientPreset, StopColor};
use crate::commands::CommandSpec;
use crate::presets::{always, bad, str_param};
use crate::{Result, Session};

pub(crate) const CMD: &str = "gradient.presets.exportGrd";

/// `preset` as a `.grd` gradient.
pub fn to_grd(preset: &GradientPreset) -> GrdGradient {
    let clamp = |v: f32| if v.is_finite() { v.clamp(0.0, 1.0) } else { 0.0 };
    let stops = preset
        .stops
        .iter()
        .map(|&(at, c)| GrdStop {
            location: clamp(at),
            midpoint: 0.5,
            color: match c {
                StopColor::Foreground => GrdColor::Foreground,
                StopColor::Background => GrdColor::Background,
                StopColor::Rgb(rgb) => GrdColor::Rgb(rgb.map(clamp)),
            },
        })
        .collect();
    let opacity = if preset.opacity.is_empty() {
        vec![(0.0, 1.0, 0.5), (1.0, 1.0, 0.5)]
    } else {
        preset.opacity.iter().map(|&(at, o)| (clamp(at), clamp(o), 0.5)).collect()
    };
    GrdGradient { name: preset.name.clone(), noise: preset.noise.is_some(), stops, opacity }
}

/// `{"group"?, "names"?, "path"?}` → `{count, bytes, path | data}`.
fn export(s: &mut Session, p: &Value) -> Result<Value> {
    let group = str_param(p, "group");
    let groups = &s.presets.gradients;
    if let Some(g) = group
        && !groups.iter().any(|x| x.name == g)
    {
        return Err(bad(CMD, format!("no gradient group \"{g}\"")));
    }
    let in_scope = || groups.iter().filter(|g| group.is_none_or(|n| g.name == n)).flat_map(|g| &g.items);
    let presets: Vec<&GradientPreset> = match p.get("names") {
        None | Some(Value::Null) => in_scope().collect(),
        Some(Value::Array(names)) => {
            let mut out = Vec::with_capacity(names.len());
            for n in names {
                let n = n.as_str().ok_or_else(|| bad(CMD, "`names` must be gradient names"))?;
                out.push(in_scope().find(|g| g.name == n).ok_or_else(|| bad(CMD, format!("no gradient \"{n}\"")))?);
            }
            out
        }
        Some(_) => return Err(bad(CMD, "`names` must be a list of gradient names")),
    };
    if presets.is_empty() {
        return Err(bad(CMD, "there are no gradients to save"));
    }
    let grads: Vec<GrdGradient> = presets.iter().map(|g| to_grd(g)).collect();
    // Noise gradients (P3) are written with their settings.
    let noise: Vec<_> = presets.iter().map(|g| g.noise.clone()).collect();
    let bytes = photocraft_io::grd_noise::write_grd(&grads, &noise);
    let mut out = json!({"count": grads.len(), "bytes": bytes.len()});
    match str_param(p, "path") {
        Some(path) => {
            crate::file_cmds::write_file(path, &bytes)?;
            out["path"] = json!(path);
        }
        None => out["data"] = json!(photocraft_paint::tile::b64_encode(&bytes)),
    }
    Ok(out)
}

pub(super) fn spec() -> CommandSpec {
    CommandSpec {
        id: CMD,
        label: "Save Gradients…",
        menu: &[],
        shortcut: None,
        params: r##"{"group":name? (only that group),"names":[gradient names]? (only these; default every gradient),"path":".grd file"? (else the bytes come back as base64 `data`)} → {count, bytes, path | data} (Photoshop .grd version 5; midpoints 50 %)"##,
        enabled: always,
        run: export,
        journal: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_grd_round_trips_through_import_grd() {
        let mut s = Session::new();
        s.execute(
            "gradient.presets.new",
            json!({"name": "Mine", "group": "Saved", "stops": [[0, "foreground"], [0.4, "#ff8000"], [1, "background"]], "transparency": [[0, 100], [1, 25]]}),
        )
        .unwrap();
        let all: Vec<String> = s.presets.gradients.iter().flat_map(|g| g.items.iter().map(|i| i.name.clone())).collect();
        let out = s.execute(CMD, json!({})).unwrap();
        assert_eq!(out["count"], all.len());
        let mut t = Session::new();
        t.presets.gradients.clear();
        let r = t.execute("gradient.presets.importGrd", json!({"data": out["data"], "group": "Back"})).unwrap();
        assert_eq!(r["imported"].as_array().unwrap().len(), all.len());
        assert_eq!(r["warnings"], json!([]));
        let back = &t.presets.gradients[0].items;
        let names: Vec<String> = back.iter().map(|g| g.name.clone()).collect();
        assert_eq!(names, all);
        let mine = back.iter().find(|g| g.name == "Mine").unwrap();
        let orig = s.presets.gradients.iter().flat_map(|g| &g.items).find(|g| g.name == "Mine").unwrap();
        assert_eq!(mine.stops.len(), 3);
        assert_eq!(mine.stops[0].1, StopColor::Foreground);
        assert_eq!(mine.stops[2].1, StopColor::Background);
        let StopColor::Rgb(c) = mine.stops[1].1 else { panic!("an RGB stop") };
        let StopColor::Rgb(o) = orig.stops[1].1 else { panic!("an RGB stop") };
        assert!(c.iter().zip(o).all(|(a, b)| (a - b).abs() < 1e-3), "{c:?} vs {o:?}");
        assert!((mine.stops[1].0 - 0.4).abs() < 1e-3);
        assert!((mine.opacity[1].1 - 0.25).abs() < 1e-3);
    }

    #[test]
    fn export_grd_by_name_group_and_path() {
        let mut s = Session::new();
        let first = s.presets.gradients[0].items[0].name.clone();
        let out = s.execute(CMD, json!({"names": [first]})).unwrap();
        assert_eq!(out["count"], 1);
        let group = s.presets.gradients[0].name.clone();
        let n = s.presets.gradients[0].items.len();
        assert_eq!(s.execute(CMD, json!({"group": group})).unwrap()["count"], n);
        assert!(s.execute(CMD, json!({"names": ["No such gradient"]})).is_err());
        assert!(s.execute(CMD, json!({"group": "No such group"})).is_err());
        assert!(s.execute(CMD, json!({"names": "Mine"})).is_err());
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("set.grd");
        let out = s.execute(CMD, json!({"names": [first], "path": path.to_str().unwrap()})).unwrap();
        assert_eq!(out["path"], json!(path.to_str().unwrap()));
        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(craft_psd::grd::parse(&bytes).unwrap()[0].name, first);
        s.presets.gradients.clear();
        assert!(s.execute(CMD, json!({})).is_err(), "nothing to save");
    }
}
