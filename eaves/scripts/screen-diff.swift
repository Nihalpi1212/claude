// Compares two screenshots (before the app, while it runs) and prints what changed as text, so a
// CI log shows whether Eaves really drew on the screen and where.
//
//   swift scripts/screen-diff.swift before.png during.png
//
// Exits 1 if nothing changed (nothing was drawn) or if most of the screen changed (the overlay is
// not transparent).
import CoreGraphics
import Foundation
import ImageIO

struct Shot {
    let width: Int
    let height: Int
    let pixels: [UInt8]

    /// Brightness 0 ... 765 of the pixel at x, y (y counted from the top).
    func sum(_ x: Int, _ y: Int) -> Int {
        let i = (y * width + x) * 4
        return Int(pixels[i]) + Int(pixels[i + 1]) + Int(pixels[i + 2])
    }

    func differs(from other: Shot, _ x: Int, _ y: Int) -> Bool {
        let i = (y * width + x) * 4
        for c in 0..<3 where abs(Int(pixels[i + c]) - Int(other.pixels[i + c])) > 16 { return true }
        return false
    }
}

func load(_ path: String) -> Shot? {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
    let width = image.width
    let height = image.height
    var pixels = [UInt8](repeating: 0, count: width * height * 4)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
        guard let context = CGContext(data: buffer.baseAddress, width: width, height: height,
                                      bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return true
    }
    return drawn ? Shot(width: width, height: height, pixels: pixels) : nil
}

let arguments = CommandLine.arguments
guard arguments.count == 3, let before = load(arguments[1]), let during = load(arguments[2]) else {
    print("usage: screen-diff.swift before.png during.png (both must be readable images)")
    exit(2)
}
guard before.width == during.width, before.height == during.height else {
    print("screen-diff: the screenshots differ in size")
    exit(2)
}
let width = before.width
let height = before.height

// Which pixels changed, and whether they got brighter.
var changed = [UInt8](repeating: 0, count: width * height)
var rowCounts = [Int](repeating: 0, count: height)
var total = 0
var brighter = 0
for y in 0..<height {
    for x in 0..<width where during.differs(from: before, x, y) {
        let up = during.sum(x, y) > before.sum(x, y)
        changed[y * width + x] = up ? 2 : 1
        rowCounts[y] += 1
        total += 1
        if up { brighter += 1 }
    }
}
let share = Double(total) / Double(width * height)
print("screen-diff: \(width) x \(height) px, changed \(total) px (\(String(format: "%.3f", share * 100))%), "
    + "\(brighter) of them brighter")

/// One character per block of pixels: '#', 'o', '+' where pixels got brighter (most, some, a few),
/// '-' where they got darker, otherwise '.' on a light background and ' ' on a dark one.
func draw(title: String, x0: Int, y0: Int, columns: Int, rows: Int, cellWidth: Int, cellHeight: Int) {
    print("--- \(title): from (\(x0), \(y0)), one character = \(cellWidth) x \(cellHeight) px ---")
    for row in 0..<rows {
        var line = ""
        for column in 0..<columns {
            var up = 0
            var down = 0
            var light = 0
            var count = 0
            for dy in 0..<cellHeight {
                for dx in 0..<cellWidth {
                    let x = x0 + column * cellWidth + dx
                    let y = y0 + row * cellHeight + dy
                    guard x >= 0, x < width, y >= 0, y < height else { continue }
                    count += 1
                    switch changed[y * width + x] {
                    case 2: up += 1
                    case 1: down += 1
                    default: break
                    }
                    if before.sum(x, y) > 420 { light += 1 }
                }
            }
            guard count > 0 else {
                line.append(" ")
                continue
            }
            let upShare = Double(up) / Double(count)
            if upShare >= 0.6 {
                line.append("#")
            } else if upShare >= 0.25 {
                line.append("o")
            } else if up > 0 {
                line.append("+")
            } else if Double(down) / Double(count) > 0.25 {
                line.append("-")
            } else {
                line.append(light * 2 > count ? "." : " ")
            }
        }
        print(line)
    }
}

draw(title: "whole screen", x0: 0, y0: 0, columns: 100, rows: 36,
     cellWidth: max(1, width / 100), cellHeight: max(1, height / 36))

// The busiest row away from the top and bottom edges is most likely snow lying on a window.
var busiest = height / 2
var most = -1
if height > 200 {
    for y in 40..<(height - 80) where rowCounts[y] > most {
        most = rowCounts[y]
        busiest = y
    }
}
var xs: [Int] = []
for x in 0..<width where changed[busiest * width + x] != 0 { xs.append(x) }
let middle = xs.isEmpty ? width / 2 : xs[xs.count / 2]
draw(title: "close-up around the busiest row (y = \(busiest), \(most) px changed)",
     x0: max(0, min(width - 220, middle - 110)), y0: max(0, busiest - 80), columns: 110, rows: 30,
     cellWidth: 2, cellHeight: 4)
draw(title: "close-up of the bottom left corner", x0: 0, y0: height - 64, columns: 110, rows: 16,
     cellWidth: 2, cellHeight: 4)

if share < 0.0003 {
    print("screen-diff: FAIL, nothing was drawn on the screen")
    exit(1)
}
if share > 0.4 {
    print("screen-diff: FAIL, most of the screen changed, so the overlay is not transparent")
    exit(1)
}
print("screen-diff: PASS")
