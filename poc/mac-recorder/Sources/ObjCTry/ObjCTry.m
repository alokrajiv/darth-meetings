#import "ObjCTry.h"

NSError * _Nullable DRCatchObjCException(void (NS_NOESCAPE ^block)(void)) {
    @try {
        block();
        return nil;
    } @catch (NSException *e) {
        NSString *desc = [NSString stringWithFormat:@"%@: %@", e.name, e.reason ?: @"(no reason)"];
        return [NSError errorWithDomain:@"NSException" code:1
                               userInfo:@{NSLocalizedDescriptionKey: desc, @"exception": e}];
    }
}
