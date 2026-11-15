import Foundation

/// How a particle moves.
public enum Behavior: UInt8 {
    case flake, streak, droplet, ring, leaf, petal, firefly, mote, ember, mist
}

/// Which picture a particle is drawn with. The raw value is the cell in the texture sheet.
public enum Sprite: UInt8, CaseIterable {
    case softDot, crispDot, crystal, streak, ring, leafA, leafB, leafC, petal, glow, mist
}

public struct Particle {
    public var behavior: Behavior
    public var sprite: Sprite
    public var x: Float
    public var y: Float
    public var vx: Float = 0
    public var vy: Float = 0
    /// Nominal size in points (length for rain streaks).
    public var size: Float = 4
    /// 0 far and small ... 1 near and large.
    public var depth: Float = 0.5
    public var rotation: Float = 0
    public var spin: Float = 0
    public var phase: Float = 0
    public var age: Float = 0
    /// Seconds to live; 0 means until it lands or leaves the screen.
    public var life: Float = 0
    public var alpha: Float = 1
    public var red: Float = 1
    public var green: Float = 1
    public var blue: Float = 1
    /// Terminal fall speed (rise speed for embers), points per second.
    public var fall: Float = 40
    /// Whether it settles on the first ledge it meets, or falls past in front of the window.
    public var lander: Bool = true
    /// Window id of the ledge a leaf or petal is lying on; -1 while in the air.
    public var restLedge: Int = -1
    public var restDX: Float = 0
    public var restTime: Float = 0
    public var dead: Bool = false

    // What the renderer draws this frame.
    public var drawAlpha: Float = 0
    public var drawWidth: Float = 0
    public var drawHeight: Float = 0

    public init(behavior: Behavior, sprite: Sprite, x: Float, y: Float) {
        self.behavior = behavior
        self.sprite = sprite
        self.x = x
        self.y = y
    }
}

/// The top edge of a window (or the bottom of the screen) where things can land.
public struct Ledge: Equatable {
    public let id: Int
    /// Screen x of the pile's local x = 0.
    public var originX: Float
    /// The part of the edge that is on this screen.
    public var minX: Float
    public var maxX: Float
    public var y: Float
    /// The parts of the edge that no window in front is covering.
    public var spans: [Span]
    /// True when nothing may fall past this edge in front of its window.
    public var absorbsAll: Bool

    public func isVisible(at x: Float) -> Bool {
        for span in spans where x >= span.lo && x <= span.hi { return true }
        return false
    }
}

/// The simulation for one screen. All coordinates are screen-local points with y pointing up.
public final class World {
    public struct Stats: Equatable {
        public var spawned = 0
        public var landed = 0
        public var frames = 0
    }

    public static let groundID = 0
    public static let maxParticles = 1500
    /// Window corners are rounded, so piles stop short of them.
    public static let cornerInset: Float = 12

    public let width: Float
    public let height: Float
    /// Height of the menu bar; nothing settles where it would cover it.
    public var topInset: Float

    public private(set) var scene: SceneKind?
    public private(set) var intensity: Float = 1
    public private(set) var baseWind: Float = 0
    public var depthMode: DepthMode = .behindActive {
        didSet { if depthMode != oldValue { rebuildLedges() } }
    }
    public var pilesEnabled = true
    public var lightningEnabled = true
    public var hideInFullScreen = true {
        didSet { if hideInFullScreen != oldValue { rebuildLedges() } }
    }

    public private(set) var particles: [Particle] = []
    public private(set) var ledges: [Ledge] = []
    /// True while a full-screen window covers this screen and weather is hidden.
    public private(set) var suppressed = false
    /// Lightning brightness, 0 ... 1.
    public private(set) var flash: Float = 0
    public private(set) var stats = Stats()
    public private(set) var time: Float = 0

    private var piles: [Int: HeightField] = [:]
    private var lastSeen: [Int: Float] = [:]
    private var boxes: [WindowBox] = []
    private var masks: [Rect] = []
    private var ledgeIndex: [Int: Int] = [:]
    private var pending: [Particle] = []
    private var unsettled: Set<Int> = []
    private var rng: SplitMix
    private var spawnCarry: Float = 0
    private var populateTimer: Float = 0
    private var meltTimer: Float = 0
    private var wind: Float = 0
    private var counts = [Int](repeating: 0, count: 10)
    private var nextFlash: Float = 5
    private var flashAge: Float = -1

    private var cursorX: Float = 0
    private var cursorY: Float = 0
    private var cursorVX: Float = 0
    private var cursorVY: Float = 0
    private var cursorSpeed: Float = 0
    private var cursorKnown = false

    public init(width: Float, height: Float, topInset: Float = 0, seed: UInt64 = 0x5EED) {
        self.width = width
        self.height = height
        self.topInset = topInset
        rng = SplitMix(seed: seed)
        rebuildLedges()
    }

