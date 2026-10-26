package com.silverhouse3.trailrunnerbridge;

import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.widget.FrameLayout;

/**
 * WebChromeClient for the YouTube pane. Deliberately minimal: no JS dialogs, no permissions (the default
 * implementation denies camera/mic/geolocation), no file chooser. Only HTML5 fullscreen is handled, and it
 * is confined to the LEFT PANE (the fullscreen view is added inside the pane, not the window).
 */
class YtChrome extends WebChromeClient {
    private final MainActivity act;
    private View customView;
    private CustomViewCallback customCb;

    YtChrome(MainActivity a) { act = a; }

    boolean isFullscreen() { return customView != null; }

    @Override
    public void onShowCustomView(View view, CustomViewCallback cb) {
        FrameLayout pane = act.ytPane();
        if (customView != null || pane == null) { cb.onCustomViewHidden(); return; }
        customView = view;
        customCb = cb;
        view.setBackgroundColor(Color.BLACK);
        pane.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT));
        act.onYtFullscreen(true);
    }

    @Override
    public void onHideCustomView() { exitFullscreen(); }

    /** Idempotent; also called when the split closes or the pane is destroyed. */
    void exitFullscreen() {
        View v = customView;
        CustomViewCallback cb = customCb;
        customView = null;
        customCb = null;
        if (v == null) return;
        ViewGroup p = (ViewGroup) v.getParent();
        if (p != null) p.removeView(v);
        if (cb != null) { try { cb.onCustomViewHidden(); } catch (Exception ignore) { /* gone */ } }
        act.onYtFullscreen(false);
    }
}
