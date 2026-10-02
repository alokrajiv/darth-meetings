import XCTest
@testable import TrayLogic

final class DiskUsageTests: XCTestCase {
    let dir = "/Users/me/Movies/Darth Recorder"

    func p(_ rel: String) -> String { dir + "/" + rel }

    /// A fake disk: path → size.
    func compute(_ rows: [DiskRow], disk: [String: Int], walked: Bool = true) -> DiskUsage {
        let folder = walked ? disk.filter { $0.key.hasPrefix(dir + "/") }.map { DiskFile(path: $0.key, bytes: $0.value) } : nil
        return DiskUsage.compute(rows: rows, dir: dir, size: { disk[$0] }, folder: folder)
    }

    func testEmpty() {
        let u = compute([], disk: [:])
        XCTAssertEqual(u.totalBytes, 0)
        XCTAssertEqual(u.orphanBytes, 0)
        XCTAssertEqual(u.orphanFiles, 0)
        XCTAssertEqual(u.menuLine, "On this Mac: no recordings")
    }

    func testBucketsByStatus() {
        let rows = [
            DiskRow(id: "a", status: "local", upload: nil, files: [p("a/x part1.mp4"), p("a/x part2.mp4")]),
            DiskRow(id: "b", status: "uploading", upload: nil, files: [p("b/y part1.mp4")]),
            DiskRow(id: "c", status: "upload_failed", upload: nil, files: [p("c/z part1.mp4")]),
            DiskRow(id: "d", status: "uploaded", upload: nil, files: [p("d/w part1.mp4")]),
            DiskRow(id: "e", status: "local", upload: false, files: [p("e/v part1.mp4")]),
        ]
        let disk = [p("a/x part1.mp4"): 100, p("a/x part2.mp4"): 50, p("b/y part1.mp4"): 20,
                    p("c/z part1.mp4"): 7, p("d/w part1.mp4"): 1000, p("e/v part1.mp4"): 3]
        let u = compute(rows, disk: disk)
        XCTAssertEqual(u.pendingUploadBytes, 180)          // a + b + c + e (kept is pending too)
        XCTAssertEqual(u.pendingUploadRecordings, 4)
        XCTAssertEqual(u.keptBytes, 3)
        XCTAssertEqual(u.uploadedBytes, 1000)
        XCTAssertEqual(u.orphanBytes, 0)
        XCTAssertEqual(u.totalBytes, 1180)
        XCTAssertEqual(u.files, 6)
        XCTAssertEqual(u.recordings, 5)
    }

    /// Capture-failed rows (no files) and failed rows whose files are gone count nowhere —
    /// the same rule as `Registry.pendingUpload`.
    func testMissingFilesCountNowhere() {
        let rows = [
            DiskRow(id: "f", status: "upload_failed", upload: nil, files: []),
            DiskRow(id: "g", status: "upload_failed", upload: nil, files: [p("g/gone.mp4")]),
            DiskRow(id: "h", status: "uploaded", upload: nil, files: [p("h/purged.mp4")]),
        ]
        let u = compute(rows, disk: [:])
        XCTAssertEqual(u.totalBytes, 0)
        XCTAssertEqual(u.recordings, 0)
        XCTAssertEqual(u.pendingUploadRecordings, 0)
    }

    /// A row without a status is `local` to the uploader, so it is pending here too.
    func testMissingStatusIsLocal() {
        let u = compute([DiskRow(id: "a", status: nil, upload: nil, files: [p("a/1.mp4")])], disk: [p("a/1.mp4"): 9])
        XCTAssertEqual(u.pendingUploadBytes, 9)
    }

    /// The owner's Mac, 2026-10-02: pre-registry loose files, a folder no row knows, a deleted
    /// row whose file survived — all orphans; grouped per top-level entry.
    func testOrphans() {
        let rows = [
            DiskRow(id: "a", status: "local", upload: nil, files: [p("a/x part1.mp4")]),
            DiskRow(id: "dead", status: "deleted", upload: nil, files: []),
        ]
        let disk = [p("a/x part1.mp4"): 5,
                    p("2026-09-15 10.00.00 teams.mp4"): 300,
                    p("2026-09-15 11.00.00 meet.mp4"): 200,
                    p("zzz/q part1.mp4"): 40, p("zzz/q part2.mp4"): 60,
                    p("dead/left part1.mp4"): 8]
        let u = compute(rows, disk: disk)
        XCTAssertEqual(u.orphanBytes, 608)
        XCTAssertEqual(u.orphanFiles, 5)
        XCTAssertEqual(u.recordings, 1 + 4)                 // a + 2 loose + zzz + dead
        XCTAssertEqual(u.totalBytes, 613)
        XCTAssertEqual(u.files, 6)
        XCTAssertEqual(u.pendingUploadBytes, 5)
    }

