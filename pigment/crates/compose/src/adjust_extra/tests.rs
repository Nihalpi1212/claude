use super::*;
use crate::{render, render_bands, render_tiled};
use photocraft_color::{BlendMode, ColorMode, PixelFormat};
use photocraft_doc::{BlendIf, BlendRange};
use photocraft_geom::Size;

const CASES: &str = include_str!("js-cases.txt");

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).map(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap_or(0)).collect()
}

fn buffer_of(bytes: &[u8], rect: Rect) -> Buffer {
    Buffer { rect, px: bytes.chunks_exact(4).map(|p| std::array::from_fn(|c| f32::from(p[c]) / 255.0)).collect() }
}

fn param(list: &str, key: &str) -> f32 {
    list.split(',').find_map(|kv| kv.strip_prefix(key).and_then(|r| r.strip_prefix('='))).and_then(|v| v.parse().ok()).unwrap_or(0.0)
}

/// Pigment 0.4's own Clarity and Dehaze and Grain (js-cases.txt, README.md) on the same pixels:
/// within a level (the app rounds to 8 bits at the end, the port keeps floats).
#[test]
fn clarity_dehaze_and_grain_match_the_javascript_app() {
    let mut lines = CASES.lines();
    let size: Vec<i32> = lines.next().unwrap().split(' ').skip(1).map(|v| v.parse().unwrap()).collect();
    let input = unhex(lines.next().unwrap().strip_prefix("input ").unwrap());
    let mut checked = 0;
    for line in lines {
        let f: Vec<&str> = line.split(' ').collect();
        match f[0] {
            "case" => {
                let origin: Vec<i32> = f[3].split(',').map(|v| v.parse().unwrap()).collect();
                let rect = Rect::from_xywh(origin[0], origin[1], size[0] as u32, size[1] as u32);
                let mut buf = buffer_of(&input, rect);
                let adj = match f[1] {
                    "clarity-dehaze" => Adjustment::ClarityDehaze { clarity: param(f[2], "clarity"), dehaze: param(f[2], "dehaze") },
                    "grain" => Adjustment::Grain { amount: param(f[2], "amount"), size: param(f[2], "size"), roughness: param(f[2], "roughness"), seed: 1 },
                    other => panic!("unknown case {other}"),
                };
                apply(&adj, &mut buf, Transfer::Srgb, Some(SampleType::U8));
                let want = unhex(f[4]);
                let mut worst = 0.0f32;
                for (p, w) in buf.px.iter().zip(want.chunks_exact(4)) {
                    for c in 0..3 {
                        worst = worst.max((p[c] * 255.0 - f32::from(w[c])).abs());
                    }
                }
                assert!(worst <= 1.0, "{line:.60}: {worst} levels off");
                checked += 1;
            }
            "noise" => {
                let n = |i: usize| f[i].parse::<f32>().unwrap();
                let got = grain_noise(f[1].parse().unwrap(), f[2].parse().unwrap(), n(3), n(4), 1);
                assert!((got - n(5)).abs() < 1e-5, "{line}: {got}");
                checked += 1;
            }
            _ => {}
        }
    }
    assert_eq!(checked, 7 + 6);
}

/// A busy 8-bit RGB document with one adjustment layer on top (`below` under it).
fn busy_doc(w: u32, h: u32, adjs: &[Adjustment]) -> Document {
    let mut d = Document::new("busy", Size::new(w, h), ColorMode::Rgb, SampleType::U8);
    let mut l = Layer::raster("bg", PixelFormat::RGBA8);
    let data: Vec<f32> = (0..(w * h) as usize)
        .flat_map(|i| {
            let (x, y) = ((i % w as usize) as u32, (i / w as usize) as u32);
            [((x * 37 + y * 11) & 255) as f32 / 255.0, ((x * 5 + y * 23 + 40) & 255) as f32 / 255.0, (((x ^ y) * 9) & 255) as f32 / 255.0, 1.0]
        })
        .collect();
    l.surface_mut().unwrap().write_region(Rect::new(0, 0, w as i32, h as i32), &data);
    d.layers.push(l);
    for a in adjs {
        d.layers.push(Layer::new(a.label(), LayerContent::Adjustment(a.clone())));
    }
    d
}

