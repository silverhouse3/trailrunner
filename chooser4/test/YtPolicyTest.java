package com.silverhouse3.trailrunnerbridge;

/** Plain-JVM test (no Android). Run: see README ("Unit test"). Exit code 1 on failure. */
public class YtPolicyTest {
    static int fails = 0, n = 0;
    static void eq(String what, Object exp, Object got) {
        n++;
        if (exp == null ? got != null : !exp.equals(got)) { fails++; System.out.println("FAIL " + what + ": expected " + exp + " got " + got); }
    }
    static void kind(String url, YtPolicy.Kind k) { eq("kind " + url, k, YtPolicy.classifyNav(url).kind); }

    public static void main(String[] a) {
        String W = "https://m.youtube.com/watch?v=dQw4w9WgXcQ";
        // allow
        for (String u : new String[]{"https://m.youtube.com/", "https://www.youtube.com/results?search_query=a+b", "https://youtube.com/",
            "https://consent.youtube.com/m?continue=https%3A%2F%2Fm.youtube.com%2F", "https://consent.google.com/ml?x=1",
            "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "https://i.ytimg.com.example/", "about:blank"})
            if (!u.contains("example")) kind(u, YtPolicy.Kind.ALLOW);
        kind("https://i.ytimg.com.example/", YtPolicy.Kind.BLOCK);
        kind("https://ytimg.com/vi/x.jpg", YtPolicy.Kind.ALLOW);
        // sign-in and everything else
        kind("https://accounts.google.com/ServiceLogin?service=youtube", YtPolicy.Kind.BLOCK_SIGNIN);
        kind("https://www.google.com/", YtPolicy.Kind.BLOCK);
        kind("https://music.youtube.com/", YtPolicy.Kind.BLOCK);
        kind("https://evil.com/?u=youtube.com", YtPolicy.Kind.BLOCK);
        kind("https://youtube.com.evil.com/", YtPolicy.Kind.BLOCK);
        kind("https://evilyoutube.com/", YtPolicy.Kind.BLOCK);
        kind("https://m.youtube.com@evil.com/", YtPolicy.Kind.BLOCK);
        kind("https://evil.com@m.youtube.com/", YtPolicy.Kind.BLOCK);
        kind("https://m.youtube.com:8443/", YtPolicy.Kind.BLOCK);
        kind("http://m.youtube.com/", YtPolicy.Kind.BLOCK);
        kind("market://details?id=com.google.android.youtube", YtPolicy.Kind.BLOCK);
        kind("javascript:alert(1)", YtPolicy.Kind.BLOCK);
        kind("data:text/html,hi", YtPolicy.Kind.BLOCK);
        kind("file:///sdcard/x", YtPolicy.Kind.BLOCK);
        kind("intent://evil.com/watch?v=dQw4w9WgXcQ#Intent;scheme=https;end", YtPolicy.Kind.BLOCK);
        kind("intent://m.youtube.com@evil.com/#Intent;end", YtPolicy.Kind.BLOCK);
        kind("", YtPolicy.Kind.BLOCK);
        kind(null, YtPolicy.Kind.BLOCK);
        // conversion
        eq("intent watch", W, YtPolicy.classifyNav("intent://www.youtube.com/watch?v=dQw4w9WgXcQ#Intent;scheme=https;package=com.google.android.youtube;end").url);
        eq("intent kind", YtPolicy.Kind.CONVERT, YtPolicy.classifyNav("intent://www.youtube.com/watch?v=dQw4w9WgXcQ#Intent;scheme=https;end").kind);
        eq("intent m. with extra", W, YtPolicy.intentToHttps("intent://m.youtube.com/watch?feature=x&v=dQw4w9WgXcQ&t=5#Intent;end"));
        eq("intent youtu.be", W, YtPolicy.intentToHttps("intent://youtu.be/dQw4w9WgXcQ#Intent;end"));
        eq("intent home", "https://m.youtube.com/", YtPolicy.intentToHttps("intent://www.youtube.com/#Intent;end"));
        eq("intent query only", "https://m.youtube.com/?a=1", YtPolicy.intentToHttps("intent://www.youtube.com?a=1#Intent;end"));
        eq("intent bad host", null, YtPolicy.intentToHttps("intent://evil.com/watch?v=dQw4w9WgXcQ#Intent;end"));
        eq("vnd id", W, YtPolicy.intentToHttps("vnd.youtube:dQw4w9WgXcQ"));
        eq("vnd id slashes", W, YtPolicy.intentToHttps("vnd.youtube://dQw4w9WgXcQ?x=1"));
        eq("vnd full", W, YtPolicy.intentToHttps("vnd.youtube://www.youtube.com/watch?v=dQw4w9WgXcQ"));
        eq("vnd bad", null, YtPolicy.intentToHttps("vnd.youtube:short"));
        eq("not intent", null, YtPolicy.intentToHttps("https://m.youtube.com/"));
        eq("youtu.be nav", W, YtPolicy.classifyNav("https://youtu.be/dQw4w9WgXcQ?t=10").url);
        eq("youtu.be noid", YtPolicy.Kind.BLOCK, YtPolicy.classifyNav("https://youtu.be/").kind);
        eq("shorts id", "dQw4w9WgXcQ", YtPolicy.extractVideoId("m.youtube.com", "/shorts/dQw4w9WgXcQ?x"));
        // videoTarget
        eq("vt ok", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", YtPolicy.videoTarget("https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
        eq("vt youtu.be", W, YtPolicy.videoTarget("https://youtu.be/dQw4w9WgXcQ"));
        eq("vt intent", W, YtPolicy.videoTarget("intent://www.youtube.com/watch?v=dQw4w9WgXcQ#Intent;end"));
        eq("vt nocookie", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", YtPolicy.videoTarget("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"));
        eq("vt consent rejected", null, YtPolicy.videoTarget("https://consent.youtube.com/m"));
        eq("vt ytimg rejected", null, YtPolicy.videoTarget("https://ytimg.com/x"));
        eq("vt http", null, YtPolicy.videoTarget("http://www.youtube.com/"));
        eq("vt other", null, YtPolicy.videoTarget("https://example.com/"));
        eq("vt blank", null, YtPolicy.videoTarget("about:blank"));
        eq("vt empty", null, YtPolicy.videoTarget(""));
        eq("vt null", null, YtPolicy.videoTarget(null));
        eq("vt trim", W, YtPolicy.videoTarget("  " + W + " "));
        // persistable
        eq("p ok", true, YtPolicy.isPersistable(W));
        eq("p consent", false, YtPolicy.isPersistable("https://consent.youtube.com/m"));
        eq("p blank", false, YtPolicy.isPersistable("about:blank"));
        // TR page (escape bar hides only here)
        String T = "https://silverhouse3.github.io/trailrunner/ui-v4/";
        eq("tr ok", true, YtPolicy.isTrailRunnerPage(T, null));
        eq("tr callback", true, YtPolicy.isTrailRunnerPage("https://silverhouse3.github.io/trailrunner/strava-callback.html?code=x", null));
        eq("tr other path", false, YtPolicy.isTrailRunnerPage("https://silverhouse3.github.io/other/", null));
        eq("tr strava", false, YtPolicy.isTrailRunnerPage("https://www.strava.com/oauth/authorize?client_id=1", null));
        eq("tr localhost", true, YtPolicy.isTrailRunnerPage("http://localhost:8080/x", null));
        eq("tr testhost", true, YtPolicy.isTrailRunnerPage("http://192.168.100.92:8000/", "192.168.100.92"));
        eq("tr testhost off", false, YtPolicy.isTrailRunnerPage("http://192.168.100.92:8000/", null));
        eq("tr blank", false, YtPolicy.isTrailRunnerPage("about:blank", null));
        System.out.println(n + " checks, " + fails + " failures");
        System.exit(fails == 0 ? 0 : 1);
    }
}
