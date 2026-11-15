import XCTest
@testable import EavesCore

final class GeometryTests: XCTestCase {
    func testSubtractSplitsSpans() {
        let spans = Spans.subtract([Span(lo: 0, hi: 100)], lo: 40, hi: 60)
        XCTAssertEqual(spans, [Span(lo: 0, hi: 40), Span(lo: 60, hi: 100)])
    }

    func testSubtractTrimsAndRemoves() {
        XCTAssertEqual(Spans.subtract([Span(lo: 0, hi: 100)], lo: -10, hi: 30), [Span(lo: 30, hi: 100)])
        XCTAssertEqual(Spans.subtract([Span(lo: 0, hi: 100)], lo: 70, hi: 200), [Span(lo: 0, hi: 70)])
        XCTAssertEqual(Spans.subtract([Span(lo: 10, hi: 20)], lo: 0, hi: 50), [])
        XCTAssertEqual(Spans.subtract([Span(lo: 10, hi: 20)], lo: 30, hi: 50), [Span(lo: 10, hi: 20)])
    }

    func testWindowRectIsFlippedIntoScreenCoordinates() {
        // A 400 x 300 window 100 points below the top of a 900 point tall primary display.
        let rect = ScreenSpace.localRect(cgX: 50, cgY: 100, cgWidth: 400, cgHeight: 300,
                                         primaryHeight: 900, screenMinX: 0, screenMinY: 0)
        XCTAssertEqual(rect, Rect(minX: 50, minY: 500, maxX: 450, maxY: 800))
    }

    func testWindowRectOnASecondScreen() {
        // A second display to the right of the primary one, its bottom edge 200 points higher.
        let rect = ScreenSpace.localRect(cgX: 1500, cgY: 0, cgWidth: 200, cgHeight: 100,
                                         primaryHeight: 900, screenMinX: 1440, screenMinY: 200)
        XCTAssertEqual(rect, Rect(minX: 60, minY: 600, maxX: 260, maxY: 700))
    }

    func testRandomIsReproducibleAndInRange() {
        var a = SplitMix(seed: 7)
        var b = SplitMix(seed: 7)
        for _ in 0..<200 {
            let value = a.unit()
            XCTAssertEqual(value, b.unit())
            XCTAssertTrue(value >= 0 && value < 1)
        }
    }
}

final class HeightFieldTests: XCTestCase {
    func testDepositRaisesThePileAndIsCapped() {
        var field = HeightField(width: 200, maxHeight: 10)
        field.deposit(at: 100, amount: 2)
        XCTAssertEqual(field.total, 2, accuracy: 0.001)
        XCTAssertGreaterThan(field.height(at: 102), 0.5)
        for _ in 0..<200 { field.deposit(at: 100, amount: 2) }
        XCTAssertLessThanOrEqual(field.peak, 10)
    }

    func testDepositOutsideIsIgnored() {
        var field = HeightField(width: 200, maxHeight: 10)
        field.deposit(at: -5, amount: 2)
        field.deposit(at: 500, amount: 2)
        XCTAssertEqual(field.total, 0)
        XCTAssertEqual(field.height(at: -5), 0)
        XCTAssertEqual(field.height(at: 500), 0)
    }

    func testRelaxLimitsTheSlopeAndSpillsOffTheEnds() {
        var field = HeightField(width: 40, maxHeight: 30)
        for _ in 0..<60 { field.deposit(at: 2, amount: 1) }
        var spilled: Float = 0
        for _ in 0..<400 {
            let result = field.relax()
            spilled += result.left + result.right
            if !result.moved { break }
        }
        XCTAssertGreaterThan(spilled, 0)
        let heights = field.heights
        XCTAssertLessThanOrEqual(heights[0], 3.2 + 0.01)
        for i in 1..<heights.count {
            XCTAssertLessThanOrEqual(abs(heights[i] - heights[i - 1]), 3.2 + 0.01)
        }
    }

    func testBrushRemovesSnowNearby() {
        var field = HeightField(width: 400, maxHeight: 20)
        for x in stride(from: Float(2), to: 400, by: 4) { field.deposit(at: x, amount: 8) }
        let before = field.height(at: 200)
        let far = field.height(at: 320)
        let removed = field.brush(at: 200, radius: 16, strength: 1)
        XCTAssertGreaterThan(removed, 0)
        XCTAssertLessThan(field.height(at: 200), before * 0.5)
        XCTAssertEqual(field.height(at: 320), far, accuracy: 0.001)
    }

