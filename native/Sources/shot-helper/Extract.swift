import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

struct ExtractOptions {
    var thumbDir: URL?
    var maxDim = 1024
    var concurrency = min(4, ProcessInfo.processInfo.activeProcessorCount)
    var ocr = true
    var labels = true
    var featurePrint = true
}

struct ExtractError: Error, CustomStringConvertible {
    let description: String
}

func runExtract(jobs: [Job], options: ExtractOptions) {
    process(jobs, concurrency: options.concurrency, fields: { ["id": $0.id, "path": $0.path] }) { job in
        let data = try Data(contentsOf: URL(fileURLWithPath: job.path), options: .mappedIfSafe)
        return try extract(data: data, id: job.id, options: options)
    }
}

/// Runs `work` on each job with bounded concurrency and writes one JSON line per
/// job as it finishes: the work's result plus `fields`, or the error.
func process<J>(
    _ jobs: [J],
    concurrency: Int,
    fields: @escaping (J) -> [String: Any],
    work: @escaping (J) throws -> [String: Any]
) {
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = concurrency
    for job in jobs {
        queue.addOperation {
            autoreleasepool {
                let started = Date()
                var result: [String: Any]
                do {
                    result = try work(job)
                    result["ok"] = true
                } catch {
                    result = ["ok": false, "error": String(describing: error)]
                }
                result.merge(fields(job)) { _, new in new }
                result["elapsedMs"] = Int(Date().timeIntervalSince(started) * 1000)
                JSONLines.shared.write(result)
            }
        }
    }
    queue.waitUntilAllOperationsAreFinished()
}

/// Turns image bytes (from a file or the Photos library) into facts.
func extract(data: Data, id: String, options: ExtractOptions) throws -> [String: Any] {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil),
          CGImageSourceGetCount(source) > 0
    else { throw ExtractError(description: "not a readable image") }

    let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] ?? [:]
    let orientationRaw = (props[kCGImagePropertyOrientation] as? UInt32) ?? 1
    let orientation = CGImagePropertyOrientation(rawValue: orientationRaw) ?? .up
    let pixelWidth = props[kCGImagePropertyPixelWidth] as? Int ?? 0
    let pixelHeight = props[kCGImagePropertyPixelHeight] as? Int ?? 0
    let rotated = [.left, .leftMirrored, .right, .rightMirrored].contains(orientation)

    var result: [String: Any] = [
        "sha256": SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
        "byteSize": data.count,
        "width": rotated ? pixelHeight : pixelWidth,
        "height": rotated ? pixelWidth : pixelHeight,
        "uti": (CGImageSourceGetType(source) as String?) ?? NSNull(),
        "metadata": metadata(from: props, source: source),
    ]

    guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw ExtractError(description: "could not decode image")
    }

    if let thumbDir = options.thumbDir {
        result["thumb"] = try writeThumbnail(source: source, id: id, dir: thumbDir, maxDim: options.maxDim)
    }

    var requests: [VNRequest] = []
    let textRequest = VNRecognizeTextRequest()
    textRequest.recognitionLevel = .accurate
    textRequest.usesLanguageCorrection = true
    textRequest.automaticallyDetectsLanguage = true
    if options.ocr { requests.append(textRequest) }

    let classifyRequest = VNClassifyImageRequest()
    if options.labels { requests.append(classifyRequest) }

    let printRequest = VNGenerateImageFeaturePrintRequest()
    if options.featurePrint { requests.append(printRequest) }

    if !requests.isEmpty {
        let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
        try handler.perform(requests)
    }

    if options.ocr {
        result["ocr"] = ocrResult(textRequest.results ?? [])
    }
    if options.labels {
        result["labels"] = (classifyRequest.results ?? [])
            .filter { $0.confidence >= 0.25 }
            .sorted { $0.confidence > $1.confidence }
            .prefix(12)
            .map { ["label": $0.identifier, "confidence": round3($0.confidence)] }
    }
    if options.featurePrint, let print = printRequest.results?.first {
        result["featurePrint"] = [
            "revision": printRequest.revision,
            "elementType": print.elementType == .float ? "float32" : "float64",
            "elementCount": print.elementCount,
            "base64": print.data.base64EncodedString(),
        ]
    }
    return result
}