    // MARK: Configuration

    public func configure(scene newScene: SceneKind?, intensity newIntensity: Float, wind newWind: Float) {
        if newScene != scene {
            // Creatures and haze from the old scene fade away; things already falling finish their fall.
            for i in particles.indices where particles[i].life <= 0 {
                switch particles[i].behavior {
                case .firefly, .mist, .mote: particles[i].life = particles[i].age + 2.5
                default: break
                }
            }
            scene = newScene
            spawnCarry = 0
            populateTimer = 0
            nextFlash = time + 3
        }
        intensity = max(0, newIntensity)
        baseWind = newWind
    }

    /// True when nothing is on screen and nothing will appear, so rendering can stop.
    public var isQuiet: Bool {
        guard scene == nil, particles.isEmpty, pending.isEmpty else { return false }
        for (_, pile) in piles where pile.peak > 0.3 { return false }
        return true
    }

    public func pile(for id: Int) -> HeightField? {
        piles[id]
    }

    public func clearPiles() {
        piles.removeAll()
        unsettled.removeAll()
        rebuildLedges()
    }

    public func setCursor(x: Float, y: Float, dt: Float) {
        if cursorKnown && dt > 0 {
            let blend = min(1, dt * 12)
            cursorVX += ((x - cursorX) / dt - cursorVX) * blend
            cursorVY += ((y - cursorY) / dt - cursorVY) * blend
            cursorSpeed = (cursorVX * cursorVX + cursorVY * cursorVY).squareRoot()
        }
        cursorX = x
        cursorY = y
        cursorKnown = true
    }

    // MARK: Windows

    /// Takes the windows on this screen, front to back. `elapsed` is the time since the previous
    /// call; pass 0 to skip the effects of movement (snow shaken off, snow falling when a window closes).
    public func setWindows(_ newBoxes: [WindowBox], elapsed: Float = 0) {
        let previous = ledges
        boxes = newBoxes
        rebuildLedges()
        guard elapsed > 0 else { return }

        var vanished: [Ledge] = []
        for old in previous where old.id != World.groundID {
            if let index = ledgeIndex[old.id] {
                let now = ledges[index]
                let dx = now.originX - old.originX
                let dy = now.y - old.y
                let speed = (dx * dx + dy * dy).squareRoot() / elapsed
                if speed > 900 { shed(from: now, fraction: min(0.6, speed / 5000)) }
            } else if !boxes.contains(where: { $0.id == old.id }) {
                vanished.append(old)
            }
        }
        // Many windows going at once is a change of Space, not windows closing: keep their snow.
        if !vanished.isEmpty && vanished.count <= 2 {
            for ledge in vanished { dump(ledge) }
        }
    }

    private func rebuildLedges() {
        var result: [Ledge] = []
        let inset = World.cornerInset
        let frontID = boxes.first?.id

        for (i, box) in boxes.enumerated() {
            let rect = box.rect
            let y = rect.maxY
            let originX = rect.minX + inset
            let fieldWidth = rect.width - inset * 2
            let lo = max(originX, 0)
            let hi = min(rect.maxX - inset, width)
            guard fieldWidth >= 40, hi - lo >= 24, y >= 12, y <= height - topInset - 2 else { continue }

            var spans = [Span(lo: lo, hi: hi)]
            for j in 0..<i {
                let front = boxes[j].rect
                if front.minY < y + 14 && front.maxY > y + 0.5 {
                    spans = Spans.subtract(spans, lo: front.minX - 1, hi: front.maxX + 1)
                }
            }
            spans = spans.filter { $0.length >= 6 }
            guard !spans.isEmpty else { continue }

            if var field = piles[box.id] {
                field.resize(width: fieldWidth)
                piles[box.id] = field
            } else {
                piles[box.id] = HeightField(width: fieldWidth, maxHeight: 16)
            }
            lastSeen[box.id] = time
            let absorbs = depthMode == .behindAll || (depthMode == .behindActive && box.id == frontID)
            result.append(Ledge(id: box.id, originX: originX, minX: lo, maxX: hi, y: y,
                                spans: spans, absorbsAll: absorbs))
        }

        // The bottom of the screen catches whatever is left.
        var groundSpans = [Span(lo: 0, hi: width)]
        for box in boxes where box.rect.minY < 14 {
            groundSpans = Spans.subtract(groundSpans, lo: box.rect.minX - 1, hi: box.rect.maxX + 1)
        }
        groundSpans = groundSpans.filter { $0.length >= 6 }
        if piles[World.groundID] == nil {
            piles[World.groundID] = HeightField(width: width, maxHeight: 22)
        }
        result.append(Ledge(id: World.groundID, originX: 0, minX: 0, maxX: width, y: 0,
                            spans: groundSpans, absorbsAll: true))

        ledges = result
        ledgeIndex.removeAll(keepingCapacity: true)
        for (index, ledge) in result.enumerated() { ledgeIndex[ledge.id] = index }

        switch depthMode {
        case .front: masks = []
        case .behindActive: masks = boxes.first.map { [$0.rect] } ?? []
        case .behindAll: masks = boxes.map { $0.rect }
        }

        if hideInFullScreen, let front = boxes.first?.rect {
            suppressed = front.minX <= 1 && front.maxX >= width - 1 && front.minY <= 1 && front.maxY >= height - 1
        } else {
            suppressed = false
        }

        // Forget the snow of windows that have not been seen for a quarter of an hour.
        for (id, seen) in lastSeen where time - seen > 900 {
            lastSeen[id] = nil
            piles[id] = nil
        }
    }

