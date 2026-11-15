import AppKit
import SpriteKit
import EavesCore

/// The shapes that draw one snow pile.
private final class PileNode {
    let container = SKNode()
    let rim = SKShapeNode()
    let body = SKShapeNode()
    var version = -1
    var spans: [Span] = []
    var builtAt: TimeInterval = 0

    init() {
        // A cool rim one point above the snow keeps it readable on white windows.
        rim.fillColor = SKColor(red: 0.55, green: 0.64, blue: 0.80, alpha: 0.55)
        rim.strokeColor = .clear
        rim.lineWidth = 0
        rim.position = CGPoint(x: 0, y: 1)
        rim.zPosition = 0
        body.fillColor = SKColor(white: 1, alpha: 0.97)
        body.strokeColor = .clear
        body.lineWidth = 0
        body.zPosition = 1
        container.addChild(rim)
        container.addChild(body)
    }
}

/// Draws one screen's `World` with SpriteKit and feeds it windows and the cursor.
final class WeatherScene: SKScene {
    let world: World
    /// Overall opacity chosen in Settings.
    var opacity: CGFloat = 1
    private(set) var frames = 0

    private let sheet: TextureSheet
    private let screenOrigin: CGPoint
    private let primaryHeight: CGFloat

    private let root = SKNode()
    private let particleLayer = SKNode()
    private let pileLayer = SKNode()
    private let flashNode: SKSpriteNode

    private var nodes: [SKSpriteNode] = []
    private var nodeSprite: [UInt8] = []
    private var nodeTint: [UInt32] = []
    private var shown = 0
    private var piles: [Int: PileNode] = [:]

    private var lastTime: TimeInterval = 0
    private var lastGeneration = -1
    private var lastWindowTime: TimeInterval = 0
    private var quietFrames = 0

    /// `screenFrame` is the screen's Cocoa frame; `primaryHeight` the height of the primary display.
    init(screenFrame: CGRect, topInset: CGFloat, primaryHeight: CGFloat, sheet: TextureSheet) {
        world = World(width: Float(screenFrame.width), height: Float(screenFrame.height),
                      topInset: Float(topInset), seed: UInt64.random(in: 1...UInt64.max))
        self.sheet = sheet
        screenOrigin = screenFrame.origin
        self.primaryHeight = primaryHeight
        flashNode = SKSpriteNode(color: .white, size: screenFrame.size)
        super.init(size: screenFrame.size)

        backgroundColor = .clear
        scaleMode = .resizeFill
        anchorPoint = .zero

        addChild(root)
        particleLayer.zPosition = 0
        pileLayer.zPosition = 10
        root.addChild(particleLayer)
        root.addChild(pileLayer)
        flashNode.anchorPoint = .zero
        flashNode.position = .zero
        flashNode.alpha = 0
        flashNode.zPosition = 20
        root.addChild(flashNode)
    }

    required init?(coder aDecoder: NSCoder) {
        fatalError("init(coder:) is not used")
    }

    override func update(_ currentTime: TimeInterval) {
        let dt = lastTime == 0 ? 1.0 / 60 : min(0.05, max(0, currentTime - lastTime))
        lastTime = currentTime
        frames += 1

        let tracker = WindowTracker.shared
        if tracker.generation != lastGeneration {
            let elapsed = lastGeneration < 0 ? 0 : Float(min(0.5, currentTime - lastWindowTime))
            lastGeneration = tracker.generation
            lastWindowTime = currentTime
            world.setWindows(localBoxes(tracker.windows), elapsed: elapsed)
        }

        let mouse = NSEvent.mouseLocation
        world.setCursor(x: Float(mouse.x - screenOrigin.x), y: Float(mouse.y - screenOrigin.y), dt: Float(dt))
        world.step(dt: Float(dt))

        syncParticles()
        syncPiles(now: currentTime)
        flashNode.alpha = CGFloat(world.flash) * 0.11
        let target: CGFloat = world.suppressed ? 0 : opacity
        root.alpha += (target - root.alpha) * CGFloat(min(1, dt * 6))

        // With an empty sky and no snow left there is nothing to draw: stop until something changes.
        if world.isQuiet {
            quietFrames += 1
            if quietFrames > 30 { view?.isPaused = true }
        } else {
            quietFrames = 0
        }
    }

    func clearSnow() {
        world.clearPiles()
    }

    /// The windows that touch this screen, in its local coordinates.
    private func localBoxes(_ windows: [TrackedWindow]) -> [WindowBox] {
        var result: [WindowBox] = []
        result.reserveCapacity(windows.count)
        for window in windows {
            let bounds = window.bounds
            let rect = ScreenSpace.localRect(cgX: Double(bounds.minX), cgY: Double(bounds.minY),
                                             cgWidth: Double(bounds.width), cgHeight: Double(bounds.height),
                                             primaryHeight: Double(primaryHeight),
                                             screenMinX: Double(screenOrigin.x), screenMinY: Double(screenOrigin.y))
            guard rect.maxX > 0, rect.minX < world.width, rect.maxY > 0, rect.minY < world.height else { continue }
            result.append(WindowBox(id: window.id, rect: rect))
        }
        return result
    }

