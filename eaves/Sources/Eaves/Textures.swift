import CoreGraphics
import SpriteKit
import EavesCore

/// Every particle picture, drawn in code into one sheet so SpriteKit can batch them.
/// Pictures are white or grey and are tinted per particle.
final class TextureSheet {
    private static let cell = 64
    private static let columns = 5
    private static let rows = 2

    private var textures: [SKTexture] = []
    private let mist: SKTexture

    init() {
        let cell = TextureSheet.cell
        let columns = TextureSheet.columns
        let rows = TextureSheet.rows
        let sprites = Sprite.allCases.filter { $0 != .mist }

        let context = TextureSheet.makeContext(width: cell * columns, height: cell * rows)
        for (index, sprite) in sprites.enumerated() {
            context.saveGState()
            context.translateBy(x: CGFloat((index % columns) * cell), y: CGFloat((index / columns) * cell))
            context.clip(to: CGRect(x: 0, y: 0, width: cell, height: cell))
            TextureSheet.draw(sprite, in: context)
            context.restoreGState()
        }
        let sheet = SKTexture(cgImage: context.makeImage()!)
        // One pixel is left unused around each cell so neighbours never bleed into each other.
        let inset = 1 / CGFloat(cell)
        textures = sprites.indices.map { index -> SKTexture in
            let rect = CGRect(x: (CGFloat(index % columns) + inset) / CGFloat(columns),
                              y: (CGFloat(index / columns) + inset) / CGFloat(rows),
                              width: (1 - 2 * inset) / CGFloat(columns),
                              height: (1 - 2 * inset) / CGFloat(rows))
            return SKTexture(rect: rect, in: sheet)
        }

        let haze = TextureSheet.makeContext(width: 256, height: 256)
        TextureSheet.radial(in: haze, centre: CGPoint(x: 128, y: 128), radius: 126, stops: [
            (0, 1, 1, 1, 0.9), (0.3, 1, 1, 1, 0.62), (0.6, 1, 1, 1, 0.24), (0.85, 1, 1, 1, 0.05), (1, 1, 1, 1, 0),
        ])
        mist = SKTexture(cgImage: haze.makeImage()!)
    }

    func texture(for sprite: Sprite) -> SKTexture {
        sprite == .mist ? mist : textures[Int(sprite.rawValue)]
    }

    private static func makeContext(width: Int, height: Int) -> CGContext {
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpaceCreateDeviceRGB(),
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setShouldAntialias(true)
        context.interpolationQuality = .high
        return context
    }

