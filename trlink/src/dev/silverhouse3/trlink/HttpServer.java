package dev.silverhouse3.trlink;

import java.io.BufferedInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.nio.charset.Charset;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/**
 * Minimal hand-rolled HTTP/1.1 server. Every request must carry a valid bearer token.
 * Pure java.* so it can be unit-tested on a plain JVM.
 */
public final class HttpServer {
    public static final int MAX_HEADER_BYTES = 8192;
    public static final int MAX_BODY_BYTES = 1024;
    public static final int READ_TIMEOUT_MS = 5000;
    public static final long TOTAL_READ_BUDGET_MS = 10000;
    private static final Charset ISO = Charset.forName("ISO-8859-1");

    public interface TokenSource { byte[] hash(); }          // SHA-256 of token, or null if none
    public interface Handler { Response handle(String method, String path, Map<String, String> query); }
    public interface Log { void log(String line); }

    public static final class Response {
        public final int status; public final String contentType; public final String body;
        public Response(int status, String contentType, String body) {
            this.status = status; this.contentType = contentType; this.body = body;
        }
        public static Response json(int status, String body) {
            return new Response(status, "application/json; charset=utf-8", body);
        }
        public static Response text(int status, String body) {
            return new Response(status, "text/plain; charset=utf-8", body);
        }
    }

    public static final class Request {
        public String method, path, rawTarget;
        public Map<String, String> query = new HashMap<String, String>();
        public Map<String, String> headers = new HashMap<String, String>();
    }

    /** Thrown by parse(); carries the HTTP status to send. */
    public static final class HttpError extends Exception {
        public final int status;
        public HttpError(int status, String m) { super(m); this.status = status; }
    }

    private final int port;
    private final TokenSource tokens;
    private final Handler handler;
    private final Log log;
    private final RateLimiter limiter;
    private ServerSocket server;
    private ThreadPoolExecutor pool;
    private Thread acceptor;
    private volatile boolean running;

    public HttpServer(int port, TokenSource tokens, Handler handler, Log log, RateLimiter limiter) {
        this.port = port; this.tokens = tokens; this.handler = handler;
        this.log = log; this.limiter = limiter;
    }

    /** Refuses to start when no token has ever been set. */
    public synchronized void start() throws IOException {
        if (running) return;
        if (tokens.hash() == null) throw new IllegalStateException("no token set");
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(true);
        s.bind(new InetSocketAddress(InetAddress.getByAddress(new byte[]{0, 0, 0, 0}), port), 16);
        server = s;
        pool = new ThreadPoolExecutor(2, 4, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<Runnable>(8),
                new ThreadPoolExecutor.AbortPolicy());
        running = true;
        acceptor = new Thread(new Runnable() { public void run() { acceptLoop(); } }, "trlink-accept");
        acceptor.setDaemon(true);
        acceptor.start();
    }

    public synchronized boolean isRunning() { return running; }

    public int getLocalPort() { return server == null ? -1 : server.getLocalPort(); }

    public synchronized void stop() {
        running = false;
        try { if (server != null) server.close(); } catch (IOException ignored) {}
        if (pool != null) pool.shutdownNow();
        server = null; pool = null;
    }

    private void acceptLoop() {
        while (running) {
            final Socket c;
            try { c = server.accept(); } catch (IOException e) { break; }
            try {
                pool.execute(new Runnable() { public void run() { serve(c); } });
            } catch (RejectedExecutionException e) {
                try { c.close(); } catch (IOException ignored) {}
            }
        }
        synchronized (this) { running = false; }
    }

    private void serve(Socket c) {
        String ip = c.getInetAddress() == null ? "?" : c.getInetAddress().getHostAddress();
        try {
            c.setSoTimeout(READ_TIMEOUT_MS);
            Response r;
            String logPath = "-";
            try {
                Request req = parse(new BufferedInputStream(c.getInputStream(), 2048));
                logPath = req.method + " " + req.path;
                r = process(req, ip);
            } catch (HttpError e) {
                r = Response.text(e.status, "");
            }
            write(c.getOutputStream(), r);
            if (log != null) log.log("http " + ip + " " + logPath + " -> " + r.status);
        } catch (IOException e) {
            // timeout / reset: drop silently
        } finally {
            try { c.close(); } catch (IOException ignored) {}
        }
    }

    /** Rate limit, then auth, then route. Package-visible for tests. */
    Response process(Request req, String ip) {
        long now = System.currentTimeMillis();
        if (limiter.blocked(ip, now)) return Response.text(429, "");
        if (!Auth.checkHeader(req.headers.get("authorization"), tokens.hash())) {
            limiter.fail(ip, now);
            return Response.text(401, "");
        }
        return handler.handle(req.method, req.path, req.query);
    }

