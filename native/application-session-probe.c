#include <CoreGraphics/CGSession.h>
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>
#import <AppKit/AppKit.h>

/* Read WindowServer state only. Never emit account/session identifiers. */
static int flag(CFDictionaryRef session, CFStringRef key, int absent) {
  CFTypeRef value = CFDictionaryGetValue(session, key);
  if (!value) return absent;
  if (CFGetTypeID(value) == CFBooleanGetTypeID())
    return CFBooleanGetValue((CFBooleanRef)value) ? 1 : 0;
  if (CFGetTypeID(value) == CFNumberGetTypeID()) {
    int n = 0;
    if (CFNumberGetValue((CFNumberRef)value, kCFNumberIntType, &n)) return n != 0;
  }
  return -1;
}

int main(void) {
  CFDictionaryRef session = CGSessionCopyCurrentDictionary();
  if (!session) {
    puts("{\"onConsole\":false,\"locked\":true}");
    return 0;
  }
  int console = flag(session, kCGSessionOnConsoleKey, -1);
  /* WindowServer omits this flag while unlocked; use its session state rather than IOKit. */
  int locked = flag(session, CFSTR("CGSSessionScreenIsLocked"), 0);
  CFRelease(session);
  CGEventRef event = CGEventCreate(NULL);
  CGPoint point = event ? CGEventGetLocation(event) : CGPointZero;
  if (event) CFRelease(event);
  int pid = NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier;
  printf("{\"onConsole\":%s,\"locked\":%s,\"frontmostPid\":%d,\"pointer\":{\"x\":%.3f,\"y\":%.3f}}\n",
         console == 1 ? "true" : "false", locked == 0 ? "false" : "true", pid, point.x, point.y);
  return 0;
}
