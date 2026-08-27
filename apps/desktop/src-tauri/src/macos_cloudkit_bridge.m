/**
 * macOS CloudKit bridge — C-callable functions for Rust FFI.
 *
 * Ports the Swift CloudKit sync module to Objective-C so it can be compiled by
 * the `cc` crate in build.rs.  Uses the legacy CloudKit completion-block API
 * (macOS 10.12+) for broad SDK compatibility.
 *
 * All functions block on a dispatch semaphore (Tauri invokes them from a Tokio
 * blocking thread) and return heap-allocated JSON strings.
 */
#import <CloudKit/CloudKit.h>
#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#include <dispatch/dispatch.h>

// Suppress deprecation warnings for legacy CloudKit completion-block APIs.
// We use these for broad SDK compatibility (macOS 10.12+).
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
#include <stdlib.h>
#include <string.h>

// ---------------------------------------------------------------------------
// MARK: - Constants
// ---------------------------------------------------------------------------

static NSString *const kContainerID    = @"iCloud.tech.dongdongbh.mindwtr";
static NSString *const kZoneName       = @"MindwtrZone";
static NSString *const kSubscriptionID = @"MindwtrZoneSubscription";
static const NSInteger kBatchSize      = 400;
static const int64_t   kTimeoutSec     = 60;

// ---------------------------------------------------------------------------
// MARK: - Shared state
// ---------------------------------------------------------------------------

static CKContainer    *_ckContainer = nil;
static CKDatabase     *_ckPrivateDB = nil;
static CKRecordZoneID *_ckZoneID    = nil;

static _Atomic(int) _pendingRemoteChange = 0;

static void mindwtr_ck_ensure_container(void) {
    static dispatch_once_t onceToken;
    dispatch_once(&onceToken, ^{
        _ckContainer = [CKContainer containerWithIdentifier:kContainerID];
        _ckPrivateDB = [_ckContainer privateCloudDatabase];
        _ckZoneID    = [[CKRecordZoneID alloc] initWithZoneName:kZoneName
                                                      ownerName:CKCurrentUserDefaultName];
    });
}

// ---------------------------------------------------------------------------
// MARK: - JSON helpers
// ---------------------------------------------------------------------------

static char *ck_copy_json(id object) {
    if (!object || ![NSJSONSerialization isValidJSONObject:object]) {
        return strdup("{\"error\":\"invalid-json\"}");
    }
    NSError *err = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:&err];
    if (!data || err) return strdup("{\"error\":\"json-encode-failed\"}");
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!json) return strdup("{\"error\":\"json-encode-failed\"}");
    const char *utf8 = [json UTF8String];
    return utf8 ? strdup(utf8) : strdup("{\"error\":\"json-encode-failed\"}");
}

// CloudKit reports how long to wait before retrying a throttled or unavailable
// request in CKErrorRetryAfterKey, and Apple asks callers to wait that long
// rather than guess one. A partial failure carries the real reason, including
// that interval, on its per-item errors instead of the top-level one, so look
// there too. Read whenever CloudKit supplies the key, not for one error code.
static NSNumber *ck_retry_after_seconds(NSError *error) {
    if (!error) return nil;
    id retryAfter = [error userInfo][CKErrorRetryAfterKey];
    if ([retryAfter isKindOfClass:[NSNumber class]]) return (NSNumber *)retryAfter;
    id partial = [error userInfo][CKPartialErrorsByItemIDKey];
    if ([partial isKindOfClass:[NSDictionary class]]) {
        NSNumber *longest = nil;
        for (id value in [(NSDictionary *)partial allValues]) {
            if (![value isKindOfClass:[NSError class]]) continue;
            NSNumber *nested = ck_retry_after_seconds((NSError *)value);
            if (nested && (!longest || [nested doubleValue] > [longest doubleValue])) {
                longest = nested;
            }
        }
        return longest;
    }
    return nil;
}

static char *ck_error_json(NSError *error) {
    NSString *msg = [error localizedDescription] ?: @"unknown error";
    // The JS layer only ever sees this string, so carry the interval in the
    // fixed form it parses (#948).
    NSNumber *retryAfter = ck_retry_after_seconds(error);
    if (retryAfter) {
        msg = [NSString stringWithFormat:@"%@ [retryAfter=%@]", msg, retryAfter];
    }
    return ck_copy_json(@{@"error": msg, @"errorCode": @([error code])});
}

static char *ck_success_json(void) {
    return strdup("{\"ok\":true}");
}

/// CloudKit server-side error code for queries against a record type that does
/// not yet exist in the container schema.  Observed in the NSUnderlyingError of
/// CKErrorServerRejectedRequest when querying a Development-environment
/// container before any records of that type have been saved.
/// Apple does not publish this constant; it was determined empirically and is
/// stable across macOS 13–15 and iOS 16–18.
static const NSInteger kCKServerErrorUnknownRecordType = 2003;

/// Locale-independent check for "unknown record type" inside a
/// CKErrorServerRejectedRequest.  Inspects the NSUnderlyingError code rather
/// than localizedDescription so this works on non-English systems.
static BOOL ck_is_unknown_record_type(NSError *error) {
    NSError *underlying = error.userInfo[NSUnderlyingErrorKey];
    if ([underlying isKindOfClass:[NSError class]] &&
        underlying.code == kCKServerErrorUnknownRecordType) {
        return YES;
    }
    return NO;
}

// ---------------------------------------------------------------------------
// MARK: - Field specs (mirrors CloudKitRecordMapper.swift exactly)
// ---------------------------------------------------------------------------

typedef NS_ENUM(NSInteger, MWFieldKind) {
    MWFieldKindString,
    MWFieldKindInt,
    MWFieldKindBool,
    MWFieldKindStringArray,
    MWFieldKindJsonString,
    MWFieldKindDate,
};

typedef struct {
    const char *jsKey;
    const char *ckKey;
    MWFieldKind kind;
} MWFieldSpec;

