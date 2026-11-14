//! Colour palettes a model returns as JSON (Generative Recolor, palette hints), read strictly:
//! only `#rrggbb` colours, a bounded number of palettes and colours, and nothing else used.

use serde_json::Value;

use crate::{AiError, Result};

/// Most palettes kept from one answer.
pub const MAX_PALETTES: usize = 8;
/// Most colours kept per palette.
pub const MAX_COLORS: usize = 16;

/// One palette: a name and its colours as `#rrggbb`, lowercase.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Palette {
    pub name: String,
    pub colors: Vec<String>,
}

/// `#rgb` or `#rrggbb` (the `#` optional) as bytes.
pub fn parse_hex(s: &str) -> Option<[u8; 3]> {
    let h = s.trim().trim_start_matches('#');
    let digit = |c: u8| (c as char).to_digit(16).and_then(|d| u8::try_from(d).ok());
    let b = h.as_bytes();
    match b.len() {
        3 => {
            let mut out = [0u8; 3];
            for (o, &c) in out.iter_mut().zip(b) {
                *o = digit(c)? * 17;
            }
            Some(out)
        }
        6 => {
            let mut out = [0u8; 3];
            for (i, o) in out.iter_mut().enumerate() {
                *o = digit(*b.get(2 * i)?)? * 16 + digit(*b.get(2 * i + 1)?)?;
            }
            Some(out)
        }
        _ => None,
    }
}

pub fn to_hex([r, g, b]: [u8; 3]) -> String {
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// Perceived lightness, 0–100 (CIE L* of the sRGB colour).
pub fn lightness([r, g, b]: [u8; 3]) -> f64 {
    let lin = |c: u8| {
        let c = f64::from(c) / 255.0;
        if c <= 0.04045 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    let y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    if y > 216.0 / 24389.0 { 116.0 * y.cbrt() - 16.0 } else { y * 24389.0 / 27.0 }
}

/// The JSON object or array in a model's answer (models wrap it in Markdown fences or prose).
pub fn extract_json(text: &str) -> Option<&str> {
    let start = text.find(['{', '['])?;
    let close = if text.get(start..start + 1) == Some("{") { '}' } else { ']' };
    let end = text.rfind(close)?;
    (end > start).then(|| text.get(start..=end)).flatten()
}

/// The palettes in a model's answer: `{"palettes": [{"name", "colors": ["#rrggbb", …]}, …]}`, or a
/// bare array of such objects, or of colour arrays. Palettes with no valid colour are left out;
/// none at all is an error.
pub fn parse_palettes(text: &str) -> Result<Vec<Palette>> {
    let json = extract_json(text).ok_or_else(|| AiError::bad_response("The model's answer has no palette JSON in it."))?;
    let v: Value = serde_json::from_str(json).map_err(|_| AiError::bad_response("The model's palette JSON is not valid."))?;
    let list = match &v {
        Value::Array(a) => a.clone(),
        Value::Object(o) => o.get("palettes").and_then(Value::as_array).cloned().unwrap_or_else(|| vec![v.clone()]),
        _ => vec![],
    };
    let mut out = vec![];
    for (i, p) in list.iter().take(MAX_PALETTES * 2).enumerate() {
        let (name, colors) = match p {
            Value::Array(c) => (String::new(), c.clone()),
            Value::Object(o) => (
                o.get("name").and_then(Value::as_str).unwrap_or_default().chars().take(60).collect::<String>(),
                o.get("colors").or_else(|| o.get("colours")).and_then(Value::as_array).cloned().unwrap_or_default(),
            ),
            _ => continue,
        };
        let mut hexes: Vec<String> = colors.iter().filter_map(Value::as_str).filter_map(parse_hex).map(to_hex).collect();
        hexes.dedup();
        hexes.truncate(MAX_COLORS);
        if hexes.is_empty() {
            continue;
        }
        let name = if name.trim().is_empty() { format!("Palette {}", i + 1) } else { name.trim().to_string() };
        out.push(Palette { name, colors: hexes });
        if out.len() == MAX_PALETTES {
            break;
        }
    }
    if out.is_empty() {
        return Err(AiError::bad_response("The model returned no usable colours."));
    }
    Ok(out)
}

/// Pairs each of `from` (the artwork's colour rows) with a colour of `palette`, by lightness rank:
/// the darkest row takes the darkest colour, the lightest the lightest, the rest spread between.
/// Returns `(from index, palette colour)`.
pub fn assign_by_lightness(from: &[[u8; 3]], palette: &[[u8; 3]]) -> Vec<(usize, [u8; 3])> {
    if from.is_empty() || palette.is_empty() {
        return vec![];
    }
    let mut rows: Vec<usize> = (0..from.len()).collect();
    rows.sort_by(|&a, &b| lightness(from.get(a).copied().unwrap_or_default()).total_cmp(&lightness(from.get(b).copied().unwrap_or_default())));
    let mut colors = palette.to_vec();
    colors.sort_by(|a, b| lightness(*a).total_cmp(&lightness(*b)));
    let (n, m) = (rows.len(), colors.len());
    rows.iter()
        .enumerate()
        .filter_map(|(rank, &row)| {
            let k = if n == 1 { m / 2 } else { (rank * (m - 1) + (n - 1) / 2) / (n - 1) };
            colors.get(k.min(m - 1)).map(|c| (row, *c))
        })
        .collect()
}
