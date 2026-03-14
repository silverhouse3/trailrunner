#!/bin/bash
# Build and optionally deploy TrailRunnerBridge APK
# Usage: ./build.sh [--deploy]
set -e

JAVAC="/mnt/c/Program Files/2conciliate/2c8 Apps/jre/bin/javac.exe"
JAVA="/mnt/c/Program Files/2conciliate/2c8 Apps/jre/bin/java.exe"
BUILD_TOOLS="/mnt/d/trailrunner/android-sdk/android-11"
ANDROID_JAR="/mnt/d/trailrunner/android-sdk/android-7.1.1/android.jar"
APK_SRC="/mnt/d/trailrunner/bridge/apk"
BUILD_DIR="/mnt/d/trailrunner/bridge/apk/build"
ADB="/mnt/d/trailrunner/tools/platform-tools/adb.exe"
TREADMILL_IP="192.168.100.54"

echo "=== Building TrailRunnerBridge APK ==="

# Clean
rm -rf "$BUILD_DIR/classes" "$BUILD_DIR/gen" "$BUILD_DIR/res-compiled"
mkdir -p "$BUILD_DIR/classes" "$BUILD_DIR/gen" "$BUILD_DIR/res-compiled"

# 1. Compile resources
"$BUILD_TOOLS/aapt2" compile --dir "$APK_SRC/app/src/main/res" -o "$BUILD_DIR/res-compiled/"
echo "[1/7] Resources compiled"

# 2. Link resources
RES_FILES=$(find "$BUILD_DIR/res-compiled" -name "*.flat" | tr '\n' ' ')
"$BUILD_TOOLS/aapt2" link \
  -o "$BUILD_DIR/base.apk" \
  -I "$ANDROID_JAR" \
  --manifest "$APK_SRC/app/src/main/AndroidManifest.xml" \
  --java "$BUILD_DIR/gen" \
  $RES_FILES
echo "[2/7] Resources linked"

# 3. Compile Java (using Windows javac with Windows paths)
"$JAVAC" -source 8 -target 8 -Xlint:-options \
  -cp "D:\\trailrunner\\android-sdk\\android-7.1.1\\android.jar" \
  -d "D:\\trailrunner\\bridge\\apk\\build\\classes" \
  "D:\\trailrunner\\bridge\\apk\\build\\gen\\com\\silverhouse3\\trailrunnerbridge\\R.java" \
  "D:\\trailrunner\\bridge\\apk\\app\\src\\main\\java\\com\\silverhouse3\\trailrunnerbridge\\BridgeAccessibilityService.java" \
  "D:\\trailrunner\\bridge\\apk\\app\\src\\main\\java\\com\\silverhouse3\\trailrunnerbridge\\BridgeHttpService.java" \
  "D:\\trailrunner\\bridge\\apk\\app\\src\\main\\java\\com\\silverhouse3\\trailrunnerbridge\\MainActivity.java" \
  "D:\\trailrunner\\bridge\\apk\\app\\src\\main\\java\\com\\silverhouse3\\trailrunnerbridge\\BootReceiver.java"
echo "[3/7] Java compiled"

# 4. DEX
CLASS_FILES=""
for f in $BUILD_DIR/classes/com/silverhouse3/trailrunnerbridge/*.class; do
  WIN_PATH=$(echo "$f" | sed 's|/mnt/d/|D:\\|; s|/|\\|g')
  CLASS_FILES="$CLASS_FILES $WIN_PATH"
done
"$JAVA" -cp "D:\\trailrunner\\android-sdk\\android-11\\lib\\d8.jar" \
  com.android.tools.r8.D8 \
  --lib "D:\\trailrunner\\android-sdk\\android-7.1.1\\android.jar" \
  --output "D:\\trailrunner\\bridge\\apk\\build" \
  --min-api 25 \
  $CLASS_FILES
echo "[4/7] DEXed"

# 5. Add DEX to APK
cp "$BUILD_DIR/base.apk" "$BUILD_DIR/unsigned.apk"
python3 -c "
import zipfile
with zipfile.ZipFile('$BUILD_DIR/unsigned.apk', 'a') as z:
    z.write('$BUILD_DIR/classes.dex', 'classes.dex')
"
echo "[5/7] DEX added"

# 6. Zipalign
"$BUILD_TOOLS/zipalign" -f 4 "$BUILD_DIR/unsigned.apk" "$BUILD_DIR/aligned.apk"
echo "[6/7] Zipaligned"

# 7. Sign
"$JAVA" -jar "D:\\trailrunner\\android-sdk\\android-11\\lib\\apksigner.jar" sign \
  --ks "D:\\trailrunner\\bridge\\apk\\build\\debug.keystore" \
  --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --out "D:\\trailrunner\\bridge\\apk\\build\\trailrunner-bridge.apk" \
  "D:\\trailrunner\\bridge\\apk\\build\\aligned.apk"
echo "[7/7] Signed"

ls -la "$BUILD_DIR/trailrunner-bridge.apk"
echo ""
echo "=== BUILD COMPLETE ==="

# Deploy if requested
if [ "$1" = "--deploy" ]; then
  echo ""
  echo "=== Deploying to treadmill ==="
  "$ADB" connect "$TREADMILL_IP:5555"
  "$ADB" install -r "D:\\trailrunner\\bridge\\apk\\build\\trailrunner-bridge.apk"

  # Re-enable accessibility service
  "$ADB" shell settings put secure enabled_accessibility_services \
    "com.ifit.glassos_service/com.ifit.glassos_appnavigation_service.service.AccessibilityServiceImpl:com.silverhouse3.trailrunnerbridge/.BridgeAccessibilityService"
  "$ADB" shell settings put secure accessibility_enabled 1

  # Grant permissions
  "$ADB" shell appops set com.silverhouse3.trailrunnerbridge SYSTEM_ALERT_WINDOW allow
  "$ADB" shell pm grant com.silverhouse3.trailrunnerbridge android.permission.READ_EXTERNAL_STORAGE 2>/dev/null
  "$ADB" shell pm grant com.silverhouse3.trailrunnerbridge android.permission.WRITE_EXTERNAL_STORAGE 2>/dev/null

  # Start
  "$ADB" shell am start -n com.silverhouse3.trailrunnerbridge/.MainActivity
  echo "=== DEPLOYED ==="
fi