static const MWFieldSpec kTaskFields[] = {
    {"title",          "title",           MWFieldKindString},
    {"status",         "status",          MWFieldKindString},
    {"priority",       "priority",        MWFieldKindString},
    {"energyLevel",    "energyLevel",     MWFieldKindString},
    {"assignedTo",     "assignedTo",      MWFieldKindString},
    {"taskMode",       "taskMode",        MWFieldKindString},
    {"startTime",      "startTime",       MWFieldKindDate},
    {"relativeStartOffset", "relativeStartOffset", MWFieldKindJsonString},
    {"dueDate",        "dueDate",         MWFieldKindDate},
    {"recurrence",     "recurrence",      MWFieldKindJsonString},
    {"showFutureRecurrence", "showFutureRecurrence", MWFieldKindBool},
    {"pushCount",      "pushCount",       MWFieldKindInt},
    {"tags",           "tags",            MWFieldKindStringArray},
    {"contexts",       "contexts",        MWFieldKindStringArray},
    {"checklist",      "checklist",       MWFieldKindJsonString},
    {"description",    "taskDescription", MWFieldKindString},
    {"textDirection",  "textDirection",   MWFieldKindString},
    {"attachments",    "attachments",     MWFieldKindJsonString},
    {"location",       "location",        MWFieldKindString},
    {"projectId",      "projectId",       MWFieldKindString},
    {"sectionId",      "sectionId",       MWFieldKindString},
    {"viewSectionIds", "viewSectionIds",  MWFieldKindJsonString},
    {"areaId",         "areaId",          MWFieldKindString},
    {"isFocusedToday", "isFocusedToday",  MWFieldKindBool},
    {"timeEstimate",   "timeEstimate",    MWFieldKindString},
    {"timeSpentMinutes", "timeSpentMinutes", MWFieldKindInt},
    {"focusOrder",       "focusOrder",       MWFieldKindInt},
    {"suppressMindwtrReminders", "suppressMindwtrReminders", MWFieldKindBool},
    {"repeatReminderMinutes", "repeatReminderMinutes", MWFieldKindInt},
    {"reviewAt",       "reviewAt",        MWFieldKindDate},
    {"completedAt",    "completedAt",     MWFieldKindDate},
    {"statusBeforeProjectArchive", "statusBeforeProjectArchive", MWFieldKindString},
    {"completedAtBeforeProjectArchive", "completedAtBeforeProjectArchive", MWFieldKindDate},
    {"isFocusedTodayBeforeProjectArchive", "isFocusedTodayBeforeProjectArchive", MWFieldKindBool},
    {"projectArchivedAt", "projectArchivedAt", MWFieldKindDate},
    {"rev",            "rev",             MWFieldKindInt},
    {"revBy",          "revBy",           MWFieldKindString},
    {"createdAt",      "createdAt",       MWFieldKindDate},
    {"updatedAt",      "updatedAt",       MWFieldKindDate},
    {"deletedAt",      "deletedAt",       MWFieldKindDate},
    {"purgedAt",       "purgedAt",        MWFieldKindDate},
    {"order",          "sortOrder",       MWFieldKindInt},
    {"orderNum",       "orderNum",        MWFieldKindInt},
};
static const size_t kTaskFieldsCount = sizeof(kTaskFields) / sizeof(kTaskFields[0]);

static const MWFieldSpec kProjectFields[] = {
    {"title",        "title",        MWFieldKindString},
    {"status",       "status",       MWFieldKindString},
    {"color",        "color",        MWFieldKindString},
    {"order",        "sortOrder",    MWFieldKindInt},
    {"tagIds",       "tagIds",       MWFieldKindStringArray},
    {"isSequential", "isSequential", MWFieldKindBool},
    {"sequentialScope", "sequentialScope", MWFieldKindString},
    {"taskSortBy",   "taskSortBy",   MWFieldKindString},
    {"isFocused",    "isFocused",    MWFieldKindBool},
    {"supportNotes", "supportNotes", MWFieldKindString},
    {"attachments",  "attachments",  MWFieldKindJsonString},
    {"dueDate",      "dueDate",      MWFieldKindDate},
    {"reviewAt",     "reviewAt",     MWFieldKindDate},
    {"areaId",       "areaId",       MWFieldKindString},
    {"areaTitle",    "areaTitle",    MWFieldKindString},
    {"rev",          "rev",          MWFieldKindInt},
    {"revBy",        "revBy",        MWFieldKindString},
    {"createdAt",    "createdAt",    MWFieldKindDate},
    {"updatedAt",    "updatedAt",    MWFieldKindDate},
    {"deletedAt",    "deletedAt",    MWFieldKindDate},
    {"purgedAt",     "purgedAt",     MWFieldKindDate},
};
static const size_t kProjectFieldsCount = sizeof(kProjectFields) / sizeof(kProjectFields[0]);

static const MWFieldSpec kSectionFields[] = {
    {"projectId",   "projectId",          MWFieldKindString},
    {"title",       "title",              MWFieldKindString},
    {"description", "sectionDescription", MWFieldKindString},
    {"order",       "sortOrder",          MWFieldKindInt},
    {"isCollapsed", "isCollapsed",        MWFieldKindBool},
    {"rev",         "rev",                MWFieldKindInt},
    {"revBy",       "revBy",              MWFieldKindString},
    {"createdAt",   "createdAt",          MWFieldKindDate},
    {"updatedAt",   "updatedAt",          MWFieldKindDate},
    {"deletedAt",   "deletedAt",          MWFieldKindDate},
    {"deletedAtBeforeProjectArchive", "deletedAtBeforeProjectArchive", MWFieldKindDate},
    {"projectArchivedAt", "projectArchivedAt", MWFieldKindDate},
};
static const size_t kSectionFieldsCount = sizeof(kSectionFields) / sizeof(kSectionFields[0]);

static const MWFieldSpec kAreaFields[] = {
    {"name",      "name",      MWFieldKindString},
    {"color",     "color",     MWFieldKindString},
    {"icon",      "icon",      MWFieldKindString},
    {"order",     "sortOrder", MWFieldKindInt},
    {"rev",       "rev",       MWFieldKindInt},
    {"revBy",     "revBy",     MWFieldKindString},
    {"createdAt", "createdAt", MWFieldKindDate},
    {"updatedAt", "updatedAt", MWFieldKindDate},
    {"deletedAt", "deletedAt", MWFieldKindDate},
};
static const size_t kAreaFieldsCount = sizeof(kAreaFields) / sizeof(kAreaFields[0]);