    public static Request parse(InputStream in) throws IOException, HttpError {
        long deadline = System.nanoTime() + TOTAL_READ_BUDGET_MS * 1000000L;
        byte[] buf = new byte[MAX_HEADER_BYTES];
        int n = 0;
        int state = 0; // matching \r\n\r\n
        while (true) {
            if (System.nanoTime() > deadline) throw new HttpError(408, "slow");
            int b = in.read();
            if (b < 0) throw new HttpError(400, "eof");
            if (n >= MAX_HEADER_BYTES) throw new HttpError(431, "headers too large");
            buf[n++] = (byte) b;
            if ((state == 0 || state == 2) && b == '\r') state++;
            else if ((state == 1 || state == 3) && b == '\n') state++;
            else state = (b == '\r') ? 1 : 0;
            if (state == 4) break;
        }
        String head = new String(buf, 0, n - 4, ISO);
        String[] lines = head.split("\r\n", -1);
        String[] rl = lines[0].split(" ", -1);
        if (rl.length != 3) throw new HttpError(400, "request line");
        if (!rl[2].equals("HTTP/1.1") && !rl[2].equals("HTTP/1.0")) throw new HttpError(505, "version");
        if (!rl[0].matches("[A-Z]{3,7}")) throw new HttpError(400, "method");
        if (!rl[1].startsWith("/") || rl[1].length() > 512) throw new HttpError(400, "target");
        Request r = new Request();
        r.method = rl[0];
        r.rawTarget = rl[1];
        int q = rl[1].indexOf('?');
        r.path = q < 0 ? rl[1] : rl[1].substring(0, q);
        if (q >= 0) {
            for (String kv : rl[1].substring(q + 1).split("&")) {
                if (kv.length() == 0) continue;
                int e = kv.indexOf('=');
                try {
                    String k = URLDecoder.decode(e < 0 ? kv : kv.substring(0, e), "UTF-8");
                    String v = e < 0 ? "" : URLDecoder.decode(kv.substring(e + 1), "UTF-8");
                    r.query.put(k, v);
                } catch (IllegalArgumentException ex) {
                    throw new HttpError(400, "query");
                }
            }
        }
        for (int i = 1; i < lines.length; i++) {
            String l = lines[i];
            int c = l.indexOf(':');
            if (c <= 0) throw new HttpError(400, "header");
            r.headers.put(l.substring(0, c).trim().toLowerCase(java.util.Locale.US), l.substring(c + 1).trim());
        }
        if (r.headers.containsKey("transfer-encoding")) throw new HttpError(501, "te");
        String cl = r.headers.get("content-length");
        if (cl != null) {
            int len;
            try { len = Integer.parseInt(cl); } catch (NumberFormatException e) { throw new HttpError(400, "cl"); }
            if (len < 0) throw new HttpError(400, "cl");
            if (len > MAX_BODY_BYTES) throw new HttpError(413, "body too large");
            for (int i = 0; i < len; i++) { // body is read and discarded; no endpoint uses one
                if (System.nanoTime() > deadline) throw new HttpError(408, "slow");
                if (in.read() < 0) throw new HttpError(400, "eof");
            }
        }
        return r;
    }

    private static String reason(int s) {
        switch (s) {
            case 200: return "OK"; case 400: return "Bad Request"; case 401: return "Unauthorized";
            case 404: return "Not Found"; case 405: return "Method Not Allowed";
            case 408: return "Request Timeout"; case 413: return "Payload Too Large";
            case 429: return "Too Many Requests"; case 431: return "Request Header Fields Too Large";
            case 501: return "Not Implemented"; case 505: return "HTTP Version Not Supported";
            default: return "Error";
        }
    }

    static void write(OutputStream out, Response r) throws IOException {
        byte[] body = r.body == null ? new byte[0] : r.body.getBytes(Charset.forName("UTF-8"));
        StringBuilder h = new StringBuilder();
        h.append("HTTP/1.1 ").append(r.status).append(' ').append(reason(r.status)).append("\r\n");
        h.append("Content-Type: ").append(r.contentType).append("\r\n");
        h.append("Content-Length: ").append(body.length).append("\r\n");
        h.append("Cache-Control: no-store\r\nConnection: close\r\n\r\n");
        out.write(h.toString().getBytes(ISO));
        out.write(body);
        out.flush();
    }
}