fn max_diff(a: &Buffer, b: &Buffer) -> f32 {
    assert_eq!(a.rect, b.rect);
    a.px.iter().zip(&b.px).flat_map(|(p, q)| (0..4).map(move |c| (p[c] - q[c]).abs())).fold(0.0, f32::max)
}

fn whole(d: &Document) -> Buffer {
    render_tiled(d, d.bounds(), 100_000)
}

const CD: Adjustment = Adjustment::ClarityDehaze { clarity: 70.0, dehaze: 45.0 };

/// Clarity and Dehaze rendered in tiles of any size, or in bands, is the whole image's result
/// (the tiles grow by the margin): 256² in one band against tiles of 16 to 100, a part of it, and
/// bands.
#[test]
fn clarity_dehaze_has_no_tile_or_band_seams() {
    for adjs in
        [vec![CD], vec![Adjustment::ClarityDehaze { clarity: -60.0, dehaze: -30.0 }], vec![CD, Adjustment::ClarityDehaze { clarity: 40.0, dehaze: 0.0 }]]
    {
        let d = busy_doc(256, 256, &adjs);
        let full = whole(&d);
        for tile in [16, 64, 100, 256] {
            assert!(max_diff(&render_tiled(&d, d.bounds(), tile), &full) <= 1.0 / 255.0, "tile {tile}");
        }
        assert!(max_diff(&render(&d, d.bounds()), &full) <= 1.0 / 255.0);
        // A part of the canvas is that part of the whole.
        let part = Rect::new(37, 90, 120, 171);
        let got = render(&d, part);
        for y in part.y0..part.y1 {
            for x in part.x0..part.x1 {
                let (a, b) = (got.get(x, y), full.get(x, y));
                assert!((0..4).all(|c| (a[c] - b[c]).abs() <= 1.0 / 255.0), "{x},{y}");
            }
        }
        // Bands (whole tiles high): a tall document in three.
        let tall = busy_doc(96, 768, &adjs);
        let full = whole(&tall);
        let mut bands = Vec::new();
        render_bands(&tall, tall.bounds(), 256, |b| {
            bands.push(b);
            Ok::<(), ()>(())
        })
        .unwrap();
        assert_eq!(bands.len(), 3);
        for b in &bands {
            let r = b.rect;
            let want = Buffer { rect: r, px: full.px[(r.y0 as usize * 96)..(r.y1 as usize * 96)].to_vec() };
            assert!(max_diff(b, &want) <= 1.0 / 255.0, "band {r:?}");
        }
    }
}

/// Clipped to a pixel layer, inside a group and under Blend If (the compositor's three places
/// that apply an adjustment) Clarity and Dehaze has no tile seams either.
#[test]
fn clarity_dehaze_clipped_grouped_and_blend_if_has_no_seams() {
    let mut d = busy_doc(160, 120, &[]);
    let mut clipped = Layer::new("cd", LayerContent::Adjustment(CD));
    clipped.clipped = true;
    d.layers.push(clipped);
    let mut inner = Layer::new("cd2", LayerContent::Adjustment(Adjustment::ClarityDehaze { clarity: -40.0, dehaze: 20.0 }));
    let mut blend_if = BlendIf::default();
    blend_if.set(0, [BlendRange { black: [0, 0], white: [180, 230] }, BlendRange::FULL]);
    inner.blend_if = blend_if;
    let mut g = Layer::group("g", vec![inner]);
    g.blend = BlendMode::Normal;
    d.layers.push(g);
    let full = whole(&d);
    for tile in [16, 50] {
        assert!(max_diff(&render_tiled(&d, d.bounds(), tile), &full) <= 1.0 / 255.0, "tile {tile}");
    }
}