static const MWFieldSpec kPersonFields[] = {
    {"name",          "name",          MWFieldKindString},
    {"note",          "note",          MWFieldKindString},
    {"referenceLink", "referenceLink", MWFieldKindString},
    {"rev",           "rev",           MWFieldKindInt},
    {"revBy",         "revBy",         MWFieldKindString},
    {"createdAt",     "createdAt",     MWFieldKindDate},
    {"updatedAt",     "updatedAt",     MWFieldKindDate},
    {"deletedAt",     "deletedAt",     MWFieldKindDate},
};
static const size_t kPersonFieldsCount = sizeof(kPersonFields) / sizeof(kPersonFields[0]);

static const MWFieldSpec kSettingsFields[] = {
    {"payload",   "payload",   MWFieldKindJsonString},
    {"updatedAt", "updatedAt", MWFieldKindDate},
};
static const size_t kSettingsFieldsCount = sizeof(kSettingsFields) / sizeof(kSettingsFields[0]);

static void ck_get_field_specs(NSString *recordType,
                               const MWFieldSpec **outSpecs,
                               size_t *outCount) {
    if ([recordType isEqualToString:@"MindwtrTask"]) {
        *outSpecs = kTaskFields; *outCount = kTaskFieldsCount;
    } else if ([recordType isEqualToString:@"MindwtrProject"]) {
        *outSpecs = kProjectFields; *outCount = kProjectFieldsCount;
    } else if ([recordType isEqualToString:@"MindwtrSection"]) {
        *outSpecs = kSectionFields; *outCount = kSectionFieldsCount;
    } else if ([recordType isEqualToString:@"MindwtrArea"]) {
        *outSpecs = kAreaFields; *outCount = kAreaFieldsCount;
    } else if ([recordType isEqualToString:@"MindwtrPerson"]) {
        *outSpecs = kPersonFields; *outCount = kPersonFieldsCount;
    } else if ([recordType isEqualToString:@"MindwtrSettings"]) {
        *outSpecs = kSettingsFields; *outCount = kSettingsFieldsCount;
    } else {
        *outSpecs = NULL; *outCount = 0;
    }
}

// ---------------------------------------------------------------------------
// MARK: - Record mapping (JSON ↔ CKRecord)
// ---------------------------------------------------------------------------

static void ck_apply_fields(NSDictionary *json, CKRecord *record, NSString *recordType) {
    const MWFieldSpec *specs; size_t count;
    ck_get_field_specs(recordType, &specs, &count);

    for (size_t i = 0; i < count; i++) {
        NSString *jsKey = [NSString stringWithUTF8String:specs[i].jsKey];
        NSString *ckKey = [NSString stringWithUTF8String:specs[i].ckKey];
        id value = json[jsKey];

        if (!value || [value isKindOfClass:[NSNull class]]) {
            record[ckKey] = nil;
            continue;
        }
        switch (specs[i].kind) {
            case MWFieldKindString:
            case MWFieldKindDate:
                if ([value isKindOfClass:[NSString class]]) record[ckKey] = value;
                break;
            case MWFieldKindInt:
                if ([value isKindOfClass:[NSNumber class]]) record[ckKey] = @([value longLongValue]);
                break;
            case MWFieldKindBool:
                if ([value isKindOfClass:[NSNumber class]]) record[ckKey] = @([value boolValue] ? 1LL : 0LL);
                break;
            case MWFieldKindStringArray:
                if ([value isKindOfClass:[NSArray class]]) record[ckKey] = value;
                break;
            case MWFieldKindJsonString:
                if ([value isKindOfClass:[NSString class]]) {
                    record[ckKey] = value;
                } else if ([NSJSONSerialization isValidJSONObject:value]) {
                    NSData *data = [NSJSONSerialization dataWithJSONObject:value options:0 error:nil];
                    if (data) {
                        NSString *str = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
                        if (str) record[ckKey] = str;
                    }
                }
                break;
        }
    }
}

static NSDictionary *ck_json_from_record(CKRecord *record) {
    NSMutableDictionary *result = [NSMutableDictionary dictionary];
    result[@"id"] = record.recordID.recordName;

    NSString *recordType = record.recordType;
    const MWFieldSpec *specs; size_t count;
    ck_get_field_specs(recordType, &specs, &count);

    for (size_t i = 0; i < count; i++) {
        NSString *ckKey = [NSString stringWithUTF8String:specs[i].ckKey];
        NSString *jsKey = [NSString stringWithUTF8String:specs[i].jsKey];
        id value = record[ckKey];
        if (!value) continue;

        switch (specs[i].kind) {
            case MWFieldKindString:
            case MWFieldKindDate:
                if ([value isKindOfClass:[NSString class]]) result[jsKey] = value;
                break;
            case MWFieldKindInt:
                if ([value isKindOfClass:[NSNumber class]]) result[jsKey] = value;
                break;
            case MWFieldKindBool:
                // `@(expr == 1)` boxes via numberWithInt: (C `==` yields int), so
                // NSJSONSerialization emits 0/1 numbers, not true/false. Force a real
                // boolean NSNumber (@YES/@NO) so the JSON matches the JS `boolean` type
                // core's strict `=== true` sync-merge normalizers expect (#902).
                if ([value isKindOfClass:[NSNumber class]]) result[jsKey] = ([value longLongValue] == 1) ? @YES : @NO;
                break;
            case MWFieldKindStringArray:
                if ([value isKindOfClass:[NSArray class]]) result[jsKey] = value;
                break;
            case MWFieldKindJsonString:
                if ([value isKindOfClass:[NSString class]]) {
                    NSData *data = [(NSString *)value dataUsingEncoding:NSUTF8StringEncoding];
                    if (data) {
                        id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
                        result[jsKey] = parsed ?: value;
                    } else {
                        result[jsKey] = value;
                    }
                }
                break;
        }
    }
    return result;
}

#if defined(MINDWTR_NATIVE_MAPPER_FIXTURE_CHECK)
/// Test-only entry point used by scripts/check-synced-field-parity.ts. It keeps
/// the fixture harness on the same mapping functions used by production sync.
char *mindwtr_cloudkit_round_trip_task_json(const char *json_utf8) {
    @autoreleasepool {
        if (!json_utf8) return NULL;

        NSData *data = [NSData dataWithBytes:json_utf8 length:strlen(json_utf8)];
        NSError *error = nil;
        id parsed = [NSJSONSerialization JSONObjectWithData:data options:0 error:&error];
        if (error || ![parsed isKindOfClass:[NSDictionary class]]) return NULL;

        NSDictionary *json = (NSDictionary *)parsed;
        NSString *taskID = json[@"id"];
        if (![taskID isKindOfClass:[NSString class]] || taskID.length == 0) return NULL;

        CKRecordZoneID *zoneID = [[CKRecordZoneID alloc] initWithZoneName:@"MindwtrFixtureZone"
                                                                ownerName:CKCurrentUserDefaultName];
        CKRecordID *recordID = [[CKRecordID alloc] initWithRecordName:taskID zoneID:zoneID];
        CKRecord *record = [[CKRecord alloc] initWithRecordType:@"MindwtrTask" recordID:recordID];
        ck_apply_fields(json, record, @"MindwtrTask");
        return ck_copy_json(ck_json_from_record(record));
    }
}
#endif