    /// A window was moved fast: some of its snow comes off.
    private func shed(from ledge: Ledge, fraction: Float) {
        guard pilesEnabled, var field = piles[ledge.id], field.peak > 0.5 else { return }
        var emitted = 0
        var attempts = 0
        while emitted < 14 && attempts < 40 {
            attempts += 1
            let x = rng.range(ledge.minX, ledge.maxX)
            let h = field.height(at: x - ledge.originX)
            guard h > 0.6, ledge.isVisible(at: x) else { continue }
            emitFlake(x: x, y: ledge.y + h, vx: rng.range(-50, 50), vy: rng.range(10, 70),
                      size: rng.range(2.2, 4), lander: true)
            emitted += 1
        }
        field.scale(by: 1 - fraction)
        piles[ledge.id] = field
    }

    /// A window closed: its snow falls.
    private func dump(_ ledge: Ledge) {
        guard let field = piles[ledge.id] else { return }
        piles[ledge.id] = nil
        lastSeen[ledge.id] = nil
        guard pilesEnabled, field.peak > 0.5 else { return }
        let wanted = min(36, Int(field.total / 6) + 4)
        var emitted = 0
        var attempts = 0
        while emitted < wanted && attempts < 120 {
            attempts += 1
            let x = rng.range(ledge.minX, ledge.maxX)
            let h = field.height(at: x - ledge.originX)
            guard h > 0.5, ledge.isVisible(at: x) else { continue }
            emitFlake(x: x, y: ledge.y + h * rng.unit(), vx: rng.range(-12, 12), vy: rng.range(-30, 0),
                      size: rng.range(2.5, 4.5), lander: true)
            emitted += 1
        }
    }

    // MARK: Stepping

    public func step(dt rawDT: Float) {
        let dt = min(max(rawDT, 0), 0.05)
        time += dt
        stats.frames += 1
        wind = baseWind * (1 + 0.35 * sin(time * 0.13) + 0.2 * sin(time * 0.71 + 1.3))

        if !suppressed { spawn(dt: dt) }

        for i in counts.indices { counts[i] = 0 }
        for i in particles.indices {
            var particle = particles[i]
            update(&particle, dt: dt)
            particles[i] = particle
        }
        particles.removeAll(where: { $0.dead })

        brushPiles(dt: dt)
        settlePiles(dt: dt)
        updateLightning(dt: dt)

        if !pending.isEmpty {
            let room = max(0, World.maxParticles - particles.count)
            particles.append(contentsOf: pending.prefix(room))
            pending.removeAll(keepingCapacity: true)
        }
    }

    private func add(_ particle: Particle) {
        pending.append(particle)
        stats.spawned += 1
    }

    private var hasRoom: Bool {
        particles.count + pending.count < World.maxParticles
    }

    // MARK: Spawning

    private func spawn(dt: Float) {
        guard let scene = scene else { return }
        let lane = width / 1000 * intensity
        let area = (width * height) / (1440 * 900) * intensity

        switch scene {
        case .snow:
            emit(rate: 16 * lane, dt: dt) { self.spawnFlake(blizzard: false) }
        case .blizzard:
            emit(rate: 58 * lane, dt: dt) { self.spawnFlake(blizzard: true) }
        case .rain:
            emit(rate: 60 * lane, dt: dt) { self.spawnStreak(storm: false) }
        case .storm:
            emit(rate: 120 * lane, dt: dt) { self.spawnStreak(storm: true) }
        case .leaves:
            emit(rate: 1.6 * lane, dt: dt) { self.spawnLeaf(petal: false) }
        case .petals:
            emit(rate: 3 * lane, dt: dt) { self.spawnLeaf(petal: true) }
        case .embers:
            emit(rate: 9 * lane, dt: dt) { self.spawnEmber() }
        case .fireflies:
            populate(.firefly, target: max(3, Int(11 * area)), every: 0.35, dt: dt) { self.spawnFirefly() }
        case .motes:
            populate(.mote, target: max(6, Int(28 * area)), every: 0.2, dt: dt) { self.spawnMote() }
        case .mist:
            populate(.mist, target: max(3, Int(5 * area)), every: 1.2, dt: dt) { self.spawnMist() }
        }
    }