    func testResizeKeepsTheLeftPart() {
        var field = HeightField(width: 100, maxHeight: 20)
        field.deposit(at: 10, amount: 4)
        let before = field.height(at: 10)
        field.resize(width: 300)
        XCTAssertEqual(field.height(at: 10), before, accuracy: 0.001)
        field.resize(width: 40)
        XCTAssertEqual(field.height(at: 10), before, accuracy: 0.001)
        XCTAssertEqual(field.heights.count, 10)
    }

    func testVersionChangesOnlyWhenThePileChanges() {
        var field = HeightField(width: 100, maxHeight: 20)
        let start = field.version
        field.resize(width: 100)
        _ = field.relax()
        _ = field.brush(at: 50, radius: 10, strength: 1)
        XCTAssertEqual(field.version, start)
        field.deposit(at: 50, amount: 1)
        XCTAssertNotEqual(field.version, start)
    }
}

final class WeatherTests: XCTestCase {
    private func reading(_ code: Int, wind: Double = 10, from: Double = 270, day: Bool = true) -> WeatherReading {
        WeatherReading(code: code, temperatureC: 5, windKmh: wind, windFromDegrees: from, isDay: day)
    }

    func testPrecipitationPicksTheMatchingScene() {
        XCTAssertEqual(WeatherMapping.plan(reading: reading(73), month: 1, latitude: 50, ambience: true).scene, .snow)
        XCTAssertEqual(WeatherMapping.plan(reading: reading(63), month: 1, latitude: 50, ambience: true).scene, .rain)
        XCTAssertEqual(WeatherMapping.plan(reading: reading(95), month: 1, latitude: 50, ambience: true).scene, .storm)
        XCTAssertEqual(WeatherMapping.plan(reading: reading(45), month: 1, latitude: 50, ambience: true).scene, .mist)
        XCTAssertEqual(WeatherMapping.plan(reading: reading(75, wind: 50), month: 1, latitude: 50, ambience: true).scene,
                       .blizzard)
    }

    func testHeavierWeatherIsDenser() {
        let light = WeatherMapping.plan(reading: reading(61), month: 1, latitude: 50, ambience: true)
        let heavy = WeatherMapping.plan(reading: reading(65), month: 1, latitude: 50, ambience: true)
        XCTAssertLessThan(light.intensity, heavy.intensity)
    }

    func testClearSkiesFollowTheSeason() {
        XCTAssertEqual(WeatherMapping.plan(reading: reading(0), month: 4, latitude: 50, ambience: true).scene, .petals)
        XCTAssertEqual(WeatherMapping.plan(reading: reading(0), month: 10, latitude: 50, ambience: true).scene, .leaves)
        XCTAssertEqual(WeatherMapping.plan(reading: reading(0, day: false), month: 7, latitude: 50, ambience: true).scene,
                       .fireflies)
        // April is autumn south of the equator.
        XCTAssertEqual(WeatherMapping.plan(reading: reading(0), month: 4, latitude: -35, ambience: true).scene, .leaves)
        XCTAssertNil(WeatherMapping.plan(reading: reading(0), month: 4, latitude: 50, ambience: false).scene)
    }

    func testWindBlowsAwayFromWhereItComesFrom() {
        XCTAssertGreaterThan(WeatherMapping.windPoints(kmh: 20, fromDegrees: 270), 0)
        XCTAssertLessThan(WeatherMapping.windPoints(kmh: 20, fromDegrees: 90), 0)
        XCTAssertEqual(WeatherMapping.windPoints(kmh: 0, fromDegrees: 90), 0)
        XCTAssertLessThanOrEqual(abs(WeatherMapping.windPoints(kmh: 500, fromDegrees: 90)), 260)
    }

    func testEveryCodeHasASummaryAndSymbol() {
        for code in [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99] {
            XCTAssertNotEqual(WeatherMapping.summary(code: code), "Unknown", "code \(code)")
            XCTAssertFalse(WeatherMapping.symbolName(code: code, isDay: true).isEmpty)
        }
    }