// ---------------------------------------------------------------------------
// MARK: - Change token serialization
// ---------------------------------------------------------------------------

static NSString *ck_serialize_token(CKServerChangeToken *token) {
    if (!token) return nil;
    NSError *err = nil;
    NSData *data = [NSKeyedArchiver archivedDataWithRootObject:token
                                         requiringSecureCoding:YES
                                                         error:&err];
    if (!data || err) {
        NSLog(@"[Mindwtr] Failed to serialize change token: %@", err);
        return nil;
    }
    return [data base64EncodedStringWithOptions:0];
}

static CKServerChangeToken *ck_deserialize_token(NSString *base64) {
    if (!base64 || [base64 length] == 0) return nil;
    NSData *data = [[NSData alloc] initWithBase64EncodedString:base64 options:0];
    if (!data) return nil;
    NSError *err = nil;
    CKServerChangeToken *token = [NSKeyedUnarchiver unarchivedObjectOfClass:[CKServerChangeToken class]
                                                                   fromData:data
                                                                      error:&err];
    if (err) {
        NSLog(@"[Mindwtr] Failed to deserialize change token: %@", err);
        return nil;
    }
    return token;
}

// ---------------------------------------------------------------------------
// MARK: - Public C API
// ---------------------------------------------------------------------------

char *mindwtr_cloudkit_account_status(void) {
    @autoreleasepool {
        mindwtr_ck_ensure_container();

        __block CKAccountStatus status = CKAccountStatusCouldNotDetermine;
        __block NSError *opError = nil;
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);

        [_ckContainer accountStatusWithCompletionHandler:^(CKAccountStatus s, NSError *error) {
            status = s;
            opError = error;
            dispatch_semaphore_signal(sem);
        }];

        long waited = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, kTimeoutSec * NSEC_PER_SEC));
        if (waited != 0) return ck_copy_json(@{@"status": @"timeout"});
        if (opError) return ck_error_json(opError);

        NSString *str;
        switch (status) {
            case CKAccountStatusAvailable:              str = @"available"; break;
            case CKAccountStatusNoAccount:              str = @"noAccount"; break;
            case CKAccountStatusRestricted:             str = @"restricted"; break;
            case CKAccountStatusTemporarilyUnavailable: str = @"temporarilyUnavailable"; break;
            default:                                    str = @"unknown"; break;
        }
        return ck_copy_json(@{@"status": str});
    }
}

char *mindwtr_cloudkit_ensure_zone(void) {
    @autoreleasepool {
        mindwtr_ck_ensure_container();

        CKRecordZone *zone = [[CKRecordZone alloc] initWithZoneID:_ckZoneID];
        CKModifyRecordZonesOperation *op =
            [[CKModifyRecordZonesOperation alloc] initWithRecordZonesToSave:@[zone]
                                                   recordZoneIDsToDelete:nil];
        op.qualityOfService = NSQualityOfServiceUserInitiated;

        __block NSError *opError = nil;
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);

        op.modifyRecordZonesCompletionBlock = ^(NSArray *saved __unused,
                                                 NSArray *deleted __unused,
                                                 NSError *error) {
            opError = error;
            dispatch_semaphore_signal(sem);
        };
        [_ckPrivateDB addOperation:op];

        long waited = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, kTimeoutSec * NSEC_PER_SEC));
        if (waited != 0) return ck_copy_json(@{@"error": @"timeout"});
        if (opError) return ck_error_json(opError);
        return ck_success_json();
    }
}

char *mindwtr_cloudkit_ensure_subscription(void) {
    @autoreleasepool {
        mindwtr_ck_ensure_container();

        // Check if subscription already exists.
        __block BOOL alreadyExists = NO;
        dispatch_semaphore_t fetchSem = dispatch_semaphore_create(0);
        [_ckPrivateDB fetchSubscriptionWithID:kSubscriptionID
                            completionHandler:^(CKSubscription *sub, NSError *error __unused) {
            if (sub) alreadyExists = YES;
            dispatch_semaphore_signal(fetchSem);
        }];
        dispatch_semaphore_wait(fetchSem, dispatch_time(DISPATCH_TIME_NOW, kTimeoutSec * NSEC_PER_SEC));
        if (alreadyExists) return ck_success_json();

        // Create the subscription.
        CKRecordZoneSubscription *sub =
            [[CKRecordZoneSubscription alloc] initWithZoneID:_ckZoneID
                                              subscriptionID:kSubscriptionID];
        CKNotificationInfo *notifInfo = [[CKNotificationInfo alloc] init];
        notifInfo.shouldSendContentAvailable = YES;
        sub.notificationInfo = notifInfo;

        CKModifySubscriptionsOperation *op =
            [[CKModifySubscriptionsOperation alloc] initWithSubscriptionsToSave:@[sub]
                                                       subscriptionIDsToDelete:nil];
        op.qualityOfService = NSQualityOfServiceUtility;

        __block NSError *opError = nil;
        dispatch_semaphore_t sem = dispatch_semaphore_create(0);
        op.modifySubscriptionsCompletionBlock = ^(NSArray *saved __unused,
                                                   NSArray *deleted __unused,
                                                   NSError *error) {
            opError = error;
            dispatch_semaphore_signal(sem);
        };
        [_ckPrivateDB addOperation:op];

        long waited = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, kTimeoutSec * NSEC_PER_SEC));
        if (waited != 0) return ck_copy_json(@{@"error": @"subscription-timeout"});
        if (opError) return ck_error_json(opError);
        return ck_success_json();
    }
}

