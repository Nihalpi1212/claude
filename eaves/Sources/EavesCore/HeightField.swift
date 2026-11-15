import Foundation

/// The profile of a snow pile along a ledge: one height per column, columns `cell` points wide.
/// x coordinates are local to the ledge (0 at its left end).
public struct HeightField: Equatable {
    public static let cell: Float = 4

    public private(set) var heights: [Float]
    public var maxHeight: Float
    /// Changes whenever the profile changes; lets the renderer skip rebuilding an unchanged pile.
    public private(set) var version: Int = 0

    public init(width: Float, maxHeight: Float) {
        heights = [Float](repeating: 0, count: HeightField.columns(for: width))
        self.maxHeight = maxHeight
    }

    static func columns(for width: Float) -> Int {
        max(1, Int((width / cell).rounded(.up)))
    }

    public var width: Float { Float(heights.count) * HeightField.cell }
    public var peak: Float { heights.max() ?? 0 }
    public var total: Float { heights.reduce(0, +) }

    /// Keeps the left-aligned part of the pile when the ledge gets wider or narrower.
    public mutating func resize(width: Float) {
        let count = HeightField.columns(for: width)
        guard count != heights.count else { return }
        if count > heights.count {
            heights.append(contentsOf: [Float](repeating: 0, count: count - heights.count))
        } else {
            heights.removeLast(heights.count - count)
        }
        version &+= 1
    }

    /// Linearly interpolated height at a local x; 0 outside the ledge.
    public func height(at x: Float) -> Float {
        let count = heights.count
        guard count > 0, x >= 0, x <= width else { return 0 }
        let f = x / HeightField.cell - 0.5
        let lower = Int(f.rounded(.down))
        let t = f - Float(lower)
        let a = heights[min(max(lower, 0), count - 1)]
        let b = heights[min(max(lower + 1, 0), count - 1)]
        return a + (b - a) * t
    }

    /// Adds snow around a local x, spread over three columns and capped at `maxHeight`.
    public mutating func deposit(at x: Float, amount: Float) {
        let count = heights.count
        let index = Int((x / HeightField.cell).rounded(.down))
        guard amount > 0, index >= 0, index < count else { return }
        let left = index > 0 ? index - 1 : index
        let right = index < count - 1 ? index + 1 : index
        heights[index] = min(maxHeight, heights[index] + amount * 0.5)
        heights[left] = min(maxHeight, heights[left] + amount * 0.25)
        heights[right] = min(maxHeight, heights[right] + amount * 0.25)
        version &+= 1
    }

    /// One pass of settling: no column may stand more than `maxSlope` above a neighbour, and the
    /// space beyond each end counts as empty, so piles taper and the excess spills off the ends.
    public mutating func relax(maxSlope: Float = 3.2) -> (left: Float, right: Float, moved: Bool) {
        let count = heights.count
        var left: Float = 0
        var right: Float = 0
        var moved = false
        guard count > 0 else { return (0, 0, false) }
        for i in 0..<count {
            let leftNeighbour = i > 0 ? heights[i - 1] : 0
            if heights[i] - leftNeighbour > maxSlope {
                let amount = (heights[i] - leftNeighbour - maxSlope) * 0.5
                heights[i] -= amount
                if i > 0 { heights[i - 1] += amount } else { left += amount }
                moved = true
            }
            let rightNeighbour = i < count - 1 ? heights[i + 1] : 0
            if heights[i] - rightNeighbour > maxSlope {
                let amount = (heights[i] - rightNeighbour - maxSlope) * 0.5
                heights[i] -= amount
                if i < count - 1 { heights[i + 1] += amount } else { right += amount }
                moved = true
            }
        }
        if moved { version &+= 1 }
        return (left, right, moved)
    }

    /// Sweeps snow away around a local x. Returns how much was removed.
    public mutating func brush(at x: Float, radius: Float, strength: Float) -> Float {
        let count = heights.count
        guard radius > 0, strength > 0, count > 0 else { return 0 }
        let first = max(0, Int(((x - radius) / HeightField.cell).rounded(.down)))
        let last = min(count - 1, Int(((x + radius) / HeightField.cell).rounded(.down)))
        guard first <= last else { return 0 }
        var removed: Float = 0
        for i in first...last {
            let centre = (Float(i) + 0.5) * HeightField.cell
            let weight = 1 - abs(centre - x) / radius
            guard weight > 0, heights[i] > 0 else { continue }
            let take = heights[i] * min(1, weight * strength)
            heights[i] -= take
            removed += take
        }
        if removed > 0 { version &+= 1 }
        return removed
    }

    /// Multiplies every column, for melting and for snow shaken off a moving window.
    public mutating func scale(by factor: Float) {
        var changed = false
        for i in heights.indices where heights[i] > 0 {
            let value = heights[i] * factor
            heights[i] = value < 0.05 ? 0 : value
            changed = true
        }
        if changed { version &+= 1 }
    }
}
