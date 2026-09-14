import Foundation

/// Tiny logger: stdout + optional file (the tray app runs detached via `open`, so the
/// file is the only place its output goes).
public enum RLog {
    public static var fileHandle: FileHandle?
    private static let fmt: DateFormatter = { let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"; return f }()
    private static let lock = NSLock()

    public static func openFile(_ path: String) {
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: url.path) { FileManager.default.createFile(atPath: url.path, contents: nil) }
        fileHandle = try? FileHandle(forWritingTo: url)
        fileHandle?.seekToEndOfFile()
    }
}

public func rlog(_ s: String) {
    let line = "[\(RLog.fmtString())] \(s)\n"
    FileHandle.standardOutput.write(line.data(using: .utf8)!)
    RLog.fileHandle?.write(line.data(using: .utf8)!)
}

extension RLog {
    static func fmtString() -> String { lock.lock(); defer { lock.unlock() }; return fmt.string(from: Date()) }
}