char *mindwtr_cloudkit_fetch_all_records(const char *record_type_cstr) {
    @autoreleasepool {
        if (!record_type_cstr) return strdup("[]");
        mindwtr_ck_ensure_container();

        NSString *recordType = [NSString stringWithUTF8String:record_type_cstr];
        NSMutableArray<NSDictionary *> *allResults = [NSMutableArray array];

        CKQuery *query = [[CKQuery alloc] initWithRecordType:recordType
                                                   predicate:[NSPredicate predicateWithValue:YES]];
        __block CKQueryCursor *nextCursor = nil;
        BOOL firstPass = YES;

        do {
            CKQueryOperation *op;
            if (firstPass) {
                op = [[CKQueryOperation alloc] initWithQuery:query];
                firstPass = NO;
            } else {
                op = [[CKQueryOperation alloc] initWithCursor:nextCursor];
            }
            op.zoneID = _ckZoneID;
            op.qualityOfService = NSQualityOfServiceUserInitiated;

            __block NSMutableArray<CKRecord *> *batchRecords = [NSMutableArray array];
            __block CKQueryCursor *batchCursor = nil;
            __block NSError *batchError = nil;
            dispatch_semaphore_t sem = dispatch_semaphore_create(0);

            op.recordFetchedBlock = ^(CKRecord *record) {
                @synchronized (batchRecords) {
                    [batchRecords addObject:record];
                }
            };
            op.queryCompletionBlock = ^(CKQueryCursor *cursor, NSError *error) {
                batchCursor = cursor;
                batchError = error;
                dispatch_semaphore_signal(sem);
            };
            [_ckPrivateDB addOperation:op];

            long waited = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, kTimeoutSec * NSEC_PER_SEC));
            if (waited != 0) return ck_copy_json(@{@"error": @"fetch-timeout"});
            if (batchError) {
                // Record type not yet created in CloudKit schema — treat as empty.
                // The type is auto-created on first save in the Development environment.
                // CKErrorUnknownItem: record type unknown to the client framework.
                // CKErrorServerRejectedRequest: server rejects the query because the
                //   record type doesn't exist in the schema yet. We check the
                //   underlying server error code (2003 = "UNKNOWN_RECORD_TYPE") which
                //   is locale-independent, unlike localizedDescription.
                if (batchError.code == CKErrorUnknownItem ||
                    (batchError.code == CKErrorServerRejectedRequest &&
                     ck_is_unknown_record_type(batchError))) {
                    return strdup("[]");
                }
                return ck_error_json(batchError);
            }

            for (CKRecord *r in batchRecords) {
                [allResults addObject:ck_json_from_record(r)];
            }
            nextCursor = batchCursor;
        } while (nextCursor != nil);

        return ck_copy_json(allResults);
    }
}

char *mindwtr_cloudkit_fetch_changes(const char *change_token_base64_cstr) {
    @autoreleasepool {
        mindwtr_ck_ensure_container();

        NSString *tokenB64 = change_token_base64_cstr
            ? [NSString stringWithUTF8String:change_token_base64_cstr]
            : nil;
        CKServerChangeToken *previousToken = ck_deserialize_token(tokenB64);

        CKFetchRecordZoneChangesOptions *options =
            [[CKFetchRecordZoneChangesOptions alloc] init];
        options.previousServerChangeToken = previousToken;

        CKFetchRecordZoneChangesOperation *op =
            [[CKFetchRecordZoneChangesOperation alloc]
                initWithRecordZoneIDs:@[_ckZoneID]
                optionsByRecordZoneID:@{_ckZoneID: options}];
        op.fetchAllChanges = YES;
        op.qualityOfService = NSQualityOfServiceUserInitiated;

        dispatch_queue_t cbQueue = dispatch_queue_create("tech.dongdongbh.mindwtr.ckchanges", DISPATCH_QUEUE_SERIAL);

        __block NSMutableDictionary<NSString *, NSMutableArray *> *recordsByType = [NSMutableDictionary dictionary];
        __block NSMutableDictionary<NSString *, NSMutableArray *> *deletedByType = [NSMutableDictionary dictionary];
        __block NSString *newTokenB64 = nil;
        __block BOOL tokenExpired = NO;
        __block NSError *zoneError = nil;

        dispatch_semaphore_t sem = dispatch_semaphore_create(0);

        op.recordChangedBlock = ^(CKRecord *record) {
            dispatch_sync(cbQueue, ^{
                NSString *type = record.recordType;
                if (!recordsByType[type]) recordsByType[type] = [NSMutableArray array];
                [recordsByType[type] addObject:ck_json_from_record(record)];
            });
        };

        op.recordWithIDWasDeletedBlock = ^(CKRecordID *recordID, NSString *recordType) {
            dispatch_sync(cbQueue, ^{
                if (!deletedByType[recordType]) deletedByType[recordType] = [NSMutableArray array];
                [deletedByType[recordType] addObject:recordID.recordName];
            });
        };

        op.recordZoneFetchCompletionBlock = ^(CKRecordZoneID *zoneID __unused,
                                               CKServerChangeToken *serverChangeToken,
                                               NSData *clientTokenData __unused,
                                               BOOL moreComing __unused,
                                               NSError *error) {
            dispatch_sync(cbQueue, ^{
                if (error) {
                    if ([error.domain isEqualToString:CKErrorDomain] &&
                        error.code == CKErrorChangeTokenExpired) {
                        tokenExpired = YES;
                    } else {
                        zoneError = error;
                    }
                } else {
                    newTokenB64 = ck_serialize_token(serverChangeToken);
                }
            });
        };

        op.fetchRecordZoneChangesCompletionBlock = ^(NSError *error __unused) {
            dispatch_semaphore_signal(sem);
        };

        [_ckPrivateDB addOperation:op];
        long waited = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, kTimeoutSec * NSEC_PER_SEC));

        if (waited != 0) return ck_copy_json(@{@"error": @"timeout"});
        if (tokenExpired) return ck_copy_json(@{@"tokenExpired": @YES, @"records": @{}, @"deletedIDs": @{}});
        if (zoneError) return ck_error_json(zoneError);

        NSMutableDictionary *result = [NSMutableDictionary dictionary];
        result[@"records"] = recordsByType;
        result[@"deletedIDs"] = deletedByType;
        result[@"tokenExpired"] = @NO;
        if (newTokenB64) result[@"changeToken"] = newTokenB64;

        return ck_copy_json(result);
    }
}