    /// Before the first walk: orphans unknown (nil), not 0; the menu leaves the clause out.
    func testNotWalkedYet() {
        let u = compute([DiskRow(id: "a", status: "local", upload: nil, files: [p("a/1.mp4")])],
                        disk: [p("a/1.mp4"): 2_000_000, p("old.mp4"): 9_000_000], walked: false)
        XCTAssertNil(u.orphanBytes)
        XCTAssertNil(u.orphanFiles)
        XCTAssertEqual(u.totalBytes, 2_000_000)
        XCTAssertEqual(u.menuLine, "On this Mac: 2.0 MB in 1 recording · 2.0 MB waiting to upload")
    }

    /// The live recording's open part is in its folder but not yet in `files`: it is the
    /// recording's, never an orphan.
    func testLiveRecordingFolder() {
        let rows = [DiskRow(id: "live", status: "recording", upload: nil, files: [p("live/r part1.mp4")])]
        let disk = [p("live/r part1.mp4"): 10, p("live/r part2.mp4"): 4]
        let u = compute(rows, disk: disk)
        XCTAssertEqual(u.recordingBytes, 14)
        XCTAssertEqual(u.orphanBytes, 0)
        XCTAssertEqual(u.pendingUploadBytes, 0)
        XCTAssertEqual(u.files, 2)
        XCTAssertEqual(u.recordings, 1)
    }

    /// A file referenced by two rows is counted once; paths with a doubled slash still match.
    func testDedupeAndNormalize() {
        let rows = [
            DiskRow(id: "a", status: "local", upload: nil, files: [dir + "//a/1.mp4"]),
            DiskRow(id: "b", status: "uploaded", upload: nil, files: [p("a/1.mp4")]),
        ]
        let u = compute(rows, disk: [p("a/1.mp4"): 11])
        XCTAssertEqual(u.totalBytes, 11)
        XCTAssertEqual(u.pendingUploadBytes, 11)
        XCTAssertEqual(u.uploadedBytes, 0)
        XCTAssertEqual(u.orphanBytes, 0)
    }

    /// A registry file outside the folder (older layouts) is still counted in its bucket.
    func testFileOutsideFolder() {
        let rows = [DiskRow(id: "a", status: "local", upload: nil, files: ["/tmp/elsewhere.mp4"])]
        let u = compute(rows, disk: ["/tmp/elsewhere.mp4": 70])
        XCTAssertEqual(u.pendingUploadBytes, 70)
        XCTAssertEqual(u.totalBytes, 70)
    }

    func testMenuLine() {
        var u = DiskUsage()
        u.totalBytes = 1_200_000_000; u.recordings = 7; u.pendingUploadBytes = 480_000_000; u.orphanBytes = 0
        XCTAssertEqual(u.menuLine, "On this Mac: 1.2 GB in 7 recordings · 480 MB waiting to upload")
        u.orphanBytes = 400_000_000
        XCTAssertEqual(u.menuLine, "On this Mac: 1.2 GB in 7 recordings · 480 MB waiting to upload · 400 MB not in the registry")
        u.pendingUploadBytes = 0
        XCTAssertEqual(u.menuLine, "On this Mac: 1.2 GB in 7 recordings · 400 MB not in the registry")
    }

    func testBytesLabel() {
        XCTAssertEqual(DiskUsage.bytesLabel(0), "0 B")
        XCTAssertEqual(DiskUsage.bytesLabel(999), "999 B")
        XCTAssertEqual(DiskUsage.bytesLabel(1000), "1.0 KB")
        XCTAssertEqual(DiskUsage.bytesLabel(5_100_000), "5.1 MB")
        XCTAssertEqual(DiskUsage.bytesLabel(9_960_000), "10 MB")
        XCTAssertEqual(DiskUsage.bytesLabel(491_000_000), "491 MB")
        XCTAssertEqual(DiskUsage.bytesLabel(999_600_000), "1.0 GB")
        XCTAssertEqual(DiskUsage.bytesLabel(1_234_000_000), "1.2 GB")
    }
}