    private func syncParticles() {
        let particles = world.particles
        while nodes.count < particles.count {
            let node = SKSpriteNode(texture: sheet.texture(for: .softDot))
            node.color = .white
            node.colorBlendFactor = 1
            node.isHidden = true
            particleLayer.addChild(node)
            nodes.append(node)
            nodeSprite.append(Sprite.softDot.rawValue)
            nodeTint.append(0xFFFFFF)
        }

        for i in 0..<particles.count {
            let particle = particles[i]
            let node = nodes[i]
            if particle.drawAlpha <= 0.003 {
                if !node.isHidden { node.isHidden = true }
                continue
            }
            if node.isHidden { node.isHidden = false }
            if nodeSprite[i] != particle.sprite.rawValue {
                nodeSprite[i] = particle.sprite.rawValue
                node.texture = sheet.texture(for: particle.sprite)
                node.zPosition = particle.sprite == .mist ? -1 : 0
            }
            let tint = WeatherScene.pack(particle.red, particle.green, particle.blue)
            if nodeTint[i] != tint {
                nodeTint[i] = tint
                node.color = SKColor(red: CGFloat(particle.red), green: CGFloat(particle.green),
                                     blue: CGFloat(particle.blue), alpha: 1)
            }
            node.position = CGPoint(x: CGFloat(particle.x), y: CGFloat(particle.y))
            node.zRotation = CGFloat(particle.rotation)
            node.size = CGSize(width: CGFloat(particle.drawWidth), height: CGFloat(particle.drawHeight))
            node.alpha = CGFloat(min(1, particle.drawAlpha))
        }
        if shown > particles.count {
            for i in particles.count..<shown { nodes[i].isHidden = true }
        }
        shown = particles.count
    }

    private static func pack(_ red: Float, _ green: Float, _ blue: Float) -> UInt32 {
        let r = UInt32(max(0, min(255, red * 255)))
        let g = UInt32(max(0, min(255, green * 255)))
        let b = UInt32(max(0, min(255, blue * 255)))
        return (r << 16) | (g << 8) | b
    }

    private func syncPiles(now: TimeInterval) {
        var live = Set<Int>()
        if world.pilesEnabled {
            for ledge in world.ledges {
                guard let field = world.pile(for: ledge.id), field.peak > 0.3 else { continue }
                live.insert(ledge.id)
                let node: PileNode
                if let existing = piles[ledge.id] {
                    node = existing
                } else {
                    node = PileNode()
                    piles[ledge.id] = node
                    pileLayer.addChild(node.container)
                }
                node.container.position = CGPoint(x: CGFloat(ledge.originX), y: CGFloat(ledge.y))

                // Rebuilding a path is the expensive part, so do it only when the pile or the part
                // of it that is visible has changed, and not more than about fourteen times a second.
                let spans = ledge.spans.map { Span(lo: ($0.lo - ledge.originX).rounded(), hi: ($0.hi - ledge.originX).rounded()) }
                if (node.version != field.version || node.spans != spans) && now - node.builtAt > 0.07 {
                    let path = WeatherScene.pilePath(field, spans: spans)
                    node.body.path = path
                    node.rim.path = path
                    node.version = field.version
                    node.spans = spans
                    node.builtAt = now
                }
            }
        }
        for (id, node) in piles where !live.contains(id) {
            node.container.removeFromParent()
            piles[id] = nil
        }
    }

    /// The outline of a pile, in points relative to the left end of its ledge and the ledge's height.
    private static func pilePath(_ field: HeightField, spans: [Span]) -> CGPath {
        let path = CGMutablePath()
        let step = HeightField.cell
        // Where there is no snow the outline runs just below the window's edge, enclosing nothing.
        let base: CGFloat = -1.5
        for span in spans where span.length > 2 {
            var points: [CGPoint] = []
            var x = span.lo
            while x < span.hi {
                let h = field.height(at: x)
                points.append(CGPoint(x: CGFloat(x), y: h > 0.2 ? CGFloat(h) : base))
                x += step
            }
            let last = field.height(at: span.hi)
            points.append(CGPoint(x: CGFloat(span.hi), y: last > 0.2 ? CGFloat(last) : base))
            guard points.count >= 2, points.contains(where: { $0.y > 0.3 }) else { continue }

            path.move(to: CGPoint(x: CGFloat(span.lo), y: base))
            path.addLine(to: points[0])
            for k in 1..<points.count {
                let previous = points[k - 1]
                let current = points[k]
                let middle = CGPoint(x: (previous.x + current.x) / 2, y: (previous.y + current.y) / 2)
                path.addQuadCurve(to: middle, control: previous)
            }
            path.addLine(to: points[points.count - 1])
            path.addLine(to: CGPoint(x: CGFloat(span.hi), y: base))
            path.closeSubpath()
        }
        return path
    }
}