/// Fetch records by their IDs. Returns a mutable dictionary keyed by CKRecordID.
/// On error, returns nil and sets *outError. unknownItem (record doesn't exist) is
/// silently skipped — mirrors iOS fetchRecordsByID behaviour.
static NSMutableDictionary<CKRecordID *, CKRecord *> *
ck_fetch_records_by_id(NSArray<CKRecordID *> *ids, NSError **outError) {
    NSMutableDictionary<CKRecordID *, CKRecord *> *results = [NSMutableDictionary dictionary];
    if (ids.count == 0) return results;

    CKFetchRecordsOperation *op = [[CKFetchRecordsOperation alloc] initWithRecordIDs:ids];
    op.qualityOfService = NSQualityOfServiceUserInitiated;

    __block NSMutableArray<NSError *> *perRecordErrors = [NSMutableArray array];
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);

    op.fetchRecordsCompletionBlock = ^(NSDictionary<CKRecordID *, CKRecord *> *recordsByID,
                                       NSError *error) {
        // Collect successfully fetched records.
        if (recordsByID) {
            [results addEntriesFromDictionary:recordsByID];
        }
        if (error) {
            if ([error.domain isEqualToString:CKErrorDomain] &&
                error.code == CKErrorPartialFailure) {
                // Inspect per-record errors — suppress unknownItem, collect real errors.
                NSDictionary *partials = error.userInfo[CKPartialErrorsByItemIDKey];
                for (CKRecordID *failedID in partials) {
                    NSError *perErr = partials[failedID];
                    if ([perErr.domain isEqualToString:CKErrorDomain] &&
                        perErr.code == CKErrorUnknownItem) {
                        continue; // record doesn't exist yet — skip
                    }
                    [perRecordErrors addObject:perErr];
                }
            } else {
                [perRecordErrors addObject:error];
            }
        }
        dispatch_semaphore_signal(sem);
    };
    [_ckPrivateDB addOperation:op];
    long waited = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, kTimeoutSec * NSEC_PER_SEC));

    if (waited != 0) {
        if (outError) *outError = [NSError errorWithDomain:CKErrorDomain code:CKErrorNetworkFailure
                                                  userInfo:@{NSLocalizedDescriptionKey: @"fetch-by-id-timeout"}];
        return nil;
    }
    if (perRecordErrors.count > 0) {
        if (outError) *outError = perRecordErrors.firstObject;
        return nil;
    }
    return results;
}

static NSString * const kMindwtrAttachmentRecordType = @"MindwtrAttachment";
static NSString * const kMindwtrAttachmentAssetField = @"asset";

static NSURL *ck_file_url_from_path(NSString *path) {
    if (!path || path.length == 0) return nil;
    NSURL *url = [NSURL URLWithString:path];
    if (url && url.isFileURL) return url;
    return [NSURL fileURLWithPath:path];
}

static NSDictionary *ck_attachment_metadata_from_record(CKRecord *record) {
    NSMutableDictionary *result = [NSMutableDictionary dictionary];
    result[@"recordName"] = record.recordID.recordName;
    NSArray<NSString *> *stringFields = @[
        @"attachmentId",
        @"ownerType",
        @"ownerId",
        @"title",
        @"mimeType",
        @"fileHash",
        @"updatedAt",
        @"deletedAt",
    ];
    for (NSString *field in stringFields) {
        id value = record[field];
        if ([value isKindOfClass:[NSString class]]) result[field] = value;
    }
    id size = record[@"size"];
    if ([size isKindOfClass:[NSNumber class]]) result[@"size"] = size;
    return result;
}

static void ck_apply_attachment_metadata(NSDictionary *metadata, CKRecord *record) {
    NSArray<NSString *> *stringFields = @[
        @"attachmentId",
        @"ownerType",
        @"ownerId",
        @"title",
        @"mimeType",
        @"fileHash",
        @"updatedAt",
        @"deletedAt",
    ];
    for (NSString *field in stringFields) {
        id value = metadata[field];
        if ([value isKindOfClass:[NSString class]] && [value length] > 0) record[field] = value;
        else record[field] = nil;
    }
    id size = metadata[@"size"];
    if ([size isKindOfClass:[NSNumber class]]) record[@"size"] = size;
    else record[@"size"] = nil;
}

static char *ck_save_single_record(CKRecord *record, NSString *timeoutName) {
    CKModifyRecordsOperation *op =
        [[CKModifyRecordsOperation alloc] initWithRecordsToSave:@[record] recordIDsToDelete:nil];
    op.savePolicy = CKRecordSaveChangedKeys;
    op.qualityOfService = NSQualityOfServiceUserInitiated;
    __block NSError *saveError = nil;
    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    op.modifyRecordsCompletionBlock = ^(NSArray<CKRecord *> *saved __unused,
                                        NSArray<CKRecordID *> *deleted __unused,
                                        NSError *error) {
        saveError = error;
        dispatch_semaphore_signal(sem);
    };
    [_ckPrivateDB addOperation:op];
    long waited = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, kTimeoutSec * NSEC_PER_SEC));
    if (waited != 0) return ck_copy_json(@{@"error": timeoutName ?: @"save-timeout"});
    if (saveError) return ck_error_json(saveError);
    return NULL;
}

char *mindwtr_cloudkit_save_attachment_asset(const char *record_name_cstr,
                                             const char *file_path_cstr,
                                             const char *metadata_json_cstr) {
    @autoreleasepool {
        if (!record_name_cstr || !file_path_cstr || !metadata_json_cstr) {
            return ck_copy_json(@{@"error": @"invalid-attachment-input"});
        }
        mindwtr_ck_ensure_container();
        NSString *recordName = [NSString stringWithUTF8String:record_name_cstr];
        NSString *filePath = [NSString stringWithUTF8String:file_path_cstr];
        NSData *jsonData = [[NSString stringWithUTF8String:metadata_json_cstr] dataUsingEncoding:NSUTF8StringEncoding];
        if (!jsonData) return ck_copy_json(@{@"error": @"invalid-attachment-metadata"});
        NSDictionary *metadata = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:nil];
        if (![metadata isKindOfClass:[NSDictionary class]]) {
            return ck_copy_json(@{@"error": @"invalid-attachment-metadata"});
        }
        NSURL *fileURL = ck_file_url_from_path(filePath);
        if (!fileURL) return ck_copy_json(@{@"error": @"invalid-attachment-file"});

        CKRecordID *recordID = [[CKRecordID alloc] initWithRecordName:recordName zoneID:_ckZoneID];
        NSError *fetchError = nil;
        NSDictionary *fetched = ck_fetch_records_by_id(@[recordID], &fetchError);
        if (!fetched && fetchError) {
            return ck_copy_json(@{@"error": fetchError.localizedDescription ?: @"fetch-existing-attachment-failed"});
        }
        CKRecord *record = fetched[recordID] ?: [[CKRecord alloc] initWithRecordType:kMindwtrAttachmentRecordType recordID:recordID];
        ck_apply_attachment_metadata(metadata, record);
        record[kMindwtrAttachmentAssetField] = [[CKAsset alloc] initWithFileURL:fileURL];

        char *saveError = ck_save_single_record(record, @"attachment-save-timeout");
        if (saveError) return saveError;
        return ck_copy_json(ck_attachment_metadata_from_record(record));
    }
}

