// Renders a large synthetic screenshot library for scripts/scale-test.mjs:
//   swift scripts/make-scale-library.swift <folder> [count]
// Images have varied sizes, colors and text, dated names spread over two
// years, some descriptive folders, and a few re-captures (same text) so
// near-duplicate detection has work to do. The same count gives the same images.
import CoreGraphics
import CoreText
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments.dropFirst()
let outDir = URL(fileURLWithPath: args.first ?? "scale-library")
let count = Int(args.dropFirst().first ?? "10000") ?? 10000

let words = """
    order receipt total invoice shipping tracking coffee grinder pour over kettle recipe pasta tomato basil
    garlic sourdough flour oven pickleball paddle court net tournament ranking chair sofa lamp walnut oak
    tile backsplash faucet cabinet kitchen remodel budget quote contractor permit flight hotel boarding gate
    seat itinerary museum ticket concert festival playlist guitar amplifier pedal chord lyrics swift python
    function error stack trace build deploy server database query index cache dashboard chart revenue users
    growth meeting agenda notes calendar reminder password reset verification account balance transfer
    pricing plan upgrade subscription coupon discount sale shoes jacket backpack tent stove trail map
    weather forecast temperature recipe smoothie protein workout running pace marathon cycling route
    article headline quote tweet thread comment design mockup palette font logo poster typography icon
    """.split(whereSeparator: \.isWhitespace).map(String.init)
let folders = ["", "", "", "", "", "Recipes", "Kitchen remodel", "Travel/Japan", "Work", "2024"]

// A small deterministic generator, so runs are comparable.
var state: UInt64 = 0x9E3779B97F4A7C15
func next() -> UInt64 {
    state ^= state << 13; state ^= state >> 7; state ^= state << 17
    return state
}
func pick<T>(_ items: [T]) -> T { items[Int(next() % UInt64(items.count))] }
func unit() -> CGFloat { CGFloat(next() % 1000) / 1000 }

let space = CGColorSpace(name: CGColorSpace.sRGB)!
let start = Date(timeIntervalSince1970: 1_730_000_000) // late October 2024
let formatter = DateFormatter()
formatter.locale = Locale(identifier: "en_US_POSIX")
formatter.dateFormat = "yyyy-MM-dd 'at' h.mm.ss a"

var lastLines: [String] = []
for i in 0..<count {
    let width = pick([640, 800, 1024, 1170])
    let height = pick([400, 600, 900, 2532 / 2])
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let dark = next() % 3 == 0
    ctx.setFillColor(CGColor(red: dark ? unit() * 0.2 : 0.8 + unit() * 0.2, green: dark ? unit() * 0.2 : 0.8 + unit() * 0.2,
                             blue: dark ? unit() * 0.25 : 0.8 + unit() * 0.2, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    ctx.setFillColor(CGColor(red: unit(), green: unit(), blue: unit(), alpha: 1))
    ctx.fill(CGRect(x: 0, y: height - 60, width: width, height: 60)) // a title bar

    // Every 25th image re-captures the previous one's text.
    let lines = i % 25 == 24 && !lastLines.isEmpty
        ? lastLines
        : (0..<(3 + Int(next() % 5))).map { _ in (0..<(2 + Int(next() % 4))).map { _ in pick(words) }.joined(separator: " ") }
    lastLines = lines
    var y = CGFloat(height) - 110
    for (n, text) in lines.enumerated() {
        let size: CGFloat = n == 0 ? 34 : 22
        let font = CTFontCreateWithName("Helvetica" as CFString, size, nil)
        let ink = dark ? CGColor(red: 0.9, green: 0.92, blue: 0.95, alpha: 1) : CGColor(red: 0.1, green: 0.1, blue: 0.12, alpha: 1)
        let attributed = NSAttributedString(string: text, attributes: [
            NSAttributedString.Key(kCTFontAttributeName as String): font,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): ink,
        ])
        ctx.textPosition = CGPoint(x: 32, y: y)
        CTLineDraw(CTLineCreateWithAttributedString(attributed), ctx)
        y -= size * 2
        if y < 20 { break }
    }

    let taken = start.addingTimeInterval(Double(i) * 6300 + Double(next() % 3000))
    let folder = pick(folders)
    let name = "Screenshot \(formatter.string(from: taken)) \(i).png"
    let url = (folder.isEmpty ? outDir : outDir.appendingPathComponent(folder)).appendingPathComponent(name)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    precondition(CGImageDestinationFinalize(dest), "failed to write \(name)")
    if (i + 1) % 1000 == 0 { print("\(i + 1) images") }
}