/// Grain is fixed to the document: two overlapping renders agree exactly where they overlap, and a
/// tile renders what the whole does; another seed is other grain.
#[test]
fn grain_is_deterministic_and_position_locked() {
    let g = Adjustment::Grain { amount: 60.0, size: 30.0, roughness: 40.0, seed: 1 };
    let d = busy_doc(200, 150, &[g]);
    let (a, b) = (render(&d, Rect::new(0, 0, 120, 100)), render(&d, Rect::new(60, 40, 200, 150)));
    let mut n = 0;
    for y in 40..100 {
        for x in 60..120 {
            assert_eq!(a.get(x, y), b.get(x, y), "{x},{y}");
            n += 1;
        }
    }
    assert_eq!(n, 60 * 60);
    let full = whole(&d);
    assert_eq!(render_tiled(&d, d.bounds(), 17).px, full.px);
    assert_eq!(whole(&d).px, full.px, "the same every time");
    let plain = whole(&busy_doc(200, 150, &[]));
    assert!(max_diff(&full, &plain) > 10.0 / 255.0, "grain shows");
    let other = whole(&busy_doc(200, 150, &[Adjustment::Grain { amount: 60.0, size: 30.0, roughness: 40.0, seed: 2 }]));
    assert!(max_diff(&full, &other) > 10.0 / 255.0, "another seed moves it");
    let none = whole(&busy_doc(200, 150, &[Adjustment::Grain { amount: 0.0, size: 30.0, roughness: 40.0, seed: 1 }]));
    assert_eq!(none.px, plain.px, "Amount 0 changes nothing");
}

/// Temperature +50 warms a grey (red up, blue down, luminance about kept); Tint +50 lowers green;
/// at rest nothing changes; Vibrance and Saturation are the Vibrance adjustment's.
#[test]
fn color_vibrance_warms_a_grey_and_matches_vibrance() {
    let grey = |adj: &Adjustment| {
        let mut b = Buffer::filled(Rect::from_xywh(0, 0, 1, 1), [0.5, 0.5, 0.5, 1.0]);
        apply(adj, &mut b, Transfer::Srgb, Some(SampleType::U8));
        b.px[0]
    };
    let cv = |temperature, tint, vibrance, saturation| Adjustment::ColorVibrance { temperature, tint, vibrance, saturation };
    let warm = grey(&cv(50.0, 0.0, 0.0, 0.0));
    assert!(warm[0] > 0.52 && warm[2] < 0.47 && warm[0] > warm[1] && warm[1] > warm[2], "{warm:?}");
    let lum = |p: [f32; 4]| 0.2126 * p[0].powf(2.2) + 0.7152 * p[1].powf(2.2) + 0.0722 * p[2].powf(2.2);
    assert!((lum(warm) - lum([0.5; 4])).abs() < 0.01, "a grey keeps its luminance");
    let magenta = grey(&cv(0.0, 50.0, 0.0, 0.0));
    assert!(magenta[1] < magenta[0] && magenta[1] < magenta[2], "{magenta:?}");
    let cool = grey(&cv(-50.0, 0.0, 0.0, 0.0));
    assert!(cool[2] > cool[0]);
    assert_eq!(grey(&cv(0.0, 0.0, 0.0, 0.0)), [0.5, 0.5, 0.5, 1.0]);
    // Vibrance and Saturation alone are exactly the Vibrance adjustment.
    let mut a = Buffer { rect: Rect::from_xywh(0, 0, 3, 1), px: vec![[0.8, 0.3, 0.2, 1.0], [0.2, 0.5, 0.9, 1.0], [0.4, 0.4, 0.35, 0.5]] };
    let mut b = a.clone();
    apply(&cv(0.0, 0.0, 40.0, -20.0), &mut a, Transfer::Srgb, Some(SampleType::U8));
    crate::adjust::apply_depth(&Adjustment::Vibrance { vibrance: 40.0, saturation: -20.0 }, &mut b, Transfer::Srgb, Some(SampleType::U8));
    assert_eq!(a.px, b.px);
    // Through the compositor too.
    let d = busy_doc(8, 8, &[cv(50.0, 0.0, 0.0, 0.0)]);
    let (adj, plain) = (whole(&d), whole(&busy_doc(8, 8, &[])));
    let red = |b: &Buffer| b.px.iter().map(|p| p[0] - p[2]).sum::<f32>();
    assert!(red(&adj) > red(&plain));
}

