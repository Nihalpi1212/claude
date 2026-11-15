import Foundation

/// An axis-aligned rectangle in screen-local points, y pointing up.
public struct Rect: Equatable {
    public var minX: Float
    public var minY: Float
    public var maxX: Float
    public var maxY: Float

    public init(minX: Float, minY: Float, maxX: Float, maxY: Float) {
        self.minX = minX
        self.minY = minY
        self.maxX = maxX
        self.maxY = maxY
    }

    public init(x: Float, y: Float, width: Float, height: Float) {
        self.init(minX: x, minY: y, maxX: x + width, maxY: y + height)
    }

    public var width: Float { maxX - minX }
    public var height: Float { maxY - minY }

    public func contains(_ x: Float, _ y: Float) -> Bool {
        x >= minX && x <= maxX && y >= minY && y <= maxY
    }

    public func intersects(_ other: Rect) -> Bool {
        minX < other.maxX && maxX > other.minX && minY < other.maxY && maxY > other.minY
    }
}

/// A horizontal interval, in screen-local points.
public struct Span: Equatable {
    public var lo: Float
    public var hi: Float

    public init(lo: Float, hi: Float) {
        self.lo = lo
        self.hi = hi
    }

    public var length: Float { hi - lo }
}

public enum Spans {
    /// Removes [lo, hi] from every span, splitting spans where needed.
    public static func subtract(_ spans: [Span], lo: Float, hi: Float) -> [Span] {
        guard hi > lo else { return spans }
        var result: [Span] = []
        result.reserveCapacity(spans.count + 1)
        for span in spans {
            if hi <= span.lo || lo >= span.hi {
                result.append(span)
                continue
            }
            if lo > span.lo { result.append(Span(lo: span.lo, hi: lo)) }
            if hi < span.hi { result.append(Span(lo: hi, hi: span.hi)) }
        }
        return result
    }
}

/// One on-screen window, in the coordinates of the screen it is being drawn on.
public struct WindowBox: Equatable {
    public let id: Int
    public var rect: Rect

    public init(id: Int, rect: Rect) {
        self.id = id
        self.rect = rect
    }
}

public enum ScreenSpace {
    /// Converts a window rectangle from Core Graphics global coordinates (origin at the top left of
    /// the primary display, y down) to the local coordinates of one screen (origin at that screen's
    /// bottom left, y up). `screenMinX`/`screenMinY` are the screen's Cocoa frame origin.
    public static func localRect(cgX: Double, cgY: Double, cgWidth: Double, cgHeight: Double,
                                 primaryHeight: Double, screenMinX: Double, screenMinY: Double) -> Rect {
        let cocoaMinY = primaryHeight - (cgY + cgHeight)
        return Rect(x: Float(cgX - screenMinX), y: Float(cocoaMinY - screenMinY),
                    width: Float(cgWidth), height: Float(cgHeight))
    }
}

/// Small, fast, seedable random generator (SplitMix64) so simulations are reproducible in tests.
public struct SplitMix: RandomNumberGenerator {
    private var state: UInt64

    public init(seed: UInt64) {
        state = seed
    }

    public mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }

    /// A value in [0, 1).
    public mutating func unit() -> Float {
        Float(next() >> 40) / Float(1 << 24)
    }

    public mutating func range(_ lo: Float, _ hi: Float) -> Float {
        lo + (hi - lo) * unit()
    }

    public mutating func chance(_ probability: Float) -> Bool {
        unit() < probability
    }
}
