import Foundation

/// Serializes JSON objects to stdout, one per line, safe to call from any thread.
final class JSONLines {
    static let shared = JSONLines()
    private let lock = NSLock()

    func write(_ object: [String: Any]) {
        let data: Data
        do {
            data = try JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
        } catch {
            data = Data(#"{"ok":false,"error":"unserializable result"}"#.utf8)
        }
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }
}

/// An image file to process.
struct Job {
    let id: String
    let path: String
}

/// A Photos library asset to process, by its PhotoKit local identifier.
struct AssetJob {
    let id: String
    let asset: String
}

/// Reads `{"id": ..., "path": ...}` lines from stdin until EOF.
func readJobs() -> [Job] {
    readJobLines(field: "path").map { Job(id: $0.id, path: $0.value) }
}

/// Reads `{"id": ..., "asset": ...}` lines from stdin until EOF.
func readAssetJobs() -> [AssetJob] {
    readJobLines(field: "asset").map { AssetJob(id: $0.id, asset: $0.value) }
}

/// Reads job lines carrying an `id` and the given string field, reporting malformed ones.
private func readJobLines(field: String) -> [(id: String, value: String)] {
    var jobs: [(id: String, value: String)] = []
    while let line = readLine(strippingNewline: true) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { continue }
        guard
            let object = try? JSONSerialization.jsonObject(with: Data(trimmed.utf8)) as? [String: Any],
            let id = object["id"] as? String,
            let value = object[field] as? String
        else {
            JSONLines.shared.write(["ok": false, "error": "malformed job line: \(trimmed.prefix(200))"])
            continue
        }
        jobs.append((id, value))
    }
    return jobs
}