#[test]
fn margins_grow_within_the_canvas() {
    let canvas = Rect::new(0, 0, 100, 80);
    assert_eq!(grow(Rect::new(10, 30, 50, 60), 24, canvas), Rect::new(0, 6, 74, 80));
    assert_eq!(grow(Rect::new(10, 30, 50, 60), 0, canvas), Rect::new(10, 30, 50, 60));
    // Edges already past the canvas stay where they are.
    assert_eq!(grow(Rect::new(-10, 0, 120, 80), 24, canvas), Rect::new(-10, 0, 120, 80));
    let layers = busy_doc(4, 4, &[CD, Adjustment::Grain { amount: 50.0, size: 0.0, roughness: 0.0, seed: 1 }, CD]).layers;
    assert_eq!(stack_margin(&layers), 48);
    let mut hidden = layers.clone();
    hidden[1].visible = false;
    assert_eq!(stack_margin(&hidden), 24);
    let many = busy_doc(4, 4, &vec![CD; 40]).layers;
    assert_eq!(stack_margin(&many), MAX_STACK_MARGIN);
    assert_eq!(stack_margin(&[Layer::group("g", layers)]), 48, "inside groups too");
}

/// A document holding Grain or Clarity and Dehaze is neither reduced from a proxy nor composited by
/// one-colour areas: both would lose the grain or the neighbourhood.
#[test]
fn positional_adjustments_turn_off_proxies_and_uniform_areas() {
    let flat = |adj: Adjustment| {
        let mut d = Document::with_background("w", Size::new(64, 64), ColorMode::Rgb, SampleType::U8, photocraft_color::Color::WHITE);
        d.layers.push(Layer::new("a", LayerContent::Adjustment(adj)));
        d
    };
    let grain = flat(Adjustment::Grain { amount: 50.0, size: 10.0, roughness: 50.0, seed: 1 });
    assert!(!crate::proxy::proxy_faithful(&grain));
    assert!(crate::uniform::UniformAreas::new(&grain).is_none());
    assert!(!crate::proxy::proxy_faithful(&flat(CD)));
    let calm = flat(Adjustment::ColorVibrance { temperature: 20.0, tint: 0.0, vibrance: 0.0, saturation: 0.0 });
    assert!(crate::proxy::proxy_faithful(&calm));
    assert!(crate::uniform::UniformAreas::new(&calm).is_some());
    // The reduced render of a white canvas with grain is not one white.
    let small = crate::render_reduced(&grain, 16, 16);
    let first = small.px[0];
    assert!(small.px.iter().any(|p| (p[0] - first[0]).abs() > 1e-4));
}

#[test]
fn hostile_values_never_panic() {
    for adj in [
        Adjustment::ClarityDehaze { clarity: f32::NAN, dehaze: f32::INFINITY },
        Adjustment::ClarityDehaze { clarity: 1e30, dehaze: -1e30 },
        Adjustment::Grain { amount: f32::NAN, size: f32::INFINITY, roughness: -5.0, seed: u32::MAX },
        Adjustment::Grain { amount: 1e9, size: -1e9, roughness: 1e9, seed: 0 },
        Adjustment::ColorVibrance { temperature: f32::NAN, tint: 1e9, vibrance: -1e9, saturation: f32::NAN },
    ] {
        for rect in [Rect::from_xywh(i32::MAX - 3, i32::MIN, 3, 2), Rect::from_xywh(0, 0, 1, 1), Rect::EMPTY] {
            let mut b = Buffer::filled(rect, [0.5, f32::NAN, 2.0, 1.0]);
            apply(&adj, &mut b, Transfer::Srgb, Some(SampleType::F32));
            apply(&adj, &mut b, Transfer::Gamma(1.732), None);
        }
    }
    assert!(grain_noise(i32::MIN, i32::MAX, f32::MAX, 0.5, 9).is_finite());
}
