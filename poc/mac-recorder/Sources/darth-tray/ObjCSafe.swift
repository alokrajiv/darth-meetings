import Foundation
import ObjCTry

/// Run `body`, turning an Objective-C exception into a thrown Swift error (domain
/// "NSException"). Wrap every AVFoundation object creation that takes a settings dictionary:
/// bad settings RAISE instead of returning an error, Swift cannot catch that, and on
/// 2026-09-17 such a raise inside a main-queue block was swallowed by AppKit and killed the
/// tray's main dispatch queue for 12 hours (see MainQueueWatchdog.swift).
func catchingObjC<T>(_ body: () throws -> T) throws -> T {
    var result: Result<T, Error>?
    if let err = DRCatchObjCException({ result = Result { try body() } }) { throw err }
    guard let result else {
        throw NSError(domain: "NSException", code: 2, userInfo: [NSLocalizedDescriptionKey: "guarded block produced no result"])
    }
    return try result.get()
}
