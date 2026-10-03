// Renders the synthetic screenshots used by the test suite.
//   swift scripts/make-fixtures.swift mcp/test/fixtures/library
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct Fixture {
    let name: String
    let width: Int
    let height: Int
    let background: (CGFloat, CGFloat, CGFloat, CGFloat)
    let ink: (CGFloat, CGFloat, CGFloat)
    let lines: [(String, CGFloat)] // text, point size
    var exif: [CFString: Any]? = nil
}

let fixtures: [Fixture] = [
    Fixture(name: "Screenshot 2025-08-03 at 4.15.22 PM.png", width: 600, height: 900,
            background: (0.98, 0.86, 0.55, 1), ink: (0.25, 0.12, 0.05),
            lines: [("KETTLE COOKED", 44), ("Sea Salt Tortilla Chips", 34),
                    ("100% Organic Blue Corn", 28), ("Net Wt 10 oz (283g)", 24)]),
    Fixture(name: "code/IMG_2041.PNG", width: 900, height: 500,
            background: (0.12, 0.13, 0.16, 1), ink: (0.85, 0.9, 0.95),
            lines: [("func fetchScreenshots() async throws", 26),
                    ("let assets = PHAsset.fetchAssets(with: options)", 22),
                    ("return assets.map(Screenshot.init)", 22)]),
    Fixture(name: "receipt.jpg", width: 500, height: 700,
            background: (1, 1, 1, 1), ink: (0.1, 0.1, 0.1),
            lines: [("ORDER CONFIRMED", 34), ("Order #4417-2291", 26),
                    ("Ceramic Pour Over Set", 24), ("Total $43.18", 30)],
            exif: [kCGImagePropertyExifDictionary: [
                kCGImagePropertyExifDateTimeOriginal: "2025:02:14 09:30:00",
                kCGImagePropertyExifOffsetTimeOriginal: "-08:00",
                kCGImagePropertyExifUserComment: "Screenshot",
            ], kCGImagePropertyTIFFDictionary: [
                kCGImagePropertyTIFFModel: "iPhone 15 Pro",
            ]]),
    Fixture(name: "window-shadow.png", width: 640, height: 400,
            background: (0, 0, 0, 0), ink: (0.05, 0.3, 0.6),
            lines: [("Pickleball Rebound Surface", 32), ("Panel spec v2", 26)]),
    Fixture(name: "nothing-here.png", width: 400, height: 400,
            background: (0.55, 0.75, 0.6, 1), ink: (0, 0, 0), lines: []),
]

let outDir = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "mcp/test/fixtures/library")

for fixture in fixtures {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: fixture.width, height: fixture.height, bitsPerComponent: 8,
                        bytesPerRow: 0, space: space,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let bg = fixture.background
    ctx.setFillColor(CGColor(red: bg.0, green: bg.1, blue: bg.2, alpha: bg.3))
    ctx.fill(CGRect(x: 0, y: 0, width: fixture.width, height: fixture.height))

    var y = CGFloat(fixture.height) - 80
    for (text, size) in fixture.lines {
        let font = CTFontCreateWithName("Helvetica-Bold" as CFString, size, nil)
        let color = CGColor(red: fixture.ink.0, green: fixture.ink.1, blue: fixture.ink.2, alpha: 1)
        let attributed = NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
        ])
        let line = CTLineCreateWithAttributedString(attributed)
        ctx.textPosition = CGPoint(x: 40, y: y)
        CTLineDraw(line, ctx)
        y -= size * 2.2
    }

    let url = outDir.appendingPathComponent(fixture.name)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let type = fixture.name.lowercased().hasSuffix(".jpg") ? UTType.jpeg : UTType.png
    let dest = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil)!
    var props: [CFString: Any] = fixture.exif ?? [:]
    if type == .jpeg { props[kCGImageDestinationLossyCompressionQuality] = 0.9 }
    CGImageDestinationAddImage(dest, ctx.makeImage()!, props as CFDictionary)
    precondition(CGImageDestinationFinalize(dest), "failed to write \(fixture.name)")
    print("wrote \(url.path)")
}