    private func emit(rate: Float, dt: Float, _ make: () -> Void) {
        spawnCarry += rate * dt
        var count = Int(spawnCarry)
        spawnCarry -= Float(count)
        count = min(count, 40)
        while count > 0 && hasRoom {
            make()
            count -= 1
        }
    }

    private func populate(_ behavior: Behavior, target: Int, every: Float, dt: Float, _ make: () -> Void) {
        populateTimer += dt
        guard populateTimer >= every else { return }
        populateTimer = 0
        if counts[Int(behavior.rawValue)] < target && hasRoom { make() }
    }

    private var landShare: Float {
        switch depthMode {
        case .front: return 0.5
        case .behindActive: return 0.6
        case .behindAll: return 1
        }
    }

    private func spawnFlake(blizzard: Bool) {
        let depth = pow(rng.unit(), 1.6)
        var flake = Particle(behavior: .flake, sprite: depth < 0.35 ? .crispDot : .softDot,
                             x: rng.range(-40, width + 40), y: height + 8)
        flake.depth = depth
        flake.size = 2.2 + 4.5 * depth
        flake.alpha = 0.55 + 0.4 * depth
        if depth > 0.86 && !blizzard {
            flake.sprite = .crystal
            flake.size = rng.range(8, 12)
            flake.spin = rng.range(-0.8, 0.8)
            flake.alpha = 0.9
        }
        flake.fall = (32 + 58 * depth) * (blizzard ? 2.4 : 1)
        flake.phase = rng.range(0, 6.283)
        flake.vx = wind
        flake.vy = -flake.fall
        flake.lander = rng.chance(landShare)
        add(flake)
    }

    private func emitFlake(x: Float, y: Float, vx: Float, vy: Float, size: Float, lander: Bool) {
        guard hasRoom else { return }
        var flake = Particle(behavior: .flake, sprite: .softDot, x: x, y: y)
        flake.depth = 0.5
        flake.size = size
        flake.alpha = 0.9
        flake.fall = rng.range(45, 80)
        flake.phase = rng.range(0, 6.283)
        flake.vx = vx
        flake.vy = vy
        flake.lander = lander
        add(flake)
    }

    private func spawnStreak(storm: Bool) {
        let depth = rng.unit()
        let speed = (650 + 450 * depth) * (storm ? 1.15 : 1)
        let vx = wind * (0.8 + 0.4 * depth)
        // Start far enough upwind that the streak crosses the screen instead of leaving it.
        let drift = vx * (height / speed)
        var streak = Particle(behavior: .streak, sprite: .streak,
                              x: rng.range(-40 - max(0, drift), width + 40 + max(0, -drift)), y: height + 20)
        streak.depth = depth
        streak.size = 12 + 16 * depth
        streak.alpha = 0.22 + 0.3 * depth
        streak.red = 0.72
        streak.green = 0.82
        streak.blue = 0.98
        streak.vx = vx
        streak.vy = -speed
        streak.rotation = atan2(vx, speed)
        streak.lander = rng.chance(landShare)
        add(streak)
    }

    private func spawnLeaf(petal: Bool) {
        var leaf = Particle(behavior: petal ? .petal : .leaf, sprite: .petal,
                            x: rng.range(-40, width + 40), y: height + 14)
        if petal {
            leaf.size = rng.range(8, 13)
            leaf.fall = rng.range(28, 50)
            let shade = rng.unit()
            leaf.red = 1
            leaf.green = 0.70 + 0.2 * shade
            leaf.blue = 0.80 + 0.15 * shade
        } else {
            let sprites: [Sprite] = [.leafA, .leafB, .leafC]
            leaf.sprite = sprites[Int(rng.next() % 3)]
            leaf.size = rng.range(14, 24)
            leaf.fall = rng.range(38, 70)
            let palette: [(Float, Float, Float)] = [
                (0.86, 0.36, 0.12), (0.93, 0.60, 0.14), (0.72, 0.20, 0.12), (0.80, 0.52, 0.22), (0.62, 0.36, 0.16),
            ]
            let colour = palette[Int(rng.next() % UInt64(palette.count))]
            leaf.red = colour.0
            leaf.green = colour.1
            leaf.blue = colour.2
        }
        leaf.depth = rng.unit()
        leaf.alpha = 0.95
        leaf.phase = rng.range(0, 6.283)
        leaf.rotation = rng.range(0, 6.283)
        leaf.spin = rng.range(-1.6, 1.6)
        leaf.vx = wind
        leaf.vy = -leaf.fall
        leaf.lander = rng.chance(landShare)
        add(leaf)
    }

