#!/bin/bash
# Build TRLink.apk (build only; never installs). Runs in WSL using Linux tools already in D:\trailrunner.
set -e
ROOT=/mnt/d/trailrunner
HERE=$ROOT/trlink2
JDK=$ROOT/twa-build/jdk-17.0.18+8/bin
BT=$ROOT/android-sdk/android-11            # aapt2, zipalign, lib/d8.jar, lib/apksigner.jar (Linux)
ANDROID_JAR=$ROOT/android-sdk/android-7.1.1/android.jar   # API 25
B=$HERE/build
KS=$B/trlink-debug.keystore

rm -rf $B/classes $B/dex $B/base.apk $B/unsigned.apk $B/aligned.apk
mkdir -p $B/classes $B/dex

# 1. manifest-only resource link (no resources, no R.java)
$BT/aapt2 link -o $B/base.apk -I $ANDROID_JAR --manifest $HERE/AndroidManifest.xml \
  --min-sdk-version 25 --target-sdk-version 25 --version-code 2 --version-name 2.0

# 2. compile against the API 25 android.jar as bootclasspath (flags any API newer than 25)
$JDK/javac -source 8 -target 8 -Xlint:-options -Xlint:all,-serial -bootclasspath $ANDROID_JAR \
  -d $B/classes $HERE/src/dev/silverhouse3/trlink/*.java

# 3. dex
$JDK/java -cp $BT/lib/d8.jar com.android.tools.r8.D8 --lib $ANDROID_JAR --min-api 25 \
  --output $B/dex $(find $B/classes -name '*.class')

# 4. add dex
cp $B/base.apk $B/unsigned.apk
python3 -c "
import zipfile
with zipfile.ZipFile('$B/unsigned.apk','a') as z: z.write('$B/dex/classes.dex','classes.dex')"

# 5. align
$BT/zipalign -f 4 $B/unsigned.apk $B/aligned.apk

# 6. keystore (created once, stays in build/, git-ignored)
if [ ! -f $KS ]; then
  $JDK/keytool -genkeypair -keystore $KS -storepass trlinkdebug -keypass trlinkdebug \
    -alias trlink -keyalg RSA -keysize 2048 -validity 9125 -dname "CN=TR Link, O=silverhouse3"
fi

# 7. sign
$JDK/java -jar $BT/lib/apksigner.jar sign --ks $KS --ks-pass pass:trlinkdebug --key-pass pass:trlinkdebug \
  --ks-key-alias trlink --v1-signing-enabled true --v2-signing-enabled true --out $HERE/TRLink.apk $B/aligned.apk
rm -f $HERE/TRLink.apk.idsig
$JDK/java -jar $BT/lib/apksigner.jar verify --verbose $HERE/TRLink.apk
sha256sum $HERE/TRLink.apk
