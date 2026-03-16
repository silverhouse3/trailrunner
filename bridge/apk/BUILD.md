# Building the TrailRunner Bridge APK

## Prerequisites
You need ONE of:
1. **Android Studio** (recommended) — import this as an Android project
2. **Android command-line tools** — `sdkmanager`, `aapt2`, `d8`, `javac`

## Option 1: Android Studio
1. Open Android Studio
2. File → Open → select `/mnt/d/trailrunner/bridge/apk/`
3. Build → Build APK
4. APK will be in `app/build/outputs/apk/`

## Option 2: Command Line (requires Android SDK)

### Install minimal SDK
```powershell
# Download command-line tools from https://developer.android.com/studio#command-line-tools-only
# Extract to D:\Android\cmdline-tools\latest\
D:\Android\cmdline-tools\latest\bin\sdkmanager "platform-tools" "platforms;android-25" "build-tools;30.0.3"
```

### Build
```bash
# Set paths
ANDROID_HOME=D:/Android
BUILD_TOOLS=$ANDROID_HOME/build-tools/30.0.3
PLATFORM=$ANDROID_HOME/platforms/android-25/android.jar

# Compile Java
javac -source 1.8 -target 1.8 -bootclasspath $PLATFORM \
  -d build/classes \
  app/src/main/java/com/silverhouse3/trailrunnerbridge/*.java

# Dex
$BUILD_TOOLS/d8 --output build/ build/classes/com/silverhouse3/trailrunnerbridge/*.class

# Package
$BUILD_TOOLS/aapt2 compile --dir app/src/main/res -o build/res.zip
$BUILD_TOOLS/aapt2 link -o build/unsigned.apk \
  -I $PLATFORM \
  --manifest app/src/main/AndroidManifest.xml \
  build/res.zip

# Add dex
cd build && zip -u unsigned.apk classes.dex && cd ..

# Sign (debug key)
jarsigner -keystore ~/.android/debug.keystore -storepass android \
  build/unsigned.apk androiddebugkey

# Align
$BUILD_TOOLS/zipalign 4 build/unsigned.apk build/trailrunner-bridge.apk
```

## Install on Treadmill
```bash
adb connect 192.168.100.54:5555
adb install build/trailrunner-bridge.apk

# Enable accessibility service
adb shell settings put secure enabled_accessibility_services \
  "com.silverhouse3.trailrunnerbridge/.BridgeAccessibilityService"
adb shell settings put secure accessibility_enabled 1

# Grant permissions
adb shell pm grant com.silverhouse3.trailrunnerbridge android.permission.READ_EXTERNAL_STORAGE
adb shell pm grant com.silverhouse3.trailrunnerbridge android.permission.WRITE_EXTERNAL_STORAGE

# Start
adb shell am start -n com.silverhouse3.trailrunnerbridge/.MainActivity
```

## Test
```bash
# Check if service is running
curl http://192.168.100.54:4511/ping
# Expected: {"ok":true,"service":true}

# Test tap
curl -X POST http://192.168.100.54:4511/tap -d '{"x":75,"y":690}'

# Test swipe
curl -X POST http://192.168.100.54:4511/swipe \
  -d '{"x1":75,"y1":690,"x2":75,"y2":400,"duration":300}'
```
