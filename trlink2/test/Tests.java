import dev.silverhouse3.trlink.*;
import java.io.*;
import java.net.*;
import java.util.*;

public class Tests {
    static int pass = 0, fail = 0;
    static void check(String name, boolean ok) {
        if (ok) pass++; else { fail++; System.out.println("FAIL: " + name); }
    }

    static HttpServer.Request parse(String raw) throws Exception {
        return HttpServer.parse(new ByteArrayInputStream(raw.getBytes("ISO-8859-1")));
    }
    static int parseErr(String raw) {
        try { parse(raw); return 0; } catch (HttpServer.HttpError e) { return e.status; } catch (Exception e) { return -1; }
    }

    static String http(int port, String raw) throws Exception {
        Socket s = new Socket("127.0.0.1", port);
        s.setSoTimeout(5000);
        s.getOutputStream().write(raw.getBytes("ISO-8859-1"));
        s.getOutputStream().flush();
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        byte[] b = new byte[4096]; int n;
        try { while ((n = s.getInputStream().read(b)) > 0) o.write(b, 0, n); } catch (SocketException e) {}
        s.close();
        return o.toString("ISO-8859-1");
    }
    static String status(String resp) { return resp.length() >= 12 ? resp.substring(9, 12) : "???"; }

    public static void main(String[] a) throws Exception {
        // --- ring buffer
        EventRing r = new EventRing(50);
        for (int i = 0; i < 120; i++) r.add(1000L * i, "e" + i);
        check("ring size capped 50", r.size() == 50);
        List<String> l = r.last(50);
        check("ring oldest is e70", l.get(0).endsWith(" e70"));
        check("ring newest is e119", l.get(49).endsWith(" e119"));
        check("ring last(3)", r.last(3).size() == 3 && r.last(3).get(2).endsWith("e119"));
        check("ring ts format", l.get(0).matches("\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ e70"));
        check("ring last(999) bounded", r.last(999).size() == 50);
        EventRing r2 = new EventRing(5); r2.add("x");
        check("ring partial", r2.last(10).size() == 1);

        // --- json
        check("json esc", Json.str("a\"b\\c\nd").equals("\"a\\\"b\\\\c\\nd\""));
        check("json null", Json.str(null).equals("null"));
        check("json arr", Json.arr(Arrays.asList("a", "b")).equals("[\"a\",\"b\"]"));

        // --- auth
        byte[] h = Auth.sha256("secret-token-1");
        check("auth ok", Auth.checkHeader("Bearer secret-token-1", h));
        check("auth ok case-insens scheme", Auth.checkHeader("bearer secret-token-1", h));
        check("auth wrong", !Auth.checkHeader("Bearer secret-token-2", h));
        check("auth missing", !Auth.checkHeader(null, h));
        check("auth no scheme", !Auth.checkHeader("secret-token-1", h));
        check("auth empty bearer", !Auth.checkHeader("Bearer ", h));
        check("auth no stored", !Auth.checkHeader("Bearer secret-token-1", null));
        check("hex roundtrip", Arrays.equals(Auth.unhex(Auth.hex(h)), h));
        check("unhex bad", Auth.unhex("zz") == null);
        check("validToken short", !Auth.validToken("abc"));
        check("validToken space", !Auth.validToken("abcdefgh ijk"));
        check("validToken ok", Auth.validToken("abcdEFGH-1234"));
        check("mayReplace none", Auth.mayReplace(null, null));
        check("mayReplace no old", !Auth.mayReplace(Auth.hex(h), null));
        check("mayReplace bad old", !Auth.mayReplace(Auth.hex(h), "nope"));
        check("mayReplace good old", Auth.mayReplace(Auth.hex(h), "secret-token-1"));

        // --- rate limiter
        RateLimiter rl = new RateLimiter(10, 60000);
        for (int i = 0; i < 9; i++) rl.fail("1.2.3.4", 1000 + i);
        check("rl 9 not blocked", !rl.blocked("1.2.3.4", 2000));
        rl.fail("1.2.3.4", 2001);
        check("rl 10 blocked", rl.blocked("1.2.3.4", 2002));
        check("rl other ip free", !rl.blocked("5.6.7.8", 2002));
        check("rl expires", !rl.blocked("1.2.3.4", 2001 + 60001));

        // --- parser
        HttpServer.Request q = parse("GET /logs?lines=20&x=a%20b HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer t\r\n\r\n");
        check("parse method", q.method.equals("GET"));
        check("parse path", q.path.equals("/logs"));
        check("parse query", "20".equals(q.query.get("lines")) && "a b".equals(q.query.get("x")));
        check("parse header lc", "Bearer t".equals(q.headers.get("authorization")));
        check("parse post body", parse("POST /adb/repair HTTP/1.1\r\nContent-Length: 3\r\n\r\nabc").method.equals("POST"));
        check("parse bad reqline", parseErr("GARBAGE\r\n\r\n") == 400);
        check("parse bad version", parseErr("GET / HTTP/2\r\n\r\n") == 505);
        check("parse lowercase method", parseErr("get / HTTP/1.1\r\n\r\n") == 400);
        check("parse bad header", parseErr("GET / HTTP/1.1\r\nnocolon\r\n\r\n") == 400);
        check("parse chunked rejected", parseErr("POST / HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n") == 501);
        check("parse body too big", parseErr("POST / HTTP/1.1\r\nContent-Length: 999999\r\n\r\n") == 413);
        check("parse bad CL", parseErr("POST / HTTP/1.1\r\nContent-Length: x\r\n\r\n") == 400);
        check("parse truncated body", parseErr("POST / HTTP/1.1\r\nContent-Length: 10\r\n\r\nab") == 400);
        check("parse eof in headers", parseErr("GET / HTTP/1.1\r\nHost: x\r\n") == 400);
        StringBuilder big = new StringBuilder("GET / HTTP/1.1\r\n");
        for (int i = 0; i < 1000; i++) big.append("X-A: aaaaaaaaaaaaaaaaaaaa\r\n");
        check("parse header too large", parseErr(big + "\r\n") == 431);
        check("parse target not slash", parseErr("GET foo HTTP/1.1\r\n\r\n") == 400);
        check("parse bad pct", parseErr("GET /?a=%zz HTTP/1.1\r\n\r\n") == 400);

        // --- no-token refusal
        HttpServer none = new HttpServer(0, new HttpServer.TokenSource() { public byte[] hash() { return null; } },
                null, null, new RateLimiter(10, 60000));
        boolean refused = false;
        try { none.start(); } catch (IllegalStateException e) { refused = true; }
        check("no token => server will not start", refused && !none.isRunning());

        // --- live server on ephemeral port
        final byte[] tok = Auth.sha256("integration-token");
        final List<String> logs = Collections.synchronizedList(new ArrayList<String>());
        HttpServer s = new HttpServer(0, new HttpServer.TokenSource() { public byte[] hash() { return tok; } },
                new HttpServer.Handler() {
                    public HttpServer.Response handle(String m, String p, Map<String, String> qq) {
                        if (p.equals("/status") && m.equals("GET")) return HttpServer.Response.json(200, "{\"ok\":true}");
                        if (p.equals("/status")) return HttpServer.Response.text(405, "");
                        return HttpServer.Response.text(404, "");
                    }
                }, new HttpServer.Log() { public void log(String x) { logs.add(x); } }, new RateLimiter(10, 60000));
        s.start();
        int port = s.getLocalPort();
        String good = http(port, "GET /status HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer integration-token\r\n\r\n");
        check("live 200", status(good).equals("200") && good.endsWith("{\"ok\":true}"));
        check("live Connection: close", good.contains("Connection: close"));
        check("live content-length", good.contains("Content-Length: 11"));
        check("live 404 authed", status(http(port, "GET /nope HTTP/1.1\r\nAuthorization: Bearer integration-token\r\n\r\n")).equals("404"));
        check("live 405 authed", status(http(port, "POST /status HTTP/1.1\r\nAuthorization: Bearer integration-token\r\n\r\n")).equals("405"));
        String nr = http(port, "GET /status HTTP/1.1\r\n\r\n");
        check("live 401 no auth, empty body", status(nr).equals("401") && nr.endsWith("\r\n\r\n") && nr.contains("Content-Length: 0"));
        check("live 400 junk", status(http(port, "JUNK\r\n\r\n")).equals("400"));
        // brute force from 127.0.0.1: 1 failure so far (nr); add 9 more -> blocked
        for (int i = 0; i < 9; i++) http(port, "GET /status HTTP/1.1\r\nAuthorization: Bearer wrong" + i + "\r\n\r\n");
        check("live 429 after 10 failures", status(http(port, "GET /status HTTP/1.1\r\nAuthorization: Bearer wrong\r\n\r\n")).equals("429"));
        check("live 429 even with right token while blocked", status(http(port, "GET /status HTTP/1.1\r\nAuthorization: Bearer integration-token\r\n\r\n")).equals("429"));
        boolean tokenLogged = false;
        for (String x : logs) if (x.contains("integration-token") || x.contains("wrong")) tokenLogged = true;
        check("token never in log", !tokenLogged && logs.size() > 3);
        // slow client / partial request does not hang forever (read timeout)
        Socket slow = new Socket("127.0.0.1", port); slow.setSoTimeout(9000);
        slow.getOutputStream().write("GET /sta".getBytes());
        long t0 = System.currentTimeMillis();
        int rd = slow.getInputStream().read(new byte[10]);
        long dt = System.currentTimeMillis() - t0;
        check("slow client dropped by read timeout (~5s), got EOF/reset", dt < 8000 && rd <= 0);
        slow.close();
        s.stop();
        check("stop", !s.isRunning());

        System.out.println("PASS " + pass + "  FAIL " + fail);
        System.exit(fail == 0 ? 0 : 1);
    }
}
