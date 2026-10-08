// The Photos bridge: reads screenshots from the user's Photos library.
//
// macOS grants Photos access to an app, not to a command, so these commands
// must run as "Memvana Shot.app" started by LaunchServices (`open`). Started
// as the child of a terminal or editor, the request would be attributed to
// that app instead. The MCP server therefore launches them like this:
//
//   open -W -n -g -a "Memvana Shot.app" --stdin jobs.jsonl --stdout out.jsonl --args photos <command> ...
//
//   photos status       {"done": true, "authorization": "authorized"}
//   photos authorize    asks macOS for access if it hasn't been asked yet, then reports the status
//   photos list         one line per screenshot asset, then {"done": true, "count": N}
//   photos extract --thumb-dir DIR [--max-dim N] [--concurrency N]
//       stdin:  {"id": "...", "asset": "<local identifier>"} per job
//       stdout: the same result lines as `extract`, plus asset, filename and created
//   photos export --dir DIR
//       stdin:  the same job lines
//       stdout: {"id": "...", "ok": true, "path": "/DIR/<id>/IMG_1234.PNG"} per job
//
// Every command ends with a {"done": true, ...} line. `open` can't report the
// app's exit status, so a missing done line is how the caller detects a crash.
// Without access, list/extract/export print only
// {"done": true, "error": "not_authorized", "authorization": "denied"}.
//
// Read-only: nothing here changes or deletes anything in the library.

import Foundation
import Photos
import UniformTypeIdentifiers

