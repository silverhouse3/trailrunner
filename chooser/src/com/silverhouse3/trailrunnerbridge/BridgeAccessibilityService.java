package com.silverhouse3.trailrunnerbridge;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Path;
import android.util.Log;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * AccessibilityService that dispatches touch gestures to the treadmill's
 * Compose UI. This is the ONLY method that works for injecting input into
 * Jetpack Compose views — standard input tap/swipe/sendevent all fail.
 *
 * The service is controlled via static methods called from BridgeHttpService.
 */
public class BridgeAccessibilityService extends AccessibilityService {
    private static final String TAG = "TRBridge";
    private static BridgeAccessibilityService instance;

    @Override
    public void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        Log.i(TAG, "AccessibilityService connected");
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // We don't need to process accessibility events
    }

    @Override
    public void onInterrupt() {
        Log.w(TAG, "AccessibilityService interrupted");
    }

    @Override
    public void onDestroy() {
        instance = null;
        super.onDestroy();
    }

    public static boolean isReady() {
        return instance != null;
    }

    /** Dispatch a tap gesture at the given screen coordinates. */
    public static boolean performTap(float x, float y) {
        if (instance == null) return false;

        Path path = new Path();
        path.moveTo(x, y);

        GestureDescription.StrokeDescription stroke =
            new GestureDescription.StrokeDescription(path, 0, 100);

        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(stroke)
            .build();

        return instance.dispatchGesture(gesture, new GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription gestureDescription) {
                Log.d(TAG, "Tap completed at " + x + "," + y);
            }
            @Override
            public void onCancelled(GestureDescription gestureDescription) {
                Log.w(TAG, "Tap cancelled at " + x + "," + y);
            }
        }, null);
    }

    /** Dispatch a swipe gesture. Duration in milliseconds. */
    public static boolean performSwipe(float startX, float startY,
                                       float endX, float endY,
                                       long durationMs) {
        if (instance == null) return false;

        Path path = new Path();
        path.moveTo(startX, startY);
        path.lineTo(endX, endY);

        GestureDescription.StrokeDescription stroke =
            new GestureDescription.StrokeDescription(path, 0, durationMs);

        GestureDescription gesture = new GestureDescription.Builder()
            .addStroke(stroke)
            .build();

        return instance.dispatchGesture(gesture, new GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription gestureDescription) {
                Log.d(TAG, String.format("Swipe completed: (%.0f,%.0f)->(%.0f,%.0f)",
                    startX, startY, endX, endY));
            }
            @Override
            public void onCancelled(GestureDescription gestureDescription) {
                Log.w(TAG, String.format("Swipe cancelled: (%.0f,%.0f)->(%.0f,%.0f)",
                    startX, startY, endX, endY));
            }
        }, null);
    }

    /** Perform BACK global action. */
    public static boolean performBack() {
        if (instance == null) return false;
        return instance.performGlobalAction(GLOBAL_ACTION_BACK);
    }

    /** Perform HOME global action. */
    public static boolean performHome() {
        if (instance == null) return false;
        return instance.performGlobalAction(GLOBAL_ACTION_HOME);
    }

    /** Perform RECENTS global action. */
    public static boolean performRecents() {
        if (instance == null) return false;
        return instance.performGlobalAction(GLOBAL_ACTION_RECENTS);
    }

    /** Get a simple text dump of the current screen's accessibility nodes. */
    public static String getNodeTree() {
        if (instance == null) return "[]";
        AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) return "[]";

        StringBuilder sb = new StringBuilder();
        sb.append("[");
        dumpNode(root, sb, 0);
        sb.append("]");
        root.recycle();
        return sb.toString();
    }

    private static void dumpNode(AccessibilityNodeInfo node, StringBuilder sb, int count) {
        if (node == null || count > 200) return; // Limit to prevent huge dumps

        String text = node.getText() != null ? node.getText().toString() : "";
        String desc = node.getContentDescription() != null ?
            node.getContentDescription().toString() : "";
        String cls = node.getClassName() != null ? node.getClassName().toString() : "";
        boolean clickable = node.isClickable();

        android.graphics.Rect bounds = new android.graphics.Rect();
        node.getBoundsInScreen(bounds);

        if (!text.isEmpty() || !desc.isEmpty() || clickable) {
            if (count > 0) sb.append(",");
            sb.append("{");
            sb.append("\"text\":\"").append(escapeJson(text)).append("\"");
            if (!desc.isEmpty()) {
                sb.append(",\"desc\":\"").append(escapeJson(desc)).append("\"");
            }
            sb.append(",\"class\":\"").append(escapeJson(cls)).append("\"");
            sb.append(",\"clickable\":").append(clickable);
            sb.append(",\"bounds\":[").append(bounds.left).append(",")
                .append(bounds.top).append(",").append(bounds.right).append(",")
                .append(bounds.bottom).append("]");
            sb.append("}");
            count++;
        }

        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo child = node.getChild(i);
            if (child != null) {
                dumpNode(child, sb, count);
                child.recycle();
            }
        }
    }

    private static String escapeJson(String s) {
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }
}