    private func spawnFirefly() {
        var fly = Particle(behavior: .firefly, sprite: .glow,
                           x: rng.range(60, max(61, width - 60)), y: rng.range(60, max(61, height - topInset - 60)))
        fly.depth = rng.unit()
        fly.size = 9 + 8 * fly.depth
        fly.alpha = 0.95
        fly.red = 0.80
        fly.green = 0.95
        fly.blue = 0.30
        fly.phase = rng.range(0, 6.283)
        fly.spin = rng.range(0, 6.283)
        add(fly)
    }

    private func spawnMote() {
        var mote = Particle(behavior: .mote, sprite: .glow,
                            x: rng.range(0, width), y: rng.range(0, height - topInset))
        mote.depth = rng.unit()
        mote.size = 3 + 4 * mote.depth
        mote.alpha = 0.5
        mote.red = 1
        mote.green = 0.86
        mote.blue = 0.55
        mote.phase = rng.range(0, 6.283)
        mote.life = rng.range(7, 13)
        add(mote)
    }

    private func spawnEmber() {
        var ember = Particle(behavior: .ember, sprite: .glow, x: rng.range(0, width), y: -6)
        ember.depth = rng.unit()
        ember.size = 3.5 + 4 * ember.depth
        ember.alpha = 0.95
        ember.fall = rng.range(45, 120)
        ember.vy = ember.fall
        ember.phase = rng.range(0, 6.283)
        ember.life = rng.range(2.5, 5.5)
        add(ember)
    }

    private func spawnMist() {
        var bank = Particle(behavior: .mist, sprite: .mist,
                            x: rng.range(0, width), y: rng.range(height * 0.05, height * 0.45))
        bank.size = rng.range(520, 900)
        bank.alpha = rng.range(0.05, 0.085)
        let direction: Float = wind >= 0 ? 1 : -1
        bank.vx = direction * rng.range(6, 16)
        bank.phase = rng.range(0, 6.283)
        add(bank)
    }

    // MARK: Particle updates

    private func update(_ p: inout Particle, dt: Float) {
        p.age += dt
        if p.life > 0 && p.age >= p.life {
            p.dead = true
            return
        }

        switch p.behavior {
        case .flake: updateFlake(&p, dt: dt)
        case .streak: updateStreak(&p, dt: dt)
        case .droplet: updateDroplet(&p, dt: dt)
        case .ring: updateRing(&p)
        case .leaf, .petal: updateLeaf(&p, dt: dt)
        case .firefly: updateFirefly(&p, dt: dt)
        case .mote: updateMote(&p, dt: dt)
        case .ember: updateEmber(&p, dt: dt)
        case .mist: updateMist(&p, dt: dt)
        }

        if p.dead {
            p.drawAlpha = 0
            return
        }
        if p.behavior != .mist && p.drawAlpha > 0 {
            for mask in masks where mask.contains(p.x, p.y) {
                p.drawAlpha = 0
                break
            }
        }
    }

    /// Fades a particle out over the last `seconds` of its life.
    private func ending(_ p: Particle, over seconds: Float) -> Float {
        guard p.life > 0 else { return 1 }
        return min(1, max(0, (p.life - p.age) / seconds))
    }

    /// A fast-moving cursor drags the air along with it.
    private func gust(_ p: inout Particle, dt: Float) {
        guard cursorSpeed > 120 else { return }
        let dx = p.x - cursorX
        let dy = p.y - cursorY
        let distance = dx * dx + dy * dy
        guard distance < 4900 else { return }
        let push = (1 - distance / 4900) * min(1, dt * 6) * 0.5
        p.vx += cursorVX * push
        p.vy += cursorVY * push
    }

    private func wrap(_ p: inout Particle, margin: Float) {
        if p.x < -margin {
            p.x += width + margin * 2
        } else if p.x > width + margin {
            p.x -= width + margin * 2
        }
    }

    /// The ledge a particle at `x` meets while falling from `from` to `to`, and the height it lands at.
    private func landing(x: Float, from: Float, to: Float, lander: Bool) -> (ledge: Ledge, surface: Float)? {
        var best: (ledge: Ledge, surface: Float)? = nil
        for ledge in ledges {
            if x < ledge.minX || x > ledge.maxX { continue }
            if !(lander || ledge.absorbsAll) { continue }
            if from < ledge.y || to > ledge.y + 24 { continue }
            if !ledge.isVisible(at: x) { continue }
            var surface = ledge.y
            if pilesEnabled, let pile = piles[ledge.id] {
                surface += pile.height(at: x - ledge.originX)
            }
            if from >= surface && to < surface {
                if let current = best, current.surface >= surface { continue }
                best = (ledge, surface)
            }
        }
        return best
    }