char *mindwtr_cloudkit_fetch_attachment_asset(const char *record_name_cstr,
                                              const char *target_path_cstr) {
    @autoreleasepool {
        if (!record_name_cstr || !target_path_cstr) {
            return ck_copy_json(@{@"error": @"invalid-attachment-input"});
        }
        mindwtr_ck_ensure_container();
        NSString *recordName = [NSString stringWithUTF8String:record_name_cstr];
        NSString *targetPath = [NSString stringWithUTF8String:target_path_cstr];
        CKRecordID *recordID = [[CKRecordID alloc] initWithRecordName:recordName zoneID:_ckZoneID];
        NSError *fetchError = nil;
        NSDictionary *fetched = ck_fetch_records_by_id(@[recordID], &fetchError);
        if (!fetched) {
            return ck_copy_json(@{@"error": fetchError.localizedDescription ?: @"fetch-attachment-failed"});
        }
        CKRecord *record = fetched[recordID];
        if (!record) return ck_copy_json(@{@"error": @"attachment-record-not-found"});
        CKAsset *asset = record[kMindwtrAttachmentAssetField];
        if (![asset isKindOfClass:[CKAsset class]] || !asset.fileURL) {
            return ck_copy_json(@{@"error": @"attachment-asset-missing"});
        }
        NSURL *targetURL = ck_file_url_from_path(targetPath);
        if (!targetURL) return ck_copy_json(@{@"error": @"invalid-attachment-target"});

        NSFileManager *fm = [NSFileManager defaultManager];
        NSError *fileError = nil;
        [fm createDirectoryAtURL:[targetURL URLByDeletingLastPathComponent]
      withIntermediateDirectories:YES
                       attributes:nil
                            error:&fileError];
        if (fileError) return ck_copy_json(@{@"error": fileError.localizedDescription ?: @"attachment-target-directory-failed"});
        if ([fm fileExistsAtPath:targetURL.path]) {
            [fm removeItemAtURL:targetURL error:nil];
        }
        if (![fm copyItemAtURL:asset.fileURL toURL:targetURL error:&fileError]) {
            return ck_copy_json(@{@"error": fileError.localizedDescription ?: @"attachment-copy-failed"});
        }

        NSMutableDictionary *metadata = [ck_attachment_metadata_from_record(record) mutableCopy];
        metadata[@"filePath"] = targetURL.path;
        return ck_copy_json(metadata);
    }
}

char *mindwtr_cloudkit_save_records(const char *record_type_cstr, const char *records_json_cstr) {
    @autoreleasepool {
        if (!record_type_cstr || !records_json_cstr) {
            return ck_copy_json(@{@"conflictIDs": @[]});
        }
        mindwtr_ck_ensure_container();

        NSString *recordType = [NSString stringWithUTF8String:record_type_cstr];
        NSData *jsonData = [[NSString stringWithUTF8String:records_json_cstr] dataUsingEncoding:NSUTF8StringEncoding];
        if (!jsonData) return ck_copy_json(@{@"error": @"invalid-json-input"});

        NSArray<NSDictionary *> *jsonRecords = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:nil];
        if (!jsonRecords || ![jsonRecords isKindOfClass:[NSArray class]] || jsonRecords.count == 0) {
            return ck_copy_json(@{@"conflictIDs": @[]});
        }

        // Step 1: Collect record IDs.
        NSMutableArray<CKRecordID *> *recordIDs = [NSMutableArray array];
        for (NSDictionary *json in jsonRecords) {
            NSString *rid = json[@"id"];
            if ([rid isKindOfClass:[NSString class]] && rid.length > 0) {
                [recordIDs addObject:[[CKRecordID alloc] initWithRecordName:rid zoneID:_ckZoneID]];
            }
        }

        // Step 2: Fetch existing records in batches.
        // Mirrors iOS: unknownItem is silently skipped (new records), but real
        // fetch errors abort the save — otherwise missing records are treated as
        // brand-new CKRecords, dropping server system fields (changeTag).
        NSMutableDictionary<CKRecordID *, CKRecord *> *existingByID = [NSMutableDictionary dictionary];
        for (NSUInteger i = 0; i < recordIDs.count; i += kBatchSize) {
            NSUInteger end = MIN(i + kBatchSize, recordIDs.count);
            NSArray *batch = [recordIDs subarrayWithRange:NSMakeRange(i, end - i)];
            NSError *fetchError = nil;
            NSDictionary *fetched = ck_fetch_records_by_id(batch, &fetchError);
            if (!fetched) {
                return ck_copy_json(@{@"error": fetchError.localizedDescription ?: @"fetch-existing-failed"});
            }
            [existingByID addEntriesFromDictionary:fetched];
        }

        // Step 3: Build CKRecords — reuse fetched when they exist.
        NSMutableArray<CKRecord *> *recordsToSave = [NSMutableArray array];
        for (NSDictionary *json in jsonRecords) {
            NSString *rid = json[@"id"];
            if (![rid isKindOfClass:[NSString class]] || rid.length == 0) continue;

            CKRecordID *recordID = [[CKRecordID alloc] initWithRecordName:rid zoneID:_ckZoneID];
            CKRecord *existing = existingByID[recordID];
            if (existing) {
                ck_apply_fields(json, existing, recordType);
                [recordsToSave addObject:existing];
            } else {
                CKRecord *newRecord = [[CKRecord alloc] initWithRecordType:recordType recordID:recordID];
                ck_apply_fields(json, newRecord, recordType);
                [recordsToSave addObject:newRecord];
            }
        }

        if (recordsToSave.count == 0) return ck_copy_json(@{@"conflictIDs": @[]});

        // Step 4: Save in batches, collecting conflicts.
        NSMutableArray<NSString *> *conflictIDs = [NSMutableArray array];
        NSMutableArray<NSError *> *nonConflictErrors = [NSMutableArray array];

        for (NSUInteger i = 0; i < recordsToSave.count; i += kBatchSize) {
            NSUInteger end = MIN(i + kBatchSize, recordsToSave.count);
            NSArray<CKRecord *> *batch = [recordsToSave subarrayWithRange:NSMakeRange(i, end - i)];

            CKModifyRecordsOperation *saveOp =
                [[CKModifyRecordsOperation alloc] initWithRecordsToSave:batch recordIDsToDelete:nil];
            saveOp.savePolicy = CKRecordSaveChangedKeys;
            saveOp.qualityOfService = NSQualityOfServiceUserInitiated;

            __block NSMutableArray<NSString *> *batchConflicts = [NSMutableArray array];
            __block NSMutableArray<NSError *> *batchErrors = [NSMutableArray array];
            dispatch_semaphore_t sem = dispatch_semaphore_create(0);

            saveOp.modifyRecordsCompletionBlock = ^(NSArray<CKRecord *> *saved __unused,
                                                     NSArray<CKRecordID *> *deleted __unused,
                                                     NSError *error) {
                if (error) {
                    if ([error.domain isEqualToString:CKErrorDomain] &&
                        error.code == CKErrorPartialFailure) {
                        // Extract per-record errors from the partial failure.
                        NSDictionary *partialErrors = error.userInfo[CKPartialErrorsByItemIDKey];
                        for (CKRecordID *failedID in partialErrors) {
                            NSError *perRecordError = partialErrors[failedID];
                            if ([perRecordError.domain isEqualToString:CKErrorDomain] &&
                                perRecordError.code == CKErrorServerRecordChanged) {
                                [batchConflicts addObject:failedID.recordName];
                            } else {
                                [batchErrors addObject:perRecordError];
                            }
                        }
                    } else {
                        [batchErrors addObject:error];
                    }
                }
                dispatch_semaphore_signal(sem);
            };

            [_ckPrivateDB addOperation:saveOp];
            long waited = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, kTimeoutSec * NSEC_PER_SEC));
            if (waited != 0) return ck_copy_json(@{@"error": @"save-timeout"});

            [conflictIDs addObjectsFromArray:batchConflicts];
            [nonConflictErrors addObjectsFromArray:batchErrors];
        }

        if (nonConflictErrors.count > 0) {
            NSMutableDictionary *result = [NSMutableDictionary dictionary];
            result[@"error"] = [[nonConflictErrors firstObject] localizedDescription] ?: @"save-failed";
            result[@"errorCount"] = @(nonConflictErrors.count);
            result[@"conflictIDs"] = conflictIDs;
            return ck_copy_json(result);
        }

        return ck_copy_json(@{@"conflictIDs": conflictIDs});
    }
}