func runPhotos(_ arguments: [String]) {
    var args = arguments
    guard !args.isEmpty else { fail("usage: shot-helper photos <status|authorize|list|extract|export> [options]") }
    let command = args.removeFirst()
    // Debugging aid: run in place, accepting that access is attributed to the parent app.
    if let i = args.firstIndex(of: "--allow-direct") {
        args.remove(at: i)
    } else if getppid() != 1 {
        fail("photos commands must be started with `open` so macOS attributes Photos access to Memvana Shot")
    }

    switch command {
    case "status":
        JSONLines.shared.write(["done": true, "authorization": authorizationName(currentAuthorization())])

    case "authorize":
        var status = currentAuthorization()
        if status == .notDetermined {
            let done = DispatchSemaphore(value: 0)
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { granted in
                status = granted
                done.signal()
            }
            done.wait()
        }
        JSONLines.shared.write(["done": true, "authorization": authorizationName(status)])

    case "list":
        requireAccess()
        let assets = screenshotAssets()
        assets.enumerateObjects { asset, _, _ in
            JSONLines.shared.write(listing(asset))
        }
        JSONLines.shared.write(["done": true, "count": assets.count])

    case "extract":
        requireAccess()
        let options = parseExtractOptions(args)
        let jobs = readAssetJobs()
        let assets = fetchAssets(jobs.map(\.asset))
        process(jobs, concurrency: options.concurrency, fields: { ["id": $0.id, "asset": $0.asset] }) { job in
            guard let asset = assets[job.asset] else { throw missingAsset }
            let image = try imageData(for: asset)
            var result = try extract(data: image.data, id: job.id, options: options)
            result["filename"] = image.filename ?? NSNull()
            result["created"] = asset.creationDate.map(isoDate) ?? NSNull()
            return result
        }
        JSONLines.shared.write(["done": true])

    case "export":
        requireAccess()
        guard let i = args.firstIndex(of: "--dir"), i + 1 < args.count else { fail("--dir is required") }
        let dir = URL(fileURLWithPath: args[i + 1], isDirectory: true)
        let jobs = readAssetJobs()
        let assets = fetchAssets(jobs.map(\.asset))
        process(jobs, concurrency: 2, fields: { ["id": $0.id, "asset": $0.asset] }) { job in
            guard let asset = assets[job.asset] else { throw missingAsset }
            let image = try imageData(for: asset)
            let folder = dir.appendingPathComponent(job.id, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let url = folder.appendingPathComponent(exportName(image))
            try image.data.write(to: url, options: .atomic)
            return ["path": url.path]
        }
        JSONLines.shared.write(["done": true])

    default:
        fail("unknown photos command \(command)")
    }
}

private let missingAsset = ExtractError(
    description: "not in the Photos library any more (deleted or hidden), or Photos access was removed"
)

func currentAuthorization() -> PHAuthorizationStatus {
    PHPhotoLibrary.authorizationStatus(for: .readWrite)
}

func authorizationName(_ status: PHAuthorizationStatus) -> String {
    switch status {
    case .notDetermined: return "not_determined"
    case .restricted: return "restricted"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .limited: return "limited"
    @unknown default: return "unknown"
    }
}

/// Stops with a single status line unless the app may read the library.
private func requireAccess() {
    let status = currentAuthorization()
    guard status == .authorized || status == .limited else {
        JSONLines.shared.write(["done": true, "error": "not_authorized", "authorization": authorizationName(status)])
        exit(3)
    }
}

/// The Screenshots smart album, newest first. Hidden and recently deleted
/// assets are left out, as they are in Photos itself.
func screenshotAssets() -> PHFetchResult<PHAsset> {
    let options = PHFetchOptions()
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    options.predicate = NSPredicate(format: "mediaType == %d", PHAssetMediaType.image.rawValue)
    let albums = PHAssetCollection.fetchAssetCollections(with: .smartAlbum, subtype: .smartAlbumScreenshots, options: nil)
    if let album = albums.firstObject {
        return PHAsset.fetchAssets(in: album, options: options)
    }
    options.predicate = NSPredicate(
        format: "mediaType == %d AND (mediaSubtypes & %d) != 0",
        PHAssetMediaType.image.rawValue, PHAssetMediaSubtype.photoScreenshot.rawValue
    )
    return PHAsset.fetchAssets(with: options)
}

private func listing(_ asset: PHAsset) -> [String: Any] {
    [
        "asset": asset.localIdentifier,
        "created": asset.creationDate.map(isoDate) ?? NSNull(),
        "modified": asset.modificationDate.map(isoDate) ?? NSNull(),
        "width": asset.pixelWidth,
        "height": asset.pixelHeight,
        "edited": asset.hasAdjustments,
        "favorite": asset.isFavorite,
    ]
}

private func fetchAssets(_ identifiers: [String]) -> [String: PHAsset] {
    var byId: [String: PHAsset] = [:]
    PHAsset.fetchAssets(withLocalIdentifiers: identifiers, options: nil).enumerateObjects { asset, _, _ in
        byId[asset.localIdentifier] = asset
    }
    return byId
}

struct AssetImage {
    let data: Data
    let uti: String?
    let filename: String?
}

/// The asset's current version (with any edits), downloading it from iCloud if
/// only an optimized copy is on this Mac. Call from a background thread.
func imageData(for asset: PHAsset) throws -> AssetImage {
    let options = PHImageRequestOptions()
    options.version = .current
    options.deliveryMode = .highQualityFormat
    options.isNetworkAccessAllowed = true
    options.isSynchronous = true
    var data: Data?
    var uti: String?
    var info: [AnyHashable: Any]?
    PHImageManager.default().requestImageDataAndOrientation(for: asset, options: options) { d, u, _, i in
        data = d
        uti = u
        info = i
    }
    if let error = info?[PHImageErrorKey] as? Error {
        throw ExtractError(description: "Photos could not provide the image: \(error.localizedDescription)")
    }
    guard let data else {
        let inCloud = (info?[PHImageResultIsInCloudKey] as? Bool) == true
        throw ExtractError(description: inCloud ? "the image is in iCloud and could not be downloaded" : "Photos returned no image data")
    }
    let original = PHAssetResource.assetResources(for: asset).first { $0.type == .photo }
    return AssetImage(data: data, uti: uti, filename: original?.originalFilename)
}

/// The original file name, with the extension of the bytes actually exported
/// (an edited PNG comes back as a JPEG or HEIC rendering).
private func exportName(_ image: AssetImage) -> String {
    let stem = image.filename.map { ($0 as NSString).deletingPathExtension } ?? "screenshot"
    let ext = image.uti.flatMap { UTType($0)?.preferredFilenameExtension }
        ?? image.filename.map { ($0 as NSString).pathExtension }
        ?? "png"
    return "\(stem).\(ext)"
}

private let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func isoDate(_ date: Date) -> String {
    isoFormatter.string(from: date)
}