    private func updateFlake(_ p: inout Particle, dt: Float) {
        let sway = sin(p.phase + time * (0.8 + p.depth)) * (10 + 14 * p.depth)
        let targetVX = wind * (0.5 + 0.8 * p.depth) + sway
        p.vx += (targetVX - p.vx) * min(1, dt * 2.5)
        p.vy += (-p.fall - p.vy) * min(1, dt * 3)
        gust(&p, dt: dt)

        let before = p.y
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.rotation += p.spin * dt
        wrap(&p, margin: 40)

        if p.vy < 0, let hit = landing(x: p.x, from: before, to: p.y, lander: p.lander) {
            if pilesEnabled {
                piles[hit.ledge.id]?.deposit(at: p.x - hit.ledge.originX, amount: 0.22 + 0.07 * p.size)
                unsettled.insert(hit.ledge.id)
            }
            stats.landed += 1
            p.dead = true
            return
        }
        if p.y < -14 {
            p.dead = true
            return
        }
        p.drawAlpha = p.alpha
        p.drawWidth = p.size
        p.drawHeight = p.size
    }

    private func updateStreak(_ p: inout Particle, dt: Float) {
        let before = p.y
        p.x += p.vx * dt
        p.y += p.vy * dt
        if let hit = landing(x: p.x, from: before, to: p.y, lander: p.lander) {
            splash(x: p.x, y: hit.surface, strength: p.depth)
            stats.landed += 1
            p.dead = true
            return
        }
        if p.y < -40 {
            p.dead = true
            return
        }
        p.drawAlpha = p.alpha
        p.drawWidth = 1.2 + 0.7 * p.depth
        p.drawHeight = p.size
    }

    private func splash(x: Float, y: Float, strength: Float) {
        guard hasRoom else { return }
        var ring = Particle(behavior: .ring, sprite: .ring, x: x, y: y + 1.5)
        ring.size = 9 + 8 * strength
        ring.alpha = 0.35 + 0.25 * strength
        ring.life = 0.32
        ring.red = 0.78
        ring.green = 0.86
        ring.blue = 1
        add(ring)

        guard rng.chance(0.6), hasRoom else { return }
        var drop = Particle(behavior: .droplet, sprite: .crispDot, x: x, y: y + 2)
        drop.size = 1.8 + strength
        drop.alpha = 0.55
        drop.life = 0.34
        drop.vx = rng.range(-45, 45) + wind * 0.2
        drop.vy = rng.range(70, 150)
        drop.red = 0.78
        drop.green = 0.86
        drop.blue = 1
        add(drop)
    }

    private func updateDroplet(_ p: inout Particle, dt: Float) {
        p.vy -= 900 * dt
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.drawAlpha = p.alpha * ending(p, over: 0.2)
        p.drawWidth = p.size
        p.drawHeight = p.size
    }

    private func updateRing(_ p: inout Particle) {
        let t = p.life > 0 ? p.age / p.life : 1
        p.drawAlpha = p.alpha * (1 - t)
        p.drawWidth = p.size * (0.3 + 0.7 * t)
        p.drawHeight = p.drawWidth * 0.32
    }

    private func updateLeaf(_ p: inout Particle, dt: Float) {
        if p.restLedge >= 0 {
            updateRestingLeaf(&p, dt: dt)
            return
        }

        let flutter = sin(p.phase + time * 2.2)
        let targetVX = wind * 0.9 + flutter * 45
        p.vx += (targetVX - p.vx) * min(1, dt * 2)
        let targetVY = -p.fall * (0.75 + 0.25 * cos(p.phase * 1.7 + time * 3.1))
        p.vy += (targetVY - p.vy) * min(1, dt * 3)
        gust(&p, dt: dt)

        let before = p.y
        p.x += p.vx * dt
        p.y += p.vy * dt
        p.rotation += p.spin * (0.6 + 0.4 * flutter) * dt
        wrap(&p, margin: 40)

        if p.vy < 0, let hit = landing(x: p.x, from: before, to: p.y, lander: p.lander) {
            stats.landed += 1
            p.restLedge = hit.ledge.id
            p.restDX = p.x - hit.ledge.originX
            p.restTime = hit.ledge.id == World.groundID ? rng.range(5, 9) : rng.range(4, 12)
            p.rotation = rng.range(-0.25, 0.25) + (rng.chance(0.5) ? 0 : Float.pi)
            p.vx = 0
            p.vy = 0
            updateRestingLeaf(&p, dt: 0)
            return
        }
        if p.y < -24 {
            p.dead = true
            return
        }
        // Tumbling: the leaf turns edge-on and back as it falls.
        let turn = abs(cos(p.phase + time * (1.5 + p.depth)))
        p.drawAlpha = p.alpha * ending(p, over: 1.5)
        p.drawWidth = p.size * (0.3 + 0.7 * turn)
        p.drawHeight = p.size
    }