char *mindwtr_cloudkit_delete_records(const char *record_type_cstr __unused,
                                      const char *record_ids_json_cstr) {
    @autoreleasepool {
        if (!record_ids_json_cstr) return ck_success_json();
        mindwtr_ck_ensure_container();

        NSData *jsonData = [[NSString stringWithUTF8String:record_ids_json_cstr] dataUsingEncoding:NSUTF8StringEncoding];
        if (!jsonData) return ck_success_json();
        NSArray<NSString *> *ids = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:nil];
        if (!ids || ![ids isKindOfClass:[NSArray class]] || ids.count == 0) return ck_success_json();

        NSMutableArray<CKRecordID *> *ckIDs = [NSMutableArray arrayWithCapacity:ids.count];
        for (NSString *rid in ids) {
            if ([rid isKindOfClass:[NSString class]] && rid.length > 0) {
                [ckIDs addObject:[[CKRecordID alloc] initWithRecordName:rid zoneID:_ckZoneID]];
            }
        }

        for (NSUInteger i = 0; i < ckIDs.count; i += kBatchSize) {
            NSUInteger end = MIN(i + kBatchSize, ckIDs.count);
            NSArray<CKRecordID *> *batch = [ckIDs subarrayWithRange:NSMakeRange(i, end - i)];

            CKModifyRecordsOperation *op =
                [[CKModifyRecordsOperation alloc] initWithRecordsToSave:nil recordIDsToDelete:batch];
            op.qualityOfService = NSQualityOfServiceUtility;

            __block NSError *opError = nil;
            dispatch_semaphore_t sem = dispatch_semaphore_create(0);

            op.modifyRecordsCompletionBlock = ^(NSArray *saved __unused,
                                                 NSArray *deleted __unused,
                                                 NSError *error) {
                if (error) {
                    if ([error.domain isEqualToString:CKErrorDomain] &&
                        error.code == CKErrorPartialFailure) {
                        // Inspect per-record errors — suppress only unknownItem
                        // (already deleted). Mirror iOS deleteRecords behaviour.
                        NSDictionary *partials = error.userInfo[CKPartialErrorsByItemIDKey];
                        for (CKRecordID *failedID in partials) {
                            NSError *perErr = partials[failedID];
                            if ([perErr.domain isEqualToString:CKErrorDomain] &&
                                perErr.code == CKErrorUnknownItem) {
                                continue; // already deleted — safe to ignore
                            }
                            opError = perErr; // real error — surface it
                            break;
                        }
                    } else {
                        opError = error;
                    }
                }
                dispatch_semaphore_signal(sem);
            };

            [_ckPrivateDB addOperation:op];
            long waited = dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, kTimeoutSec * NSEC_PER_SEC));
            if (waited != 0) return ck_copy_json(@{@"error": @"delete-timeout"});
            if (opError) return ck_error_json(opError);
        }

        return ck_success_json();
    }
}

void mindwtr_cloudkit_register_for_remote_notifications(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        [[NSApplication sharedApplication] registerForRemoteNotifications];
    });
}

void mindwtr_cloudkit_set_pending_remote_change(void) {
    __c11_atomic_store(&_pendingRemoteChange, 1, __ATOMIC_SEQ_CST);
}

int mindwtr_cloudkit_consume_pending_remote_change(void) {
    return __c11_atomic_exchange(&_pendingRemoteChange, 0, __ATOMIC_SEQ_CST);
}

void mindwtr_cloudkit_free_string(char *ptr) {
    if (ptr) free(ptr);
}
