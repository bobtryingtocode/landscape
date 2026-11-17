#!/bin/bash
# Run once after `npx cap add ios`: registers the landscape:// URL scheme (sign-in links, checkout return),
# drops in the app icon and splash, and sets the display name.
set -e
cd "$(dirname "$0")/.."
PLIST=ios/App/App/Info.plist
if ! /usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" "$PLIST" >/dev/null 2>&1; then
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string com.revvy.landscape" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string landscape" "$PLIST"
  echo "URL scheme landscape:// registered"
fi
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName Landscape" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string Landscape" "$PLIST"
# App icon (Xcode 14+ single-size) and splash
ICON_DIR=ios/App/App/Assets.xcassets/AppIcon.appiconset
if [ -d "$ICON_DIR" ]; then
  cp resources/icon.png "$ICON_DIR/AppIcon-512@2x.png" 2>/dev/null || true
  echo "App icon placed"
fi
SPLASH_DIR=ios/App/App/Assets.xcassets/Splash.imageset
if [ -d "$SPLASH_DIR" ]; then
  for f in "$SPLASH_DIR"/*.png; do cp resources/splash.png "$f"; done
  echo "Splash placed"
fi
echo "Done. Next: npm run ios"
