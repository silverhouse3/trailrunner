package com.silverhouse3.trailrunnerbridge;

import java.net.URI;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pure-Java (no android.* imports, unit-testable on a plain JVM) URL policy for the YouTube pane:
 * navigation allow/deny, intent:// and vnd.youtube: conversion to https://m.youtube.com/watch?v=ID,
 * the videoNavigate() allow-list and the "may we persist this as the last URL" rule.
 */
final class YtPolicy {
    private YtPolicy() { }

    static final String HOME = "https://m.youtube.com/";

    enum Kind { ALLOW, CONVERT, BLOCK_SIGNIN, BLOCK }

    static final class Decision {
        final Kind kind;
        /** For ALLOW: the url itself; for CONVERT: the https url to load instead; else null. */
        final String url;
        Decision(Kind k, String u) { kind = k; url = u; }
        @Override public String toString() { return kind + (url == null ? "" : " " + url); }
    }

    /** Top-level navigation hosts in the YouTube pane (https only). */
    private static final Set<String> NAV_HOSTS = new HashSet<>(Arrays.asList(
        "youtube.com", "m.youtube.com", "www.youtube.com", "youtu.be",
        "youtube-nocookie.com", "www.youtube-nocookie.com",
        "ytimg.com", "googlevideo.com", "ggpht.com", "gstatic.com",
        // EU cookie consent: YouTube redirects here first in some regions; the site is unusable without it.
        "consent.youtube.com", "consent.google.com"));

    /** Hosts videoNavigate() (called by the web page) may load. */
    private static final Set<String> VIDEO_HOSTS = new HashSet<>(Arrays.asList(
        "youtube.com", "m.youtube.com", "www.youtube.com",
        "youtube-nocookie.com", "www.youtube-nocookie.com"));

    private static final Set<String> PERSIST_HOSTS = new HashSet<>(Arrays.asList(
        "youtube.com", "m.youtube.com", "www.youtube.com"));

    private static final Set<String> INTENT_HOSTS = new HashSet<>(Arrays.asList(
        "youtube.com", "m.youtube.com", "www.youtube.com", "youtu.be"));

    private static final Pattern ID = Pattern.compile("[A-Za-z0-9_-]{11}");
    private static final Pattern V_PARAM = Pattern.compile("(?:^|[?&])v=([A-Za-z0-9_-]{11})(?:$|[&#])");
    private static final Pattern PATH_ID = Pattern.compile("^/(?:embed|shorts|live|v)/([A-Za-z0-9_-]{11})(?:$|[/?#])");

    static String watchUrl(String id) { return "https://m.youtube.com/watch?v=" + id; }

    /** Strip userinfo-free host from a "scheme://host[:port]/..." remainder; null if suspicious. */
    private static String authorityHost(String authority) {
        if (authority == null || authority.isEmpty()) return null;
        if (authority.indexOf('@') >= 0 || authority.indexOf(':') >= 0 || authority.indexOf('\\') >= 0) return null;
        return authority.toLowerCase(Locale.ROOT);
    }

    /** Video id in a YouTube url / path+query, or null. */
    static String extractVideoId(String hostLower, String pathAndQuery) {
        if (pathAndQuery == null) return null;
        if ("youtu.be".equals(hostLower)) {
            Matcher m = Pattern.compile("^/([A-Za-z0-9_-]{11})(?:$|[/?#])").matcher(pathAndQuery);
            return m.find() ? m.group(1) : null;
        }
        Matcher p = PATH_ID.matcher(pathAndQuery);
        if (p.find()) return p.group(1);
        Matcher q = V_PARAM.matcher(pathAndQuery);
        return q.find() ? q.group(1) : null;
    }

