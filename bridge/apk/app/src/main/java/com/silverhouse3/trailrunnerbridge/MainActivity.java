package com.silverhouse3.trailrunnerbridge;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Boot chooser — shown on BOOT_COMPLETED and when launched manually.
 * User picks TrailRunner PWA or iFIT (normal operation).
 *
 * If TrailRunner: launches Chrome to the PWA, starts bridge services.
 * If iFIT: finishes immediately, iFIT continues as normal.
 */
public class MainActivity extends Activity {
    private static final String TAG = "TRBridge";
    private static final String PWA_URL = "https://silverhouse3.github.io/trailrunner/";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Keep screen on and show over lock screen
        getWindow().addFlags(
            WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON |
            WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED |
            WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
        );

        // Start HTTP bridge service (always, regardless of choice)
        Intent serviceIntent = new Intent(this, BridgeHttpService.class);
        startService(serviceIntent);

        // Check if accessibility service is enabled
        boolean serviceEnabled = isAccessibilityServiceEnabled();

        // Build the chooser UI
        buildChooserUI(serviceEnabled);

        Log.i(TAG, "Boot chooser shown, accessibility=" + serviceEnabled);
    }

    private void buildChooserUI(boolean accessibilityEnabled) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.parseColor("#0a1628"));
        root.setPadding(80, 60, 80, 60);

        // Title
        TextView title = new TextView(this);
        title.setText("TrailRunner");
        title.setTextSize(42);
        title.setTextColor(Color.WHITE);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setGravity(Gravity.CENTER);
        root.addView(title);

        // Subtitle
        TextView subtitle = new TextView(this);
        subtitle.setText("Choose your workout mode");
        subtitle.setTextSize(18);
        subtitle.setTextColor(Color.parseColor("#94a3b8"));
        subtitle.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        subParams.topMargin = 16;
        subParams.bottomMargin = 60;
        subtitle.setLayoutParams(subParams);
        root.addView(subtitle);

        // Button container
        LinearLayout btnRow = new LinearLayout(this);
        btnRow.setOrientation(LinearLayout.HORIZONTAL);
        btnRow.setGravity(Gravity.CENTER);

        // TrailRunner button
        TextView trBtn = createButton("TrailRunner PWA", "#00d4aa", "#0a1628");
        trBtn.setOnClickListener(v -> launchTrailRunner());
        btnRow.addView(trBtn);

        // Spacer
        View spacer = new View(this);
        LinearLayout.LayoutParams spacerParams = new LinearLayout.LayoutParams(40, 1);
        spacer.setLayoutParams(spacerParams);
        btnRow.addView(spacer);

        // iFIT button
        TextView ifitBtn = createButton("iFIT (Normal)", "#3b82f6", "#0a1628");
        ifitBtn.setOnClickListener(v -> launchIFIT());
        btnRow.addView(ifitBtn);

        root.addView(btnRow);

        // Status info
        if (!accessibilityEnabled) {
            TextView warning = new TextView(this);
            warning.setText("Accessibility service not enabled — gesture control unavailable");
            warning.setTextSize(13);
            warning.setTextColor(Color.parseColor("#f59e0b"));
            warning.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams warnParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            warnParams.topMargin = 40;
            warning.setLayoutParams(warnParams);
            root.addView(warning);
        }

        // Version / port info
        TextView info = new TextView(this);
        info.setText("TR Bridge v3.0 | gRPC :4510 | HTTP :4511 | Accessibility: " +
            (accessibilityEnabled ? "ON" : "OFF"));
        info.setTextSize(12);
        info.setTextColor(Color.parseColor("#64748b"));
        info.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams infoParams = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        infoParams.topMargin = 40;
        info.setLayoutParams(infoParams);
        root.addView(info);

        setContentView(root);
    }

    private TextView createButton(String text, String bgColor, String textColor) {
        TextView btn = new TextView(this);
        btn.setText(text);
        btn.setTextSize(22);
        btn.setTextColor(Color.WHITE);
        btn.setTypeface(Typeface.DEFAULT_BOLD);
        btn.setGravity(Gravity.CENTER);
        btn.setPadding(60, 30, 60, 30);

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor(bgColor));
        bg.setCornerRadius(16);
        btn.setBackground(bg);

        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        btn.setLayoutParams(params);
        btn.setClickable(true);
        btn.setFocusable(true);

        return btn;
    }

    private void launchTrailRunner() {
        Log.i(TAG, "User chose TrailRunner");
        try {
            Intent chrome = new Intent(Intent.ACTION_VIEW, Uri.parse(PWA_URL));
            chrome.setPackage("com.android.chrome");
            chrome.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(chrome);
        } catch (Exception e) {
            // Fallback: try default browser
            Log.w(TAG, "Chrome not available, trying default browser");
            Intent browser = new Intent(Intent.ACTION_VIEW, Uri.parse(PWA_URL));
            browser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(browser);
        }
        finish();
    }

    private void launchIFIT() {
        Log.i(TAG, "User chose iFIT — closing chooser");
        finish();
    }

    private boolean isAccessibilityServiceEnabled() {
        String services = Settings.Secure.getString(
            getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        return services != null &&
            services.contains("com.silverhouse3.trailrunnerbridge/.BridgeAccessibilityService");
    }
}
