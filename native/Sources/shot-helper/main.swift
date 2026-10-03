// shot-helper — Memvana Shot's native macOS helper.
//
// Deliberately boring: it turns image files into facts (hash, dimensions,
// metadata, OCR text, Vision labels, a thumbnail, a visual feature print) and
// prints them as JSON lines. All interpretation happens elsewhere.
//
//   shot-helper version
//   shot-helper extract --thumb-dir DIR [--max-dim 1024] [--concurrency 4]
//       stdin:  {"id": "...", "path": "/abs/file.png"}   one job per line
//       stdout: one JSON result per job, in completion order

import Foundation
import Vision

let helperVersion = "0.1.0"

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("shot-helper: \(message)\n".utf8))
    exit(2)
}

func versionInfo() -> [String: Any] {
    [
        "name": "shot-helper",
        "version": helperVersion,
        "ocrRevision": VNRecognizeTextRequest.currentRevision,
        "classifyRevision": VNClassifyImageRequest.currentRevision,
        "featurePrintRevision": VNGenerateImageFeaturePrintRequest.currentRevision,
        "os": ProcessInfo.processInfo.operatingSystemVersionString,
    ]
}

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else {
    fail("usage: shot-helper <version|extract> [options]")
}
args.removeFirst()

switch command {
case "version":
    JSONLines.shared.write(versionInfo())

case "extract":
    var options = ExtractOptions()
    var i = 0
    func value() -> String {
        i += 1
        guard i < args.count else { fail("missing value for \(args[i - 1])") }
        return args[i]
    }
    while i < args.count {
        switch args[i] {
        case "--thumb-dir": options.thumbDir = URL(fileURLWithPath: value(), isDirectory: true)
        case "--max-dim": options.maxDim = Int(value()) ?? options.maxDim
        case "--concurrency": options.concurrency = max(1, Int(value()) ?? options.concurrency)
        case "--no-ocr": options.ocr = false
        case "--no-labels": options.labels = false
        case "--no-feature-print": options.featurePrint = false
        default: fail("unknown option \(args[i])")
        }
        i += 1
    }
    guard let thumbDir = options.thumbDir else { fail("--thumb-dir is required") }
    do {
        try FileManager.default.createDirectory(at: thumbDir, withIntermediateDirectories: true)
    } catch {
        fail("cannot create thumb dir: \(error.localizedDescription)")
    }
    runExtract(jobs: readJobs(), options: options)

default:
    fail("unknown command \(command)")
}
