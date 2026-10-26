package dev.silverhouse3.trlink;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.Charset;
import java.security.GeneralSecurityException;

/** Minimal ADB host client (CNXN, AUTH, OPEN shell:, WRTE/OKAY/CLSE). One connection per command. Pure java.*. */
public final class AdbClient {
    public static final int A_SYNC = 0x434e5953, A_CNXN = 0x4e584e43, A_AUTH = 0x48545541,
            A_OPEN = 0x4e45504f, A_OKAY = 0x59414b4f, A_CLSE = 0x45534c43, A_WRTE = 0x45545257;
    public static final int VERSION = 0x01000000, MAXDATA = 4096;
    public static final int AUTH_TOKEN = 1, AUTH_SIGNATURE = 2, AUTH_RSAPUBLICKEY = 3;
    static final int MAX_PAYLOAD = 1 << 20;
    private static final Charset UTF8 = Charset.forName("UTF-8");

    public static class AuthException extends IOException {
        public AuthException(String m) { super(m); }
    }

    private final String host;
    private final int port;
    private final AdbKey key;
    private final String keyName;

    public AdbClient(String host, int port, AdbKey key, String keyName) {
        this.host = host; this.port = port; this.key = key; this.keyName = keyName;
    }

    // ---- framing (package-visible for tests) ----

    static long checksum(byte[] d) { long s = 0; for (byte b : d) s += (b & 0xff); return s & 0xffffffffL; }

    static byte[] frame(int cmd, int a0, int a1, byte[] data) {
        if (data == null) data = new byte[0];
        byte[] m = new byte[24 + data.length];
        put(m, 0, cmd); put(m, 4, a0); put(m, 8, a1); put(m, 12, data.length);
        put(m, 16, (int) checksum(data)); put(m, 20, cmd ^ 0xffffffff);
        System.arraycopy(data, 0, m, 24, data.length);
        return m;
    }

    private static void put(byte[] o, int p, int v) {
        o[p] = (byte) v; o[p + 1] = (byte) (v >> 8); o[p + 2] = (byte) (v >> 16); o[p + 3] = (byte) (v >> 24);
    }

    static int get(byte[] b, int p) {
        return (b[p] & 0xff) | (b[p + 1] & 0xff) << 8 | (b[p + 2] & 0xff) << 16 | (b[p + 3] & 0xff) << 24;
    }

    public static final class Msg { public int cmd, arg0, arg1; public byte[] data; }

    static Msg readMsg(DataInputStream in) throws IOException {
        byte[] h = new byte[24];
        in.readFully(h);
        Msg m = new Msg();
        m.cmd = get(h, 0); m.arg0 = get(h, 4); m.arg1 = get(h, 8);
        int len = get(h, 12); int crc = get(h, 16); int magic = get(h, 20);
        if (magic != (m.cmd ^ 0xffffffff)) throw new IOException("bad adb magic");
        if (len < 0 || len > MAX_PAYLOAD) throw new IOException("bad adb length");
        m.data = new byte[len];
        in.readFully(m.data);
        if (crc != 0 && (crc & 0xffffffffL) != checksum(m.data)) throw new IOException("bad adb checksum");
        return m;
    }

    private static void send(OutputStream o, int cmd, int a0, int a1, byte[] data) throws IOException {
        o.write(frame(cmd, a0, a1, data));
        o.flush();
    }

    /**
     * Run "shell:&lt;cmd&gt;" and return its (merged stdout/stderr) output.
     * @param opTimeoutMs overall time allowed once connected; @param authWaitMs time allowed for the user to approve
     * the "Allow USB debugging" prompt (only used the first time the key is offered).
     */
    public String shell(String cmd, int opTimeoutMs, int authWaitMs) throws IOException {
        Socket s = new Socket();
        try {
            s.connect(new InetSocketAddress(host, port), 3000);
            s.setSoTimeout(opTimeoutMs);
            DataInputStream in = new DataInputStream(new java.io.BufferedInputStream(s.getInputStream()));
            OutputStream out = s.getOutputStream();
            send(out, A_CNXN, VERSION, MAXDATA, "host::trlink\0".getBytes(UTF8));
            boolean sentSig = false, sentPub = false, connected = false;
            while (!connected) {
                Msg m = readMsg(in);
                if (m.cmd == A_CNXN) connected = true;
                else if (m.cmd == A_AUTH && m.arg0 == AUTH_TOKEN) {
                    if (!sentSig) {
                        sentSig = true;
                        try { send(out, A_AUTH, AUTH_SIGNATURE, 0, key.sign(m.data)); }
                        catch (GeneralSecurityException e) { throw new IOException("sign failed"); }
                    } else if (!sentPub) {
                        sentPub = true;
                        s.setSoTimeout(Math.max(authWaitMs, opTimeoutMs));
                        send(out, A_AUTH, AUTH_RSAPUBLICKEY, 0, key.adbPublicKeyPayload(keyName));
                    } else {
                        throw new AuthException("adb auth rejected (prompt declined?)");
                    }
                } else if (m.cmd == A_CLSE || m.cmd == A_OKAY) {
                    // ignore stray
                } else throw new IOException("unexpected adb message during connect");
            }
            s.setSoTimeout(opTimeoutMs);
            final int local = 1;
            send(out, A_OPEN, local, 0, ("shell:" + cmd + "\0").getBytes(UTF8));
            ByteArrayOutputStream res = new ByteArrayOutputStream();
            int remote = 0;
            boolean opened = false;
            long deadline = System.currentTimeMillis() + opTimeoutMs;
            while (true) {
                if (System.currentTimeMillis() > deadline) throw new SocketTimeoutException("adb shell overall timeout");
                Msg m = readMsg(in);
                if (m.cmd == A_OKAY) { remote = m.arg0; opened = true; }
                else if (m.cmd == A_WRTE) {
                    if (!opened) { remote = m.arg0; opened = true; }
                    res.write(m.data);
                    send(out, A_OKAY, local, remote, null);
                } else if (m.cmd == A_CLSE) {
                    if (!opened) throw new IOException("adb refused shell");
                    try { send(out, A_CLSE, local, remote, null); } catch (IOException ignored) { }
                    break;
                }
            }
            return new String(res.toByteArray(), UTF8);
        } finally {
            try { s.close(); } catch (IOException ignored) { }
        }
    }
}
