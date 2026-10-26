package com.silverhouse3.trailrunnerbridge;

import android.app.Dialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.GeolocationPermissions;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/** WebChromeClient for the TrailRunner WebView: dialogs, mic permission, file chooser, fullscreen video. */
class TRChrome extends WebChromeClient {
    private static final String TAG = "TRBridge";
    static final int REQ_AUDIO = 71;
    static final int REQ_STORAGE = 72;
    static final int REQ_FILE = 73;
    private static final int BTN_H_DP = 72;   // >= 72 px on any density >= 1.0

    private final MainActivity act;
    private final float dp;

    private Dialog dialog;
    private Runnable dialogCancel;            // cancels the pending JS result

    private PermissionRequest pendingPerm;
    private ValueCallback<Uri[]> fileCb;

    private View customView;
    private CustomViewCallback customCb;

    TRChrome(MainActivity a) {
        act = a;
        dp = a.getResources().getDisplayMetrics().density;
    }

    private int px(float v) { return (int) (v * dp + 0.5f); }

    // ── JS dialogs ───────────────────────────────────────────────────────────

    @Override
    public boolean onJsAlert(WebView v, String url, String msg, final JsResult r) {
        show(url, msg, false, null, false, r, null);
        return true;
    }

    @Override
    public boolean onJsConfirm(WebView v, String url, String msg, final JsResult r) {
        show(url, msg, false, null, true, r, null);
        return true;
    }

    @Override
    public boolean onJsPrompt(WebView v, String url, String msg, String def, final JsPromptResult r) {
        show(url, msg, true, def, true, r, r);
        return true;
    }

    /** Leaving the page (e.g. Strava OAuth hand-off) must never hang on a before-unload prompt. */
    @Override
    public boolean onJsBeforeUnload(WebView v, String url, String msg, JsResult r) {
        r.confirm();
        return true;
    }

    private void show(String url, String msg, final boolean input, String def, boolean cancelBtn,
                      final JsResult r, final JsPromptResult pr) {
        if (act.isFinishing()) { r.cancel(); return; }
        dismissDialog(true);
        final Dialog d = new Dialog(act);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        d.setCancelable(false);             // Back is ignored app-wide; the buttons are the only way out
        final boolean[] done = {false};

        LinearLayout box = new LinearLayout(act);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(px(28), px(24), px(28), px(24));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#111c33"));
        bg.setCornerRadius(px(20));
        bg.setStroke(px(2), Color.parseColor("#334155"));
        box.setBackground(bg);

        String host = null;
        try { host = Uri.parse(url).getHost(); } catch (Exception ignore) { /* none */ }
        TextView who = new TextView(act);
        who.setText(host == null ? "TrailRunner" : host);
        who.setTextSize(16);
        who.setTextColor(Color.parseColor("#94a3b8"));
        box.addView(who);

        TextView m = new TextView(act);
        m.setText(msg == null ? "" : msg);
        m.setTextSize(24);
        m.setTextColor(Color.WHITE);
        m.setPadding(0, px(14), 0, px(18));
        ScrollView sv = new ScrollView(act);
        sv.addView(m);
        box.addView(sv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT));

