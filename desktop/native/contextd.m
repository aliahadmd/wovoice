#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>

// Private, ephemeral editor snapshot. Only bounded snippets leave this process,
// and only for an explicit nearby-text capture. No files, screen reads, or logs.
static AXUIElementRef target = NULL, window = NULL;
static NSString *ticket = nil;
static pid_t owner = 0;
static CFRange selection;
static NSString *originalValue = nil;
static BOOL hasValue = NO;
static id attribute(AXUIElementRef element, CFStringRef name) {
    CFTypeRef value = NULL;
    if (!element || AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess) return nil;
    return CFBridgingRelease(value);
}
static void clearTarget(void) {
    if (target) CFRelease(target);
    if (window) CFRelease(window);
    target = NULL; window = NULL; ticket = nil; owner = 0; hasValue = NO; originalValue = nil;
}
static AXUIElementRef focused(pid_t pid) {
    AXUIElementRef app = AXUIElementCreateApplication(pid);
    AXUIElementSetMessagingTimeout(app, 0.15);
    AXUIElementRef element = NULL;
    AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute, (CFTypeRef *)&element);
    CFRelease(app);
    if (element) AXUIElementSetMessagingTimeout(element, 0.15);
    return element;
}
static BOOL rangeOf(AXUIElementRef element, CFRange *range) {
    id value = attribute(element, kAXSelectedTextRangeAttribute);
    return value && CFGetTypeID((__bridge CFTypeRef)value) == AXValueGetTypeID() &&
        AXValueGetType((__bridge AXValueRef)value) == kAXValueCFRangeType &&
        AXValueGetValue((__bridge AXValueRef)value, kAXValueCFRangeType, range) && range->location >= 0 && range->length >= 0;
}
static BOOL safeElement(AXUIElementRef element) {
    NSString *role = attribute(element, kAXRoleAttribute), *subrole = attribute(element, kAXSubroleAttribute);
    return ![subrole isEqualToString:@"AXSecureTextField"] &&
        ([role isEqualToString:@"AXTextField"] || [role isEqualToString:@"AXTextArea"] || [role isEqualToString:@"AXComboBox"]);
}
static NSDictionary *capture(NSString *level) {
    clearTarget();
    NSRunningApplication *app = NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!AXIsProcessTrusted()) return @{@"available": @NO, @"reason": @"accessibility"};
    if (!app || app.processIdentifier == getpid()) return @{@"available": @NO, @"reason": @"editor"};
    AXUIElementRef element = focused(app.processIdentifier);
    CFRange range;
    if (!element || !safeElement(element) || !rangeOf(element, &range)) {
        if (element) CFRelease(element);
        return @{@"available": @NO, @"reason": @"editor"};
    }
    id value = attribute(element, kAXValueAttribute);
    if (![value isKindOfClass:NSString.class] || (NSUInteger)range.location > [value length] ||
        (NSUInteger)range.length > [value length] - (NSUInteger)range.location) {
        CFRelease(element); return @{@"available": @NO, @"reason": @"editor"};
    }
    target = element; owner = app.processIdentifier; selection = range;
    originalValue = [value copy]; hasValue = YES;
    id focusedWindow = attribute(element, kAXWindowAttribute);
    if (focusedWindow) window = (AXUIElementRef)CFRetain((__bridge CFTypeRef)focusedWindow);
    ticket = NSUUID.UUID.UUIDString;
    NSMutableDictionary *result = [@{@"available": @YES, @"token": ticket, @"appId": app.bundleIdentifier ?: @"", @"field": @"text"} mutableCopy];
    if (![level isEqualToString:@"off"]) {
        NSString *hint = attribute(element, kAXPlaceholderValueAttribute);
        if ([hint isKindOfClass:NSString.class]) result[@"hint"] = [hint substringToIndex:MIN(hint.length, 256)];
        NSString *subrole = attribute(element, kAXSubroleAttribute);
        if ([subrole isEqualToString:@"AXSearchField"]) result[@"field"] = @"search";
    }
    NSUInteger start = (NSUInteger)range.location, end = start + (NSUInteger)range.length;
    NSUInteger left = start > 512 ? start - 512 : 0;
    if (left < start && CFStringIsSurrogateLowCharacter([value characterAtIndex:left])) left++;
    NSUInteger right = end + MIN([value length] - end, 128);
    if (right > end && CFStringIsSurrogateHighCharacter([value characterAtIndex:right - 1])) right--;
    NSString *prefix = [value substringWithRange:NSMakeRange(left, start - left)];
    NSString *suffix = [value substringWithRange:NSMakeRange(end, right - end)];
    NSString *trimmed = [prefix stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
    result[@"sentenceStart"] = (!trimmed.length || [@".!?" rangeOfString:[trimmed substringFromIndex:trimmed.length - 1]].location != NSNotFound || [prefix hasSuffix:@"\n"]) ? @YES : @NO;
    if ([level isEqualToString:@"nearby"]) { result[@"before"] = prefix; result[@"after"] = suffix; }
    return result;
}
static BOOL validate(NSString *token) {
    if (!target || ![ticket isEqualToString:token] || NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != owner) return NO;
    AXUIElementRef current = focused(owner);
    if (!current) return NO;
    BOOL valid = CFEqual(current, target) && safeElement(current);
    CFRange range;
    valid = valid && rangeOf(current, &range) && range.location == selection.location && range.length == selection.length;
    if (valid && window) { id currentWindow = attribute(current, kAXWindowAttribute); valid = currentWindow && CFEqual((__bridge CFTypeRef)currentWindow, window); }
    if (valid && hasValue) { id value = attribute(current, kAXValueAttribute); valid = [value isKindOfClass:NSString.class] && [value isEqualToString:originalValue]; }
    CFRelease(current); return valid;
}
int main(void) {
    @autoreleasepool {
        char *line = NULL; size_t capacity = 0;
        while (getline(&line, &capacity, stdin) > 0) {
            @autoreleasepool {
                NSData *data = [@(line) dataUsingEncoding:NSUTF8StringEncoding];
                NSDictionary *request = data.length <= 4096 ? [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL] : nil;
                if (![request isKindOfClass:NSDictionary.class]) continue;
                NSString *command = request[@"command"];
                NSDictionary *result;
                if ([command isEqualToString:@"capture"]) result = capture(request[@"level"]);
                else if ([command isEqualToString:@"validate"]) result = @{@"valid": validate(request[@"token"]) ? @YES : @NO};
                else { clearTarget(); result = @{}; }
                NSData *out = [NSJSONSerialization dataWithJSONObject:@{@"id": request[@"id"] ?: @0, @"result": result} options:NSJSONWritingFragmentsAllowed error:NULL];
                if (out) { fwrite(out.bytes, 1, out.length, stdout); fputc('\n', stdout); fflush(stdout); }
            }
        }
        free(line); clearTarget();
    }
    return 0;
}
