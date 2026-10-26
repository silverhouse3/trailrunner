package com.silverhouse3.trailrunnerbridge;

import android.net.Uri;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** URL allow-lists for the in-app WebView (navigation, window.open, JS-bridge page guard). */
final class WebPolicy {
    private WebPolicy() { }

    static final String APP_HOST = "silverhouse3.github.io";
    static final String APP_ORIGIN = "https://silverhouse3.github.io";
    static final String APP_PATH_PREFIX = "/trailrunner/";

    /** Hosts a top-level navigation / window.open may go to (https only). */
    private static final Set<String> NAV_HOSTS = new HashSet<>(Arrays.asList(
        "silverhouse3.github.io",
        "strava.com", "www.strava.com",
        "youtube.com", "www.youtube.com", "m.youtube.com",
        "youtube-nocookie.com", "www.youtube-nocookie.com",
        "tile.openstreetmap.org"));

    private static final Set<String> LOCAL_HOSTS = new HashSet<>(Arrays.asList("localhost", "127.0.0.1"));

    /** Host of a dev/test URL passed via the "url" intent extra (e.g. 192.168.100.92). Set by MainActivity. */
    static volatile String testHost = null;

    static String host(Uri u) {
        if (u == null || u.getUserInfo() != null) return null;
        String h = u.getHost();
        return h == null ? null : h.toLowerCase(Locale.ROOT);
    }

    private static Uri parse(String url) {
        try { return url == null ? null : Uri.parse(url); } catch (Exception e) { return null; }
    }

    private static boolean isLocalOrTest(String h) {
        return h != null && (LOCAL_HOSTS.contains(h) || h.equals(testHost));
    }

    /** May the main frame navigate here? https allow-list, plus http(s) for localhost / the test host. */
    static boolean isNavAllowed(Uri u) {
        if (u == null) return false;
        String sc = u.getScheme();
        String h = host(u);
        if (sc == null || h == null) return false;
        sc = sc.toLowerCase(Locale.ROOT);
        if (sc.equals("https") && NAV_HOSTS.contains(h)) return true;
        return (sc.equals("http") || sc.equals("https")) && isLocalOrTest(h);
    }

    static boolean isYoutubeHost(String h) {
        return h != null && (h.equals("youtube.com") || h.endsWith(".youtube.com"));
    }

    /**
     * Is this the TrailRunner web app itself (the only page allowed to use AndroidBridge)?
     * https://silverhouse3.github.io/trailrunner/... or localhost / 127.0.0.1 / the test-override host.
     */
    static boolean isAppPage(String url) {
        Uri u = parse(url);
        if (u == null) return false;
        String sc = u.getScheme();
        String h = host(u);
        if (sc == null || h == null) return false;
        sc = sc.toLowerCase(Locale.ROOT);
        if (sc.equals("https") && h.equals(APP_HOST)) {
            String p = u.getPath();
            return p != null && p.startsWith(APP_PATH_PREFIX);
        }
        return (sc.equals("http") || sc.equals("https")) && isLocalOrTest(h);
    }

    /** Origin string as WebView reports it for PermissionRequest.getOrigin(): "https://host/" or without slash. */
    static boolean isAppOrigin(Uri origin) {
        if (origin == null) return false;
        String sc = origin.getScheme();
        String h = host(origin);
        return "https".equalsIgnoreCase(sc) && APP_HOST.equals(h) && (origin.getPort() == -1 || origin.getPort() == 443);
    }

    /**
     * Convert intent://www.youtube.com/watch?v=ID#Intent;...;end into https://www.youtube.com/watch?v=ID.
     * Returns null if the string is not an intent:// URL.
     */
    static String intentToHttps(String s) {
        if (s == null || !s.regionMatches(true, 0, "intent://", 0, 9)) return null;
        String rest = s.substring(9);
        int i = rest.indexOf("#Intent");
        if (i >= 0) rest = rest.substring(0, i);
        return "https://" + rest;
    }
}