        final EditText et;
        if (input) {
            et = new EditText(act);
            et.setText(def == null ? "" : def);
            et.setSelectAllOnFocus(true);
            et.setTextSize(24);
            et.setTextColor(Color.WHITE);
            et.setSingleLine(true);
            GradientDrawable eb = new GradientDrawable();
            eb.setColor(Color.parseColor("#0a1628"));
            eb.setCornerRadius(px(12));
            eb.setStroke(px(2), Color.parseColor("#475569"));
            et.setBackground(eb);
            et.setPadding(px(16), px(12), px(16), px(12));
            box.addView(et, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                px(BTN_H_DP)));
        } else {
            et = null;
        }

        LinearLayout row = new LinearLayout(act);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, px(18), 0, 0);
        if (cancelBtn) {
            TextView no = btn("CANCEL", "#334155");
            no.setOnClickListener(x -> { if (!done[0]) { done[0] = true; r.cancel(); } d.dismiss(); });
            row.addView(no, btnLp());
        }
        TextView ok = btn("OK", "#16a34a");
        ok.setOnClickListener(x -> {
            if (!done[0]) {
                done[0] = true;
                if (pr != null) pr.confirm(et == null ? "" : et.getText().toString()); else r.confirm();
            }
            d.dismiss();
        });
        row.addView(ok, btnLp());
        box.addView(row);

        d.setContentView(box);
        Window w = d.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            int screenW = act.getResources().getDisplayMetrics().widthPixels;
            w.setLayout(Math.min(px(780), (int) (screenW * 0.92f)), ViewGroup.LayoutParams.WRAP_CONTENT);
            w.setGravity(Gravity.CENTER);
            // Keep the ROM bar / immersive state undisturbed: show non-focusable, copy the activity's
            // system-UI flags, then take focus.
            w.setFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
            w.getDecorView().setSystemUiVisibility(act.getWindow().getDecorView().getSystemUiVisibility());
        }
        d.setOnDismissListener(x -> {
            if (dialog == d) { dialog = null; dialogCancel = null; }
            if (!done[0]) { done[0] = true; r.cancel(); }
        });
        dialog = d;
        dialogCancel = () -> { if (!done[0]) { done[0] = true; r.cancel(); } };
        try {
            d.show();
            if (w != null) w.clearFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
            if (et != null) et.requestFocus();
        } catch (Exception e) {
            Log.w(TAG, "dialog show failed", e);
            dialog = null;
            dialogCancel = null;
            if (!done[0]) { done[0] = true; r.cancel(); }
        }
    }

    private TextView btn(String label, String color) {
        TextView b = new TextView(act);
        b.setText(label);
        b.setTextSize(24);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextColor(Color.WHITE);
        b.setGravity(Gravity.CENTER);
        b.setClickable(true);
        b.setFocusable(true);
        GradientDrawable g = new GradientDrawable();
        g.setColor(Color.parseColor(color));
        g.setCornerRadius(px(16));
        b.setBackground(g);
        return b;
    }

    private LinearLayout.LayoutParams btnLp() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, px(BTN_H_DP), 1f);
        lp.setMargins(px(8), 0, px(8), 0);
        return lp;
    }

    private void dismissDialog(boolean cancelResult) {
        Dialog d = dialog;
        Runnable c = dialogCancel;
        dialog = null;
        dialogCancel = null;
        if (cancelResult && c != null) c.run();
        if (d != null) { try { d.dismiss(); } catch (Exception ignore) { /* gone */ } }
    }

    // ── microphone (getUserMedia audio) ──────────────────────────────────────

    @Override
    public void onPermissionRequest(final PermissionRequest req) {
        boolean audioOnly = req.getResources().length > 0;
        for (String res : req.getResources()) {
            if (!PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) audioOnly = false;
        }
        if (!audioOnly || !WebPolicy.isAppOrigin(req.getOrigin())) {
            req.deny();
            return;
        }
        if (act.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            req.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            return;
        }
        if (pendingPerm != null) pendingPerm.deny();
        pendingPerm = req;
        try {
            act.requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, REQ_AUDIO);
        } catch (Exception e) {   // ROM without a permission controller
            Log.w(TAG, "RECORD_AUDIO request failed", e);
            pendingPerm = null;
            req.deny();
            Toast.makeText(act, "Microphone permission unavailable (grant RECORD_AUDIO with adb)", Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public void onPermissionRequestCanceled(PermissionRequest req) {
        if (pendingPerm == req) pendingPerm = null;
    }

    void onPermissionsResult(int code, int[] results) {
        if (code != REQ_AUDIO) return;
        PermissionRequest p = pendingPerm;
        pendingPerm = null;
        if (p == null) return;
        boolean ok = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        try {
            if (ok) p.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE}); else p.deny();
        } catch (Exception e) { Log.w(TAG, "perm result", e); }
    }

    // ── geolocation: deny quietly ────────────────────────────────────────────

    @Override
    public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
        cb.invoke(origin, false, false);
    }

    // ── file chooser (GPX / JSON import) ─────────────────────────────────────

    @Override
    public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
        if (fileCb != null) { fileCb.onReceiveValue(null); fileCb = null; }
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("*/*");   // .gpx/.json have no reliable MIME type in document providers
        if (params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
            i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        Intent chooser = Intent.createChooser(i, "Choose a file");
        if (i.resolveActivity(act.getPackageManager()) == null) {
            cb.onReceiveValue(null);
            Toast.makeText(act, "No file picker on this treadmill - import is unavailable. "
                + "Use the web app on a phone/PC instead.", Toast.LENGTH_LONG).show();
            return true;
        }
        fileCb = cb;
        try {
            act.startActivityForResult(chooser, REQ_FILE);
        } catch (ActivityNotFoundException | SecurityException e) {
            fileCb = null;
            cb.onReceiveValue(null);
            Toast.makeText(act, "No file picker on this treadmill - import is unavailable.", Toast.LENGTH_LONG).show();
        }
        return true;
    }

    void onFileResult(int resultCode, Intent data) {
        ValueCallback<Uri[]> cb = fileCb;
        fileCb = null;
        if (cb == null) return;
        Uri[] res = null;
        try { res = FileChooserParams.parseResult(resultCode, data); } catch (Exception e) { /* cancelled */ }
        cb.onReceiveValue(res);
    }

    // ── HTML5 fullscreen (YouTube embeds) ────────────────────────────────────

    @Override
    public void onShowCustomView(View view, CustomViewCallback cb) {
        if (customView != null) { cb.onCustomViewHidden(); return; }
        customView = view;
        customCb = cb;
        FrameLayout root = act.rootView();
        view.setBackgroundColor(Color.BLACK);
        root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT));
        WebView w = act.webView();
        if (w != null) w.setVisibility(View.INVISIBLE);
        act.hotZoneToFront();
    }

    @Override
    public void onHideCustomView() {
        View v = customView;
        CustomViewCallback cb = customCb;
        customView = null;
        customCb = null;
        if (v != null) {
            ViewGroup p = (ViewGroup) v.getParent();
            if (p != null) p.removeView(v);
        }
        WebView w = act.webView();
        if (w != null) w.setVisibility(View.VISIBLE);
        if (cb != null) { try { cb.onCustomViewHidden(); } catch (Exception ignore) { /* gone */ } }
    }

    @Override
    public boolean onConsoleMessage(ConsoleMessage m) {
        Log.d("TRWeb", m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
        return true;
    }

    /** Called when the WebView is torn down: release everything the page is still waiting on. */
    void cleanup() {
        dismissDialog(true);
        if (pendingPerm != null) { try { pendingPerm.deny(); } catch (Exception ignore) { /* gone */ } pendingPerm = null; }
        if (fileCb != null) { fileCb.onReceiveValue(null); fileCb = null; }
        if (customView != null) onHideCustomView();
    }
}