/// Pulls out the handful of metadata fields that help date and attribute a screenshot.
func metadata(from props: [CFString: Any], source: CGImageSource) -> [String: Any] {
    var out: [String: Any] = [:]
    if let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any] {
        out["exifDateTimeOriginal"] = exif[kCGImagePropertyExifDateTimeOriginal]
        out["exifOffsetTimeOriginal"] = exif[kCGImagePropertyExifOffsetTimeOriginal]
        out["exifUserComment"] = exif[kCGImagePropertyExifUserComment]
    }
    if let tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] {
        out["tiffDateTime"] = tiff[kCGImagePropertyTIFFDateTime]
        out["tiffMake"] = tiff[kCGImagePropertyTIFFMake]
        out["tiffModel"] = tiff[kCGImagePropertyTIFFModel]
        out["tiffSoftware"] = tiff[kCGImagePropertyTIFFSoftware]
    }
    if let png = props[kCGImagePropertyPNGDictionary] as? [CFString: Any] {
        out["pngCreationTime"] = png[kCGImagePropertyPNGCreationTime]
        out["pngSoftware"] = png[kCGImagePropertyPNGSoftware]
    }
    // macOS screenshots carry their capture date and "Screenshot" marker in XMP.
    if let xmp = CGImageSourceCopyMetadataAtIndex(source, 0, nil) {
        for (key, path) in [
            ("xmpDateCreated", "photoshop:DateCreated"),
            ("xmpCreateDate", "xmp:CreateDate"),
            ("xmpUserComment", "exif:UserComment"),
        ] {
            if let tag = CGImageMetadataCopyTagWithPath(xmp, nil, path as CFString),
               let value = CGImageMetadataTagCopyValue(tag) {
                out[key] = xmpString(value)
            }
        }
    }
    return out.compactMapValues { value in
        if let s = value as? String { return s.isEmpty ? nil : s }
        return value
    }
}

private func xmpString(_ value: CFTypeRef) -> Any? {
    if let s = value as? String { return s }
    // exif:UserComment is a language-alternative array of tags.
    if let array = value as? [CGImageMetadataTag], let first = array.first,
       let inner = CGImageMetadataTagCopyValue(first) as? String {
        return inner
    }
    return nil
}

/// Writes an upright JPEG thumbnail flattened onto white (screenshots with alpha
/// shadows would otherwise turn black).
func writeThumbnail(source: CGImageSource, id: String, dir: URL, maxDim: Int) throws -> [String: Any] {
    let thumbOptions: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: maxDim,
    ]
    guard let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbOptions as CFDictionary) else {
        throw ExtractError(description: "could not create thumbnail")
    }
    let width = thumb.width, height = thumb.height
    guard let context = CGContext(
        data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
    ) else { throw ExtractError(description: "could not create thumbnail context") }
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    context.draw(thumb, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let flattened = context.makeImage() else {
        throw ExtractError(description: "could not flatten thumbnail")
    }

    let url = dir.appendingPathComponent("\(id).jpg")
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
        throw ExtractError(description: "could not open thumbnail destination")
    }
    CGImageDestinationAddImage(dest, flattened, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else {
        throw ExtractError(description: "could not write thumbnail")
    }
    return ["path": url.path, "width": width, "height": height]
}

/// Orders recognized text top-to-bottom, left-to-right, grouping observations
/// that share a baseline into one line.
func ocrResult(_ observations: [VNRecognizedTextObservation]) -> [String: Any] {
    struct Piece { let text: String; let confidence: Float; let box: CGRect }
    let pieces: [Piece] = observations.compactMap { obs in
        guard let candidate = obs.topCandidates(1).first else { return nil }
        return Piece(text: candidate.string, confidence: candidate.confidence, box: obs.boundingBox)
    }
    // Vision's origin is bottom-left, so higher midY means nearer the top.
    let sorted = pieces.sorted { $0.box.midY > $1.box.midY }
    var lines: [[Piece]] = []
    for piece in sorted {
        if let last = lines.last?.last,
           abs(last.box.midY - piece.box.midY) < min(last.box.height, piece.box.height) * 0.5 {
            lines[lines.count - 1].append(piece)
        } else {
            lines.append([piece])
        }
    }
    let text = lines
        .map { $0.sorted { $0.box.minX < $1.box.minX }.map(\.text).joined(separator: " ") }
        .joined(separator: "\n")
    let confidence = pieces.isEmpty ? 0 : pieces.map(\.confidence).reduce(0, +) / Float(pieces.count)
    return [
        "text": text,
        "confidence": round3(confidence),
        "observationCount": pieces.count,
    ]
}

func round3(_ value: Float) -> Double {
    (Double(value) * 1000).rounded() / 1000
}