    private func updateRestingLeaf(_ p: inout Particle, dt: Float) {
        guard let index = ledgeIndex[p.restLedge] else {
            releaseLeaf(&p, lift: 0)
            return
        }
        let ledge = ledges[index]
        p.x = ledge.originX + p.restDX
        guard ledge.isVisible(at: p.x) else {
            releaseLeaf(&p, lift: 0)
            return
        }
        var surface = ledge.y
        if pilesEnabled, let pile = piles[ledge.id] { surface += pile.height(at: p.restDX) }
        p.y = surface + p.size * 0.16
        p.restTime -= dt

        if p.restTime <= 0 {
            if ledge.id == World.groundID {
                // On the ground a leaf simply fades away.
                if p.life <= 0 { p.life = p.age + 1.5 }
            } else {
                releaseLeaf(&p, lift: rng.range(20, 45))
                return
            }
        }
        p.drawAlpha = p.alpha * ending(p, over: 1.5)
        p.drawWidth = p.size
        p.drawHeight = p.size * 0.42
    }

    /// The wind picks a resting leaf up again.
    private func releaseLeaf(_ p: inout Particle, lift: Float) {
        p.restLedge = -1
        p.lander = false
        p.vy = lift
        let direction: Float = wind >= 0 ? 1 : -1
        p.vx = direction * rng.range(40, 110)
        p.drawAlpha = p.alpha
        p.drawWidth = p.size
        p.drawHeight = p.size
    }

    private func updateFirefly(_ p: inout Particle, dt: Float) {
        if p.life <= 0 { counts[Int(Behavior.firefly.rawValue)] += 1 }
        p.phase += dt * (1.1 + p.depth)
        p.spin += (rng.unit() - 0.5) * dt * 5
        let speed = 14 + 22 * p.depth
        var targetVX = cos(p.spin) * speed
        var targetVY = sin(p.spin) * speed * 0.6

        // Stay on screen.
        let top = height - topInset
        if p.x < 80 { targetVX += (80 - p.x) * 1.2 }
        if p.x > width - 80 { targetVX -= (p.x - (width - 80)) * 1.2 }
        if p.y < 60 { targetVY += (60 - p.y) * 1.2 }
        if p.y > top - 60 { targetVY -= (p.y - (top - 60)) * 1.2 }

        // Shy of the cursor.
        if cursorKnown {
            let dx = p.x - cursorX
            let dy = p.y - cursorY
            let distance = (dx * dx + dy * dy).squareRoot()
            if distance < 110 && distance > 0.01 {
                let push = (110 - distance) * 2.5
                targetVX += dx / distance * push
                targetVY += dy / distance * push
            }
        }

        p.vx += (targetVX - p.vx) * min(1, dt * 2)
        p.vy += (targetVY - p.vy) * min(1, dt * 2)
        p.x += p.vx * dt
        p.y += p.vy * dt

        let pulse = max(0, sin(p.phase))
        let appear = min(1, p.age / 2)
        p.drawAlpha = p.alpha * (0.1 + 0.9 * pulse * pulse) * appear * ending(p, over: 2.5)
        p.drawWidth = p.size
        p.drawHeight = p.size
    }

    private func updateMote(_ p: inout Particle, dt: Float) {
        if p.life - p.age > 2.5 { counts[Int(Behavior.mote.rawValue)] += 1 }
        let targetVX = wind * 0.08 + sin(p.phase + time * 0.5) * 6
        p.vx += (targetVX - p.vx) * min(1, dt)
        p.vy = cos(p.phase * 1.3 + time * 0.4) * 5 + 2
        gust(&p, dt: dt)
        p.x += p.vx * dt
        p.y += p.vy * dt
        let appear = min(1, p.age / 1.5)
        let twinkle = 0.6 + 0.4 * sin(time * 2 + p.phase)
        p.drawAlpha = p.alpha * appear * ending(p, over: 1.5) * twinkle
        p.drawWidth = p.size
        p.drawHeight = p.size
    }

    private func updateEmber(_ p: inout Particle, dt: Float) {
        let targetVX = sin(p.phase + time * 2.5) * 30 + wind * 0.3
        p.vx += (targetVX - p.vx) * min(1, dt * 2)
        p.fall *= 1 - 0.15 * dt
        p.vy += (p.fall - p.vy) * min(1, dt * 2)
        gust(&p, dt: dt)
        p.x += p.vx * dt
        p.y += p.vy * dt

        let t = p.life > 0 ? min(1, p.age / p.life) : 1
        // White-hot, then orange, then a dull red as it cools.
        if t < 0.4 {
            let k = t / 0.4
            p.red = 1
            p.green = 0.90 - 0.40 * k
            p.blue = 0.55 - 0.45 * k
        } else {
            let k = (t - 0.4) / 0.6
            p.red = 1 - 0.3 * k
            p.green = 0.50 - 0.38 * k
            p.blue = 0.10 - 0.05 * k
        }
        let flicker = 0.75 + 0.25 * sin(time * 18 + p.phase)
        p.drawAlpha = p.alpha * pow(1 - t, 1.2) * flicker
        p.drawWidth = p.size * (1 - 0.5 * t)
        p.drawHeight = p.drawWidth
    }

