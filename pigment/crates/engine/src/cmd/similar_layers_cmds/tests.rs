use photocraft_doc::LayerId;
use serde_json::json;

use crate::Session;

fn id(v: serde_json::Value) -> LayerId {
    LayerId(v["layer"].as_u64().unwrap())
}

fn sel(s: &Session) -> Vec<LayerId> {
    let mut v = s.active().unwrap().selected_layers();
    v.sort_by_key(|l| l.0);
    v
}

fn sorted(mut v: Vec<LayerId>) -> Vec<LayerId> {
    v.sort_by_key(|l| l.0);
    v
}

fn history(s: &Session) -> usize {
    s.active().unwrap().history.entries().len()
}

/// Background, a pixel layer, two type layers each in its own group (one nested in the other's
/// group), two adjustment layers of different kinds, two fill layers of different kinds, a shape.
struct Doc {
    s: Session,
    bg: LayerId,
    pixel: LayerId,
    t1: LayerId,
    t2: LayerId,
    g1: LayerId,
    g2: LayerId,
    adj: [LayerId; 2],
    fill: [LayerId; 2],
    shape: LayerId,
}

fn doc() -> Doc {
    let mut s = Session::new();
    s.execute("file.new", json!({"width": 60, "height": 40})).unwrap();
    let bg = s.active().unwrap().doc.layers[0].id;
    let pixel = id(s.execute("layer.new.layer", json!({"name": "Paint"})).unwrap());
    let t1 = id(s.execute("type.create", json!({"x": 5, "y": 20, "text": "One", "size": 12})).unwrap());
    let g1 = id(s.execute("layer.groupLayers", json!({"layer": t1.0, "name": "Outer"})).unwrap());
    let t2 = id(s.execute("type.create", json!({"x": 5, "y": 30, "text": "Two", "size": 12})).unwrap());
    let g2 = id(s.execute("layer.groupLayers", json!({"layer": t2.0, "name": "Inner"})).unwrap());
    let adj = [
        id(s.execute("layer.newAdjustmentLayer.invert", json!({})).unwrap()),
        id(s.execute("layer.newAdjustmentLayer.levels", json!({})).unwrap()),
    ];
    let fill = [
        id(s.execute("layer.newFillLayer.solidColor", json!({"color": "#c82828"})).unwrap()),
        id(s.execute("layer.newFillLayer.gradient", json!({})).unwrap()),
    ];
    let shape = id(s.execute("shape.create", json!({"kind": "rect", "rect": [10, 10, 40, 20], "fill": "#ff0000"})).unwrap());
    Doc { s, bg, pixel, t1, t2, g1, g2, adj, fill, shape }
}

fn pick(s: &mut Session, l: LayerId) {
    s.execute("layer.select", json!({"layer": l.0})).unwrap();
}

#[test]
fn the_document_is_built_as_the_tests_expect() {
    let d = doc();
    let doc = &d.s.active().unwrap().doc;
    let kind = |l: LayerId| doc.layer(l).unwrap().content.kind_name();
    assert_eq!(kind(d.bg), "Pixel");
    assert_eq!(kind(d.pixel), "Pixel");
    assert_eq!([kind(d.t1), kind(d.t2)], ["Type", "Type"]);
    assert_eq!([kind(d.g1), kind(d.g2)], ["Group", "Group"]);
    assert_eq!(d.adj.map(kind), ["Adjustment", "Adjustment"]);
    assert_eq!(d.fill.map(kind), ["Fill", "Fill"]);
    assert_eq!(kind(d.shape), "Shape");
    // The type layers sit in different groups.
    let parent = |l: LayerId| doc.walk().into_iter().find(|(_, _, x)| x.id == l).map(|(p, _, _)| p[..p.len() - 1].to_vec()).unwrap();
    assert_ne!(parent(d.t1), parent(d.t2));
    assert!(!parent(d.t1).is_empty() && !parent(d.t2).is_empty());
}

#[test]
fn a_type_layer_selects_every_type_layer_inside_groups_too() {
    let mut d = doc();
    pick(&mut d.s, d.t2);
    let before = history(&d.s);
    let r = d.s.execute("select.similarLayers", json!({})).unwrap();
    assert_eq!(r["selected"], 2);
    assert_eq!(sel(&d.s), sorted(vec![d.t1, d.t2]));
    assert_eq!(d.s.active().unwrap().active_layer, Some(d.t2), "the active layer stays active");
    assert_eq!(history(&d.s), before, "selecting layers is not a history step");
}

#[test]
fn adjustment_and_fill_layers_of_any_kind_match_each_other() {
    let mut d = doc();
    pick(&mut d.s, d.adj[0]);
    d.s.execute("select.similarLayers", json!({})).unwrap();
    assert_eq!(sel(&d.s), sorted(d.adj.to_vec()));
    assert_eq!(d.s.active().unwrap().active_layer, Some(d.adj[0]));
    pick(&mut d.s, d.fill[1]);
    d.s.execute("select.similarLayers", json!({})).unwrap();
    assert_eq!(sel(&d.s), sorted(d.fill.to_vec()));
    pick(&mut d.s, d.g2);
    d.s.execute("select.similarLayers", json!({})).unwrap();
    assert_eq!(sel(&d.s), sorted(vec![d.g1, d.g2]));
    pick(&mut d.s, d.shape);
    d.s.execute("select.similarLayers", json!({})).unwrap();
    assert_eq!(sel(&d.s), vec![d.shape]);
}

#[test]
fn several_kinds_selected_select_all_of_each_and_the_background_only_when_selected() {
    let mut d = doc();
    pick(&mut d.s, d.pixel);
    d.s.execute("select.similarLayers", json!({})).unwrap();
    assert_eq!(sel(&d.s), vec![d.pixel], "the Background is left out as Select All Layers does");
    d.s.execute("layer.select", json!({"layer": d.t1.0, "mode": "toggle"})).unwrap();
    d.s.execute("select.similarLayers", json!({})).unwrap();
    assert_eq!(sel(&d.s), sorted(vec![d.pixel, d.t1, d.t2]));
    assert_eq!(d.s.active().unwrap().active_layer, Some(d.t1));
    // From the Background, it stays in.
    pick(&mut d.s, d.bg);
    d.s.execute("select.similarLayers", json!({})).unwrap();
    assert_eq!(sel(&d.s), sorted(vec![d.bg, d.pixel]));
}

#[test]
fn it_needs_a_selected_layer_and_ignores_params() {
    let mut s = Session::new();
    assert!(s.execute("select.similarLayers", json!({})).is_err(), "no document");
    let mut d = doc();
    d.s.execute("select.deselectLayers", json!({})).unwrap();
    let spec = crate::commands::find("select.similarLayers").unwrap();
    assert_eq!(spec.menu, &["Select"]);
    assert!((spec.enabled)(&d.s).is_err());
    assert!(d.s.execute("select.similarLayers", json!({})).is_err());
    pick(&mut d.s, d.t1);
    assert!((spec.enabled)(&d.s).is_ok());
    d.s.execute("select.similarLayers", json!({"bogus": [1, {"x": null}], "layer": "nope"})).unwrap();
    assert_eq!(sel(&d.s), sorted(vec![d.t1, d.t2]));
    s.execute("select.similarLayers", json!(null)).unwrap_err();
}