    /**
     * intent://www.youtube.com/watch?v=ID#Intent;...;end  ->  https://m.youtube.com/watch?v=ID
     * vnd.youtube:ID / vnd.youtube://ID / vnd.youtube://www.youtube.com/watch?v=ID -> same.
     * Returns null if s is not such a link or nothing safe can be derived.
     */
    static String intentToHttps(String s) {
        if (s == null) return null;
        if (s.regionMatches(true, 0, "intent://", 0, 9)) {
            String rest = s.substring(9);
            int i = rest.indexOf("#Intent");
            if (i >= 0) rest = rest.substring(0, i);
            int cut = rest.length();
            for (int k = 0; k < rest.length(); k++) {
                char c = rest.charAt(k);
                if (c == '/' || c == '?' || c == '#') { cut = k; break; }
            }
            String host = authorityHost(rest.substring(0, cut));
            if (host == null || !INTENT_HOSTS.contains(host)) return null;
            String tail = rest.substring(cut);
            String id = extractVideoId(host, tail);
            if (id != null) return watchUrl(id);
            if ("youtu.be".equals(host)) return null;
            if (tail.isEmpty()) tail = "/";
            if (tail.charAt(0) == '?') tail = "/" + tail;
            if (tail.charAt(0) != '/') return null;
            return "https://m.youtube.com" + tail;
        }
        if (s.regionMatches(true, 0, "vnd.youtube:", 0, 12)) {
            String rest = s.substring(12);
            while (rest.startsWith("/")) rest = rest.substring(1);
            Matcher m = Pattern.compile("^([A-Za-z0-9_-]{11})(?:$|[?&#/])").matcher(rest);
            if (m.find()) return watchUrl(m.group(1));
            // vnd.youtube://www.youtube.com/watch?v=ID form
            int cut = rest.length();
            for (int k = 0; k < rest.length(); k++) {
                char c = rest.charAt(k);
                if (c == '/' || c == '?' || c == '#') { cut = k; break; }
            }
            String host = authorityHost(rest.substring(0, cut));
            if (host != null && INTENT_HOSTS.contains(host)) {
                String id = extractVideoId(host, rest.substring(cut));
                if (id != null) return watchUrl(id);
            }
            return null;
        }
        return null;
    }

    private static URI parse(String url) {
        try { return url == null ? null : new URI(url); } catch (Exception e) { return null; }
    }

    private static boolean httpsPlain(URI u) {
        return u != null && "https".equalsIgnoreCase(u.getScheme()) && u.getHost() != null
            && u.getUserInfo() == null && (u.getPort() == -1 || u.getPort() == 443);
    }

    /** Decision for a top-level navigation in the YouTube pane. */
    static Decision classifyNav(String url) {
        if (url == null) return new Decision(Kind.BLOCK, null);
        if ("about:blank".equals(url)) return new Decision(Kind.ALLOW, url);
        String conv = intentToHttps(url);
        if (conv != null) {
            Decision d = classifyNav(conv);
            return d.kind == Kind.ALLOW ? new Decision(Kind.CONVERT, d.url) : d;
        }
        URI u = parse(url);
        if (!httpsPlain(u)) return new Decision(Kind.BLOCK, null);   // http:, market:, intent: (unconvertible), data:, javascript:, ...
        String h = u.getHost().toLowerCase(Locale.ROOT);
        if ("accounts.google.com".equals(h)) return new Decision(Kind.BLOCK_SIGNIN, null);
        if (!NAV_HOSTS.contains(h)) return new Decision(Kind.BLOCK, null);
        if ("youtu.be".equals(h)) {
            String pq = u.getRawPath() + (u.getRawQuery() == null ? "" : "?" + u.getRawQuery());
            String id = extractVideoId(h, pq);
            return id == null ? new Decision(Kind.BLOCK, null) : new Decision(Kind.CONVERT, watchUrl(id));
        }
        return new Decision(Kind.ALLOW, url);
    }

    /**
     * Normalised url for AndroidBridge.videoNavigate / videoSplit(start): https on www/m.youtube.com or
     * youtube-nocookie (youtu.be and intent:/vnd.youtube: are expanded first). Null = ignore.
     */
    static String videoTarget(String url) {
        if (url == null) return null;
        Decision d = classifyNav(url.trim());
        String t = d.kind == Kind.ALLOW || d.kind == Kind.CONVERT ? d.url : null;
        if (t == null || "about:blank".equals(t)) return null;
        URI u = parse(t);
        if (!httpsPlain(u) || !VIDEO_HOSTS.contains(u.getHost().toLowerCase(Locale.ROOT))) return null;
        return t;
    }

    /** Only real YouTube pages (not consent / blank) are remembered as the last url. */
    static boolean isPersistable(String url) {
        if (url == null || url.length() > 2000) return false;
        URI u = parse(url);
        return httpsPlain(u) && PERSIST_HOSTS.contains(u.getHost().toLowerCase(Locale.ROOT));
    }

    /** True if url is on the TrailRunner app origin path (pure twin of WebPolicy.isAppPage, for tests). */
    static boolean isTrailRunnerPage(String url, String testHost) {
        URI u = parse(url);
        if (u == null || u.getHost() == null || u.getScheme() == null || u.getUserInfo() != null) return false;
        String sc = u.getScheme().toLowerCase(Locale.ROOT);
        String h = u.getHost().toLowerCase(Locale.ROOT);
        if (sc.equals("https") && h.equals("silverhouse3.github.io")) {
            String p = u.getPath();
            return p != null && p.startsWith("/trailrunner/");
        }
        boolean local = h.equals("localhost") || h.equals("127.0.0.1") || h.equals(testHost);
        return (sc.equals("http") || sc.equals("https")) && local;
    }
}