    /// Radial gradient from stops of (position, red, green, blue, alpha).
    private static func radial(in context: CGContext, centre: CGPoint, radius: CGFloat,
                               stops: [(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)]) {
        let colours = stops.map { CGColor(red: $0.1, green: $0.2, blue: $0.3, alpha: $0.4) } as CFArray
        let locations = stops.map { $0.0 }
        guard let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colours,
                                        locations: locations) else { return }
        context.drawRadialGradient(gradient, startCenter: centre, startRadius: 0,
                                   endCenter: centre, endRadius: radius, options: [])
    }

    private static let white = CGColor(red: 1, green: 1, blue: 1, alpha: 1)
    /// A cool grey rim keeps white snow readable over white windows.
    private static let rim = CGColor(red: 0.45, green: 0.55, blue: 0.72, alpha: 0.42)

    private static func draw(_ sprite: Sprite, in context: CGContext) {
        let centre = CGPoint(x: 32, y: 32)
        switch sprite {
        case .softDot:
            radial(in: context, centre: centre, radius: 30, stops: [
                (0, 1, 1, 1, 1), (0.45, 1, 1, 1, 0.92), (0.72, 0.62, 0.70, 0.84, 0.36), (1, 0.5, 0.6, 0.78, 0),
            ])

        case .crispDot:
            context.setFillColor(rim)
            context.fillEllipse(in: CGRect(x: 6, y: 6, width: 52, height: 52))
            context.setFillColor(white)
            context.fillEllipse(in: CGRect(x: 11, y: 11, width: 42, height: 42))

        case .crystal:
            // Six arms, each with a pair of small branches.
            let arms = CGMutablePath()
            for arm in 0..<6 {
                let angle = CGFloat(arm) * .pi / 3
                let tip = CGPoint(x: 32 + cos(angle) * 26, y: 32 + sin(angle) * 26)
                arms.move(to: centre)
                arms.addLine(to: tip)
                let fork = CGPoint(x: 32 + cos(angle) * 15, y: 32 + sin(angle) * 15)
                for side in [-1.0, 1.0] {
                    let branch = angle + CGFloat(side) * .pi / 4
                    arms.move(to: fork)
                    arms.addLine(to: CGPoint(x: fork.x + cos(branch) * 8, y: fork.y + sin(branch) * 8))
                }
            }
            context.setLineCap(.round)
            context.addPath(arms)
            context.setStrokeColor(rim)
            context.setLineWidth(7)
            context.strokePath()
            context.addPath(arms)
            context.setStrokeColor(white)
            context.setLineWidth(3.5)
            context.strokePath()

        case .streak:
            // A raindrop's trail: faint at the top, solid at the falling end.
            // It fills the cell: the particle's own width and length decide how thin it is drawn.
            context.saveGState()
            context.clip(to: CGRect(x: 2, y: 2, width: 60, height: 60))
            let colours = [CGColor(red: 1, green: 1, blue: 1, alpha: 0), white] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colours,
                                         locations: [0, 1]) {
                context.drawLinearGradient(gradient, start: CGPoint(x: 32, y: 62), end: CGPoint(x: 32, y: 2),
                                           options: [])
            }
            context.restoreGState()

        case .ring:
            context.setStrokeColor(white)
            context.setLineWidth(5)
            context.strokeEllipse(in: CGRect(x: 7, y: 7, width: 50, height: 50))

        case .leafA:
            leaf(in: context, halfWidth: 17, tilt: 0)
        case .leafB:
            leaf(in: context, halfWidth: 24, tilt: 0)
        case .leafC:
            leaf(in: context, halfWidth: 9, tilt: 5)

        case .petal:
            let petal = CGMutablePath()
            petal.move(to: CGPoint(x: 32, y: 5))
            petal.addCurve(to: CGPoint(x: 32, y: 59), control1: CGPoint(x: 4, y: 26), control2: CGPoint(x: 12, y: 59))
            petal.addCurve(to: CGPoint(x: 32, y: 5), control1: CGPoint(x: 52, y: 59), control2: CGPoint(x: 60, y: 26))
            petal.closeSubpath()
            context.saveGState()
            context.addPath(petal)
            context.clip()
            let colours = [CGColor(red: 0.80, green: 0.80, blue: 0.80, alpha: 1), white] as CFArray
            if let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colours,
                                         locations: [0, 0.7]) {
                context.drawLinearGradient(gradient, start: CGPoint(x: 32, y: 5), end: CGPoint(x: 32, y: 59),
                                           options: [.drawsAfterEndLocation])
            }
            context.restoreGState()

        case .glow:
            radial(in: context, centre: centre, radius: 30, stops: [
                (0, 1, 1, 1, 1), (0.22, 1, 1, 1, 0.85), (0.5, 1, 1, 1, 0.3), (1, 1, 1, 1, 0),
            ])

        case .mist:
            break
        }
    }

    /// A pointed leaf with a midrib and veins, standing upright in the cell.
    private static func leaf(in context: CGContext, halfWidth: CGFloat, tilt: CGFloat) {
        let base = CGPoint(x: 32 - tilt, y: 9)
        let tip = CGPoint(x: 32 + tilt, y: 60)
        let blade = CGMutablePath()
        blade.move(to: base)
        blade.addCurve(to: tip, control1: CGPoint(x: 32 - halfWidth * 1.5, y: 22),
                       control2: CGPoint(x: 32 - halfWidth, y: 48))
        blade.addCurve(to: base, control1: CGPoint(x: 32 + halfWidth, y: 48),
                       control2: CGPoint(x: 32 + halfWidth * 1.5, y: 22))
        blade.closeSubpath()
        context.addPath(blade)
        context.setFillColor(white)
        context.fillPath()

        // Darker lines survive tinting as a darker shade of the leaf's colour.
        context.setStrokeColor(CGColor(red: 0.62, green: 0.62, blue: 0.62, alpha: 1))
        context.setLineCap(.round)
        context.setLineWidth(2.2)
        context.move(to: CGPoint(x: base.x, y: 3))
        context.addLine(to: CGPoint(x: tip.x, y: 56))
        context.strokePath()
        context.setLineWidth(1.2)
        for step in 1...3 {
            let t = CGFloat(step) / 4
            let x = base.x + (tip.x - base.x) * t
            let y = base.y + (tip.y - base.y) * t
            let reach = halfWidth * 0.55 * (1 - abs(t - 0.45))
            context.move(to: CGPoint(x: x, y: y))
            context.addLine(to: CGPoint(x: x - reach, y: y + 7))
            context.move(to: CGPoint(x: x, y: y))
            context.addLine(to: CGPoint(x: x + reach, y: y + 7))
        }
        context.strokePath()
    }
}