    private func updateMist(_ p: inout Particle, dt: Float) {
        if p.life <= 0 { counts[Int(Behavior.mist.rawValue)] += 1 }
        p.x += p.vx * dt
        wrap(&p, margin: p.size * 0.5)
        let appear = min(1, p.age / 6)
        let breathe = 0.8 + 0.2 * sin(time * 0.2 + p.phase)
        p.drawAlpha = p.alpha * appear * ending(p, over: 2.5) * breathe
        p.drawWidth = p.size
        p.drawHeight = p.size * 0.42
    }

    // MARK: Piles

    /// Moving the cursor through a pile sweeps the snow off it.
    private func brushPiles(dt: Float) {
        guard pilesEnabled, cursorKnown, cursorSpeed > 40 else { return }
        for ledge in ledges {
            guard cursorX >= ledge.minX, cursorX <= ledge.maxX,
                  cursorY >= ledge.y - 4, cursorY <= ledge.y + 30,
                  ledge.isVisible(at: cursorX), var field = piles[ledge.id] else { continue }
            let local = cursorX - ledge.originX
            let top = field.height(at: local)
            guard top > 0.4, cursorY <= ledge.y + top + 8 else { continue }
            let removed = field.brush(at: local, radius: 16, strength: min(1, dt * 10))
            piles[ledge.id] = field
            guard removed > 0.05 else { continue }
            let puffs = min(5, Int(removed / 0.8) + 1)
            for _ in 0..<puffs {
                emitFlake(x: cursorX + rng.range(-10, 10), y: ledge.y + top + 2,
                          vx: cursorVX * 0.35 + rng.range(-40, 40),
                          vy: max(cursorVY, 0) * 0.3 + rng.range(30, 110),
                          size: rng.range(2, 3.5), lander: true)
            }
        }
    }

    private func settlePiles(dt: Float) {
        if !unsettled.isEmpty {
            var still: Set<Int> = []
            for id in unsettled {
                guard var field = piles[id] else { continue }
                let result = field.relax()
                piles[id] = field
                if result.moved { still.insert(id) }
                guard id != World.groundID, let index = ledgeIndex[id] else { continue }
                let ledge = ledges[index]
                // Snow pushed past the end of the ledge falls off it.
                if result.left > 0.08 && ledge.originX > 2 && ledge.isVisible(at: ledge.minX) {
                    emitFlake(x: ledge.originX - 2, y: ledge.y + 1, vx: rng.range(-18, -4), vy: 0,
                              size: rng.range(2.2, 3.6), lander: true)
                }
                let end = ledge.originX + field.width
                if result.right > 0.08 && end < width - 2 && ledge.isVisible(at: ledge.maxX) {
                    emitFlake(x: end + 2, y: ledge.y + 1, vx: rng.range(4, 18), vy: 0,
                              size: rng.range(2.2, 3.6), lander: true)
                }
            }
            unsettled = still
        }

        // Snow lasts while it is snowing, melts slowly otherwise and quickly in the rain.
        meltTimer += dt
        guard meltTimer >= 0.25 else { return }
        let elapsed = meltTimer
        meltTimer = 0
        let lifetime: Float
        if let scene = scene {
            if scene.isSnowy { return }
            lifetime = scene.isRainy ? 20 : 120
        } else {
            lifetime = 120
        }
        let factor = exp(-elapsed / lifetime)
        for (id, pile) in piles where pile.peak > 0 {
            var field = pile
            field.scale(by: pile.peak < 0.4 ? 0 : factor)
            piles[id] = field
        }
    }

    // MARK: Lightning

    private func updateLightning(dt: Float) {
        if flashAge >= 0 {
            flashAge += dt
            // Two quick pulses, then a slow fade.
            let t = flashAge
            if t < 0.05 {
                flash = t / 0.05
            } else if t < 0.14 {
                flash = 1 - 0.7 * (t - 0.05) / 0.09
            } else if t < 0.20 {
                flash = 0.3 + 0.5 * (t - 0.14) / 0.06
            } else if t < 0.9 {
                flash = 0.8 * (1 - (t - 0.20) / 0.7)
            } else {
                flash = 0
                flashAge = -1
            }
            return
        }
        flash = 0
        guard scene == .storm, lightningEnabled, !suppressed else { return }
        if time >= nextFlash {
            flashAge = 0
            nextFlash = time + rng.range(9, 26)
        }
    }
}
