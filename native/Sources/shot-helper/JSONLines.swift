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

struct Job {
    let id: String
    let path: String
}

/// Reads `{"id": ..., "path": ...}` lines from stdin until EOF.
func readJobs() -> [Job] {
    var jobs: [Job] = []
    while let line = readLine(strippingNewline: true) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { continue }
        guard
            let object = try? JSONSerialization.jsonObject(with: Data(trimmed.utf8)) as? [String: Any],
            let id = object["id"] as? String,
            let path = object["path"] as? String
        else {
            JSONLines.shared.write(["ok": false, "error": "malformed job line: \(trimmed.prefix(200))"])
            continue
        }
        jobs.append(Job(id: id, path: path))
    }
    return jobs
}
