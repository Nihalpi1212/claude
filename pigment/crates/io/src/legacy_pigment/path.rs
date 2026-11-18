//! Vector paths of Pigment 0.1–0.4 (`PathData` in `renderer/lib/tools/vector.js`):
//! `{ subpaths: [{ closed, op?, points: [{ x, y, inX?, inY?, outX?, outY? }] }] }` in document
//! pixels, handles absolute. `op` is `combine` (the default), `subtract`, `intersect` or
//! `exclude`, applied in subpath order as Photoshop does (`renderer/lib/path-ops.js`).

use photocraft_doc::vector::{Knot, Path, PathOp, Subpath};
use photocraft_geom::Point;
use serde_json::Value;

/// Coordinates beyond this are not a path anyone drew: the knot is dropped.
const MAX_COORDINATE: f64 = 1.0e7;

fn coordinate(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite() && n.abs() <= MAX_COORDINATE)
}

fn knot(v: &Value) -> Option<Knot> {
    // A point is an object, or `[x, y]` in the paths some filters kept.
    if let Some(pair) = v.as_array() {
        return Some(Knot::corner(coordinate(pair.first())?, coordinate(pair.get(1))?));
    }
    let anchor = Point::new(coordinate(v.get("x"))?, coordinate(v.get("y"))?);
    let handle = |x: &str, y: &str| match (coordinate(v.get(x)), coordinate(v.get(y))) {
        (Some(x), Some(y)) => Point::new(x, y),
        _ => anchor,
    };
    let (in_ctrl, out_ctrl) = (handle("inX", "inY"), handle("outX", "outY"));
    // Smooth when both handles are out and lie on one line through the anchor.
    let (a, b) = ((in_ctrl.x - anchor.x, in_ctrl.y - anchor.y), (out_ctrl.x - anchor.x, out_ctrl.y - anchor.y));
    let (la, lb) = (a.0.hypot(a.1), b.0.hypot(b.1));
    let smooth = la > 0.0 && lb > 0.0 && (a.0 * b.1 - a.1 * b.0).abs() <= 1.0e-6 * la * lb && a.0 * b.0 + a.1 * b.1 < 0.0;
    Some(Knot { anchor, in_ctrl, out_ctrl, smooth })
}

/// The path a `PathData` value describes; `None` when it is not one. Subpaths without a usable
/// point are left out, and so are points whose numbers are not finite.
pub(crate) fn to_path(v: &Value) -> Option<Path> {
    let subpaths = v.get("subpaths")?.as_array()?;
    let mut out = Vec::with_capacity(subpaths.len().min(1024));
    for sp in subpaths {
        let Some(points) = sp.get("points").and_then(Value::as_array) else { continue };
        let knots: Vec<Knot> = points.iter().filter_map(knot).collect();
        if knots.is_empty() {
            continue;
        }
        let op = match sp.get("op").and_then(Value::as_str) {
            Some("subtract") => PathOp::Subtract,
            Some("intersect") => PathOp::Intersect,
            Some("exclude") => PathOp::Exclude,
            _ => PathOp::Combine,
        };
        out.push(Subpath { closed: sp.get("closed").and_then(Value::as_bool).unwrap_or(false), knots, op });
    }
    Some(Path::new(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn corners_curves_and_operations() {
        let path = to_path(&json!({"subpaths": [
            {"closed": true, "points": [{"x": 2, "y": 2}, {"x": 14, "y": 2}, {"x": 8, "y": 12}]},
            {"closed": true, "op": "subtract", "points": [[6, 4], [10, 4], [8, 8]]},
            {"closed": false, "op": "intersect", "points": [{"x": 4, "y": 20, "outX": 8, "outY": 14}, {"x": 16, "y": 20, "inX": 12, "inY": 14, "outX": 20, "outY": 26}]},
            {"closed": true, "op": "exclude", "points": [{"x": 0, "y": 0}]},
        ]}))
        .unwrap();
        assert_eq!(path.subpaths.len(), 4);
        assert_eq!(path.subpaths[0], Subpath::polygon(&[(2.0, 2.0), (14.0, 2.0), (8.0, 12.0)]));
        assert_eq!(path.subpaths[1], Subpath::polygon(&[(6.0, 4.0), (10.0, 4.0), (8.0, 8.0)]).with_op(PathOp::Subtract));
        let curve = &path.subpaths[2];
        assert!(!curve.closed);
        assert_eq!(curve.op, PathOp::Intersect);
        // A handle that is not in the file sits on its anchor.
        assert_eq!(curve.knots[0], Knot { anchor: Point::new(4.0, 20.0), in_ctrl: Point::new(4.0, 20.0), out_ctrl: Point::new(8.0, 14.0), smooth: false });
        // Both handles out, opposite each other on one line: a smooth knot.
        assert_eq!(curve.knots[1], Knot::smooth(Point::new(16.0, 20.0), Point::new(12.0, 14.0), Point::new(20.0, 26.0)));
        assert_eq!(path.subpaths[3].op, PathOp::Exclude);
    }

    #[test]
    fn what_is_not_a_path_and_what_is_left_out() {
        assert_eq!(to_path(&json!(null)), None);
        assert_eq!(to_path(&json!({"subpaths": 3})), None);
        assert_eq!(to_path(&json!({"subpaths": []})), Some(Path::new(Vec::new())));
        let path = to_path(&json!({"subpaths": [
            {"points": "no"},
            {"closed": 1, "points": [{"x": 1.0e300, "y": 0}, {"x": "1", "y": 2}, {"x": 3, "y": 4, "inX": 1.0e9, "inY": 0}, [5]]},
            {"points": []},
        ]}))
        .unwrap();
        assert_eq!(path.subpaths, vec![Subpath { closed: false, knots: vec![Knot::corner(3.0, 4.0)], op: PathOp::Combine }]);
    }
}