    func testForecastRequestRoundsCoordinates() {
        let url = OpenMeteo.forecastURL(latitude: 38.722252, longitude: -9.139337).absoluteString
        XCTAssertTrue(url.contains("latitude=38.72"), url)
        XCTAssertTrue(url.contains("longitude=-9.14"), url)
        XCTAssertFalse(url.contains("38.722"), url)
    }

    func testParsesCurrentWeather() throws {
        let json = """
        {"latitude":38.72,"longitude":-9.14,"current_units":{"temperature_2m":"°C"},
         "current":{"time":"2026-11-15T17:00","interval":900,"temperature_2m":14.3,"weather_code":61,
                    "wind_speed_10m":12.4,"wind_direction_10m":250,"is_day":0}}
        """
        let reading = try OpenMeteo.parseCurrent(Data(json.utf8))
        XCTAssertEqual(reading, WeatherReading(code: 61, temperatureC: 14.3, windKmh: 12.4,
                                               windFromDegrees: 250, isDay: false))
    }

    func testParsesPlacesAndToleratesNoResults() throws {
        let json = """
        {"results":[{"id":2267057,"name":"Lisbon","latitude":38.71667,"longitude":-9.13333,
                     "country":"Portugal","admin1":"Lisbon"}],"generationtime_ms":0.5}
        """
        let places = try OpenMeteo.parsePlaces(Data(json.utf8))
        XCTAssertEqual(places.count, 1)
        XCTAssertEqual(places[0].label, "Lisbon, Portugal")
        let empty = try OpenMeteo.parsePlaces(Data(#"{"generationtime_ms":0.2}"#.utf8))
        XCTAssertEqual(empty, [])
    }
}

final class WorldTests: XCTestCase {
    private func run(_ world: World, seconds: Float) {
        var elapsed: Float = 0
        while elapsed < seconds {
            world.step(dt: 1 / 30)
            elapsed += 1 / 30
        }
    }

    private let window = WindowBox(id: 7, rect: Rect(minX: 200, minY: 200, maxX: 800, maxY: 500))

    func testSnowSettlesOnAWindowAndOnTheGround() {
        let world = World(width: 1000, height: 700, topInset: 24)
        world.depthMode = .behindAll
        world.configure(scene: .blizzard, intensity: 2, wind: 0)
        world.setWindows([window])
        run(world, seconds: 30)
        XCTAssertGreaterThan(world.stats.spawned, 100)
        XCTAssertGreaterThan(world.stats.landed, 50)
        XCTAssertGreaterThan(world.pile(for: 7)?.peak ?? 0, 0.5)
        XCTAssertGreaterThan(world.pile(for: World.groundID)?.peak ?? 0, 0.5)
        XCTAssertLessThanOrEqual(world.particles.count, World.maxParticles)
    }

    func testNothingIsDrawnInsideWindowsWhenBehindAll() {
        let world = World(width: 1000, height: 700, topInset: 24)
        world.depthMode = .behindAll
        world.configure(scene: .snow, intensity: 2, wind: 30)
        world.setWindows([window])
        for _ in 0..<600 {
            world.step(dt: 1 / 30)
            for particle in world.particles where window.rect.contains(particle.x, particle.y) {
                XCTAssertEqual(particle.drawAlpha, 0)
            }
        }
    }

    func testFrontModeLetsSomeSnowFallPastTheWindow() {
        let world = World(width: 1000, height: 700, topInset: 24)
        world.depthMode = .front
        world.configure(scene: .blizzard, intensity: 2, wind: 0)
        world.setWindows([window])
        var seenInFront = false
        for _ in 0..<600 where !seenInFront {
            world.step(dt: 1 / 30)
            seenInFront = world.particles.contains { window.rect.contains($0.x, $0.y) && $0.drawAlpha > 0 }
        }
        XCTAssertTrue(seenInFront)
    }

    func testCoveredPartOfALedgeCollectsNoSnow() {
        let world = World(width: 1000, height: 700, topInset: 24)
        world.depthMode = .behindAll
        world.configure(scene: .blizzard, intensity: 2, wind: 0)
        // A window in front covers the right half of the window behind it.
        let front = WindowBox(id: 9, rect: Rect(minX: 500, minY: 100, maxX: 900, maxY: 650))
        world.setWindows([front, window])
        run(world, seconds: 30)
        let ledge = world.ledges.first { $0.id == 7 }
        XCTAssertNotNil(ledge)
        XCTAssertTrue(ledge?.isVisible(at: 300) ?? false)
        XCTAssertFalse(ledge?.isVisible(at: 700) ?? true)
        let pile = world.pile(for: 7)
        XCTAssertGreaterThan(pile?.height(at: 300 - 212) ?? 0, 0.3)
        XCTAssertEqual(pile?.height(at: 700 - 212) ?? 1, 0, accuracy: 0.001)
    }

    func testWindowUnderTheMenuBarHasNoLedge() {
        let world = World(width: 1000, height: 700, topInset: 24)
        world.setWindows([WindowBox(id: 3, rect: Rect(minX: 0, minY: 100, maxX: 1000, maxY: 676))])
        XCTAssertNil(world.ledges.first { $0.id == 3 })
        XCTAssertNotNil(world.ledges.first { $0.id == World.groundID })
    }

    func testFullScreenWindowHidesTheWeather() {
        let world = World(width: 1000, height: 700, topInset: 24)
        world.configure(scene: .snow, intensity: 1, wind: 0)
        world.setWindows([WindowBox(id: 3, rect: Rect(minX: 0, minY: 0, maxX: 1000, maxY: 700))])
        XCTAssertTrue(world.suppressed)
        run(world, seconds: 5)
        XCTAssertEqual(world.stats.spawned, 0)
        world.hideInFullScreen = false
        XCTAssertFalse(world.suppressed)
    }

    func testSnowFallsWhenAWindowCloses() {
        let world = World(width: 1000, height: 700, topInset: 24)
        world.depthMode = .behindAll
        world.configure(scene: .blizzard, intensity: 2, wind: 0)
        world.setWindows([window])
        run(world, seconds: 30)
        world.configure(scene: nil, intensity: 1, wind: 0)
        let before = world.stats.spawned
        world.setWindows([], elapsed: 0.1)
        world.step(dt: 1 / 30)
        XCTAssertGreaterThan(world.stats.spawned, before)
        XCTAssertNil(world.pile(for: 7))
    }

    func testSnowMeltsAfterItStops() {
        let world = World(width: 1000, height: 700, topInset: 24)
        world.depthMode = .behindAll
        world.configure(scene: .blizzard, intensity: 2, wind: 0)
        world.setWindows([window])
        run(world, seconds: 30)
        let before = world.pile(for: 7)?.total ?? 0
        world.configure(scene: .rain, intensity: 1, wind: 0)
        run(world, seconds: 30)
        XCTAssertLessThan(world.pile(for: 7)?.total ?? 0, before * 0.5)
    }

    func testEverySceneRunsAndStaysWithinBounds() {
        for scene in SceneKind.allCases {
            let world = World(width: 1200, height: 800, topInset: 24, seed: 11)
            world.configure(scene: scene, intensity: 2, wind: scene.defaultWind)
            world.setWindows([window])
            world.setCursor(x: 400, y: 400, dt: 1 / 30)
            for step in 0..<900 {
                world.setCursor(x: 400 + Float(step % 60) * 8, y: 505, dt: 1 / 30)
                world.step(dt: 1 / 30)
                XCTAssertTrue(world.flash >= 0 && world.flash <= 1)
            }
            XCTAssertGreaterThan(world.stats.spawned, 0, scene.rawValue)
            XCTAssertLessThanOrEqual(world.particles.count, World.maxParticles, scene.rawValue)
            for particle in world.particles {
                XCTAssertFalse(particle.x.isNaN || particle.y.isNaN, scene.rawValue)
                XCTAssertTrue(particle.drawAlpha >= 0 && particle.drawAlpha <= 1.001, scene.rawValue)
            }
        }
    }

    func testStormFlashesAndClearSceneGoesQuiet() {
        let world = World(width: 1000, height: 700, topInset: 24)
        world.configure(scene: .storm, intensity: 1, wind: 100)
        var brightest: Float = 0
        for _ in 0..<1800 {
            world.step(dt: 1 / 30)
            brightest = max(brightest, world.flash)
        }
        XCTAssertGreaterThan(brightest, 0.5)
        world.configure(scene: nil, intensity: 1, wind: 0)
        run(world, seconds: 20)
        XCTAssertTrue(world.isQuiet)
    }
}
