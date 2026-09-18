#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Run `block`; if it raises an NSException, return it as an NSError (domain "NSException",
/// localizedDescription "<name>: <reason>", userInfo["exception"] = the NSException).
/// Swift cannot catch Objective-C exceptions; AVFoundation raises them for bad settings
/// (2026-09-17: AVAssetWriterInput with 3 channels and no AVChannelLayoutKey). One that
/// escapes into a main-queue block is swallowed by AppKit and leaves the main dispatch queue
/// dead for the rest of the process — see MainQueueWatchdog.swift.
NSError * _Nullable DRCatchObjCException(void (NS_NOESCAPE ^block)(void));

NS_ASSUME_NONNULL_END
