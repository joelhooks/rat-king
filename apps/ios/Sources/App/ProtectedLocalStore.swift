import Foundation

struct ProtectedLocalStore {
    let directory: URL
    init(directory: URL) throws {
        self.directory = directory
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.complete])
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        var url = directory; try url.setResourceValues(values)
    }
    func write(_ name: String, bytes: Data) throws { try bytes.write(to: directory.appendingPathComponent(name), options: [.atomic, .completeFileProtection]) }
    func read(_ name: String) throws -> Data? {
        let url = directory.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }; return try Data(contentsOf: url)
    }
}
