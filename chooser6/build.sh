#!/bin/bash
# Build TRChooser.apk (build only; never installs). Approach copied from trlink/build.sh.
set -e
ROOT=/mnt/d/trailrunner
HERE=$ROOT/chooser6
JDK=$ROOT/twa-build/jdk-17.0.18+8/bin
BT=$ROOT/android-sdk/android-11
ANDROID_JAR=$ROOT/android-sdk/android-7.1.1/android.jar
B=$HERE/build
KS=$B/debug.keystore   # copy of bridge/apk/build/debug.keystore (the key that signed the installed app)

rm -rf $B/classes $B/dex $B/res-compiled $B/gen $B/base.apk $B/unsigned.apk $B/aligned.apk
mkdir -p $B/classes $B/dex $B/res-compiled $B/gen

$BT/aapt2 compile --dir $HERE/res -o $B/res-compiled/
$BT/aapt2 link -o $B/base.apk -I $ANDROID_JAR --manifest $HERE/AndroidManifest.xml --java $B/gen \
  --min-sdk-version 25 --target-sdk-version 25 --version-code 6 --version-name 6.0-chooser \
  $(find $B/res-compiled -name '*.flat')

# NOTE: -cp (not -bootclasspath): lambdas need the JDK java.lang.invoke classes; d8 desugars them for API 25.
$JDK/javac -source 8 -target 8 -Xlint:-options -Xlint:all,-serial -cp $ANDROID_JAR \
  -d $B/classes $(find $HERE/src $B/gen -name '*.java')

$JDK/java -cp $BT/lib/d8.jar com.android.tools.r8.D8 --lib $ANDROID_JAR --min-api 25 \
  --output $B/dex $(find $B/classes -name '*.class')

cp $B/base.apk $B/unsigned.apk
python3 -c "
import zipfile
with zipfile.ZipFile('$B/unsigned.apk','a') as z: z.write('$B/dex/classes.dex','classes.dex')"
$BT/zipalign -f 4 $B/unsigned.apk $B/aligned.apk

$JDK/java -jar $BT/lib/apksigner.jar sign --ks $KS --ks-pass pass:android --key-pass pass:android \
  --ks-key-alias androiddebugkey --v1-signing-enabled true --v2-signing-enabled true \
  --out $HERE/TRChooser.apk $B/aligned.apk
rm -f $HERE/TRChooser.apk.idsig
$JDK/java -jar $BT/lib/apksigner.jar verify --verbose --print-certs $HERE/TRChooser.apk
sha256sum $HERE/TRChooser.apk | tee $HERE/TRChooser.apk.sha256
