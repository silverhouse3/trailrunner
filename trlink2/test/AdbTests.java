import dev.silverhouse3.trlink.*;
import java.io.*;
import java.net.*;
import java.math.BigInteger;
import java.nio.file.*;
import java.security.*;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.RSAPublicKeySpec;
import java.util.*;

public class AdbTests {
    static int pass = 0, fail = 0;
    static void check(String n, boolean ok) { if (ok) pass++; else { fail++; System.out.println("FAIL: " + n); } }
    static final int CNXN = 0x4e584e43, AUTH = 0x48545541, OPEN = 0x4e45504f, OKAY = 0x59414b4f, CLSE = 0x45534c43, WRTE = 0x45545257;

    /** Fake adbd: one-key-trust server. */
    static class FakeAdbd implements Runnable {
        ServerSocket ss; volatile RSAPublicKey trusted; volatile boolean rejectAll = false;
        List<String> cmds = Collections.synchronizedList(new ArrayList<String>());
        volatile int sigAttempts, pubSeen;
        Map<String,String> replies = new HashMap<String,String>();
        FakeAdbd() throws IOException { ss = new ServerSocket(0, 5, InetAddress.getByName("127.0.0.1")); new Thread(this).start(); }
        public void run() { try { while (true) { final Socket s = ss.accept(); new Thread(new Runnable() { public void run() { try { serve(s); } catch (Exception e) { } } }).start(); } } catch (IOException e) { } }
        void serve(Socket s) throws Exception {
            s.setSoTimeout(5000);
            DataInputStream in = new DataInputStream(s.getInputStream()); OutputStream out = s.getOutputStream();
            byte[] hdr = new byte[24]; in.readFully(hdr);
            check("cnxn cmd", g(hdr, 0) == CNXN); check("cnxn ver", g(hdr, 4) == 0x01000000);
            byte[] d = new byte[g(hdr, 12)]; in.readFully(d);
            check("cnxn crc", (g(hdr, 16) & 0xffffffffL) == sum(d)); check("cnxn magic", g(hdr, 20) == ~CNXN);
            check("cnxn banner", new String(d, "US-ASCII").startsWith("host::"));
            boolean ok = false;
            while (!ok) {
                byte[] tok = new byte[20]; new SecureRandom().nextBytes(tok);
                w(out, AUTH, 1, 0, tok);
                byte[] h = new byte[24]; in.readFully(h); byte[] p = new byte[g(h, 12)]; in.readFully(p);
                check("auth cmd", g(h, 0) == AUTH);
                if (g(h, 4) == 2) {
                    sigAttempts++;
                    if (trusted != null && verify(trusted, tok, p)) ok = true;
                } else if (g(h, 4) == 3) {
                    pubSeen++;
                    String txt = new String(p, "US-ASCII");
                    check("pub NUL-terminated + name", txt.endsWith(" test@host\0"));
                    if (!rejectAll) { trusted = parsePub(Base64.getDecoder().decode(txt.substring(0, txt.indexOf(' ')))); ok = true; }
                    else { w(out, AUTH, 1, 0, tok); }   // declined: keep prompting -> client must give up
                    if (rejectAll) return;
                } else return;
            }
            w(out, CNXN, 0x01000000, 4096, "device::ro.product.name=fake;\0".getBytes("US-ASCII"));
            byte[] h = new byte[24]; in.readFully(h); byte[] p = new byte[g(h, 12)]; in.readFully(p);
            check("open cmd", g(h, 0) == OPEN);
            String cmd = new String(p, 0, p.length - 1, "UTF-8"); check("shell: prefix", cmd.startsWith("shell:")); cmd = cmd.substring(6); cmds.add(cmd);
            check("open nul", p[p.length - 1] == 0);
            int local = g(h, 4);
            w(out, OKAY, 77, local, new byte[0]);
            String o = replies.containsKey(cmd) ? replies.get(cmd) : "";
            String[] parts = o.length() > 4 ? new String[]{o.substring(0, 4), o.substring(4)} : new String[]{o};
            for (String part : parts) {
                w(out, WRTE, 77, local, part.getBytes("UTF-8"));
                byte[] a = new byte[24]; in.readFully(a); check("client OKAYs wrte", g(a, 0) == OKAY && g(a, 4) == local && g(a, 8) == 77);
            }
            w(out, CLSE, 77, local, new byte[0]);
        }
    }
    static int g(byte[] b, int p) { return (b[p] & 0xff) | (b[p+1] & 0xff) << 8 | (b[p+2] & 0xff) << 16 | (b[p+3] & 0xff) << 24; }
    static long sum(byte[] d) { long s = 0; for (byte x : d) s += x & 0xff; return s & 0xffffffffL; }
    static void w(OutputStream o, int cmd, int a0, int a1, byte[] d) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(); DataOutputStream x = new DataOutputStream(b);
        int[] v = {cmd, a0, a1, d.length, (int) sum(d), ~cmd};
        for (int i : v) x.writeInt(Integer.reverseBytes(i));
        x.write(d); o.write(b.toByteArray()); o.flush();
    }
    static boolean verify(RSAPublicKey k, byte[] tok, byte[] sig) throws Exception {
        byte[] pre = {0x30,0x21,0x30,0x09,0x06,0x05,0x2b,0x0e,0x03,0x02,0x1a,0x05,0x00,0x04,0x14};
        byte[] in = new byte[35]; System.arraycopy(pre, 0, in, 0, 15); System.arraycopy(tok, 0, in, 15, 20);
        Signature s = Signature.getInstance("NONEwithRSA"); s.initVerify(k); s.update(in); return s.verify(sig);
    }
    static RSAPublicKey parsePub(byte[] st) throws Exception {
        check("pub struct len 524", st.length == 524);
        BigInteger n = BigInteger.ZERO;
        for (int i = 63; i >= 0; i--) n = n.shiftLeft(32).or(BigInteger.valueOf(g(st, 8 + 4 * i) & 0xffffffffL));
        return (RSAPublicKey) KeyFactory.getInstance("RSA").generatePublic(new RSAPublicKeySpec(n, BigInteger.valueOf(g(st, 520))));
    }

    public static void main(String[] a) throws Exception {
        // --- framing / checksum ---
        byte[] f = (byte[]) call("frame", CNXN, 0x01000000, 4096, "host::\0".getBytes());
        check("frame len", f.length == 24 + 7);
        check("frame bytes CNXN", f[0]=='C' && f[1]=='N' && f[2]=='X' && f[3]=='N');
        check("frame magic = ~cmd", g(f, 20) == ~CNXN);
        check("frame crc = byte sum", g(f, 16) == "host::\0".chars().sum());
        check("frame data_length", g(f, 12) == 7);
        check("AUTH ascii", new String(w2(AUTH), "US-ASCII").equals("AUTH"));
        check("WRTE ascii", new String(w2(WRTE), "US-ASCII").equals("WRTE"));
        check("OPEN ascii", new String(w2(OPEN), "US-ASCII").equals("OPEN"));

        // --- public key encoding vs independent python vector ---
        File dir = new File("vec");
        byte[] der = Files.readAllBytes(new File(dir, "test.pk8").toPath());
        File tmp = Files.createTempDirectory("k").toFile(); Files.write(new File(tmp, "adbkey.pk8").toPath(), der); { java.security.interfaces.RSAPrivateCrtKey c = (java.security.interfaces.RSAPrivateCrtKey) java.security.KeyFactory.getInstance("RSA").generatePrivate(new java.security.spec.PKCS8EncodedKeySpec(der)); Files.write(new File(tmp, "adbkey.x509").toPath(), java.security.KeyFactory.getInstance("RSA").generatePublic(new java.security.spec.RSAPublicKeySpec(c.getModulus(), c.getPublicExponent())).getEncoded()); }
        AdbKey key = AdbKey.loadOrCreate(tmp);
        String expect = new String(Files.readAllBytes(new File(dir, "expected_pub.b64").toPath())).trim();
        String got = new String(key.adbPublicKeyPayload("x"), "US-ASCII");
        check("pubkey base64 == python vector", got.equals(expect + " x\0"));
        check("pubkey len 524 (b64 700)", expect.length() == 700);
        // key generation + persistence
        File t2 = Files.createTempDirectory("k2").toFile();
        AdbKey k1 = AdbKey.loadOrCreate(t2), k2 = AdbKey.loadOrCreate(t2);
        check("generated key persisted and reloaded", k1.publicKey().getModulus().equals(k2.publicKey().getModulus()) && k1.publicKey().getModulus().bitLength() == 2048);
        // signature
        byte[] tok = new byte[20]; new Random(1).nextBytes(tok);
        check("signature verifies as sha1-prehashed", verify(key.publicKey(), tok, key.sign(tok)));

        // --- full handshake against fake adbd: unknown key -> pubkey prompt -> accepted; then known key -> sig only ---
        FakeAdbd d = new FakeAdbd();
        d.replies.put("echo trlink", "trlink\n");
        d.replies.put("pm list packages -d", "package:com.ifit.rivendell\npackage:com.x\n");
        AdbClient c = new AdbClient("127.0.0.1", d.ss.getLocalPort(), key, "test@host");
        String r1 = c.shell("echo trlink", 5000, 5000);
        check("first connect output (2 WRTE chunks joined) got=[" + r1 + "]", r1.equals("trlink\n"));
        check("first connect used pubkey", d.pubSeen == 1 && d.sigAttempts == 1);
        String r2 = c.shell("pm list packages -d", 5000, 5000);
        check("second connect no pubkey", d.pubSeen == 1 && d.sigAttempts == 2);
        check("second output", r2.contains("package:com.ifit.rivendell"));
        // declined prompt
        FakeAdbd d2 = new FakeAdbd(); d2.rejectAll = true;
        try { new AdbClient("127.0.0.1", d2.ss.getLocalPort(), key, "test@host").shell("echo trlink", 3000, 3000); check("declined throws", false); }
        catch (AdbClient.AuthException e) { check("declined throws AuthException", true); }
        catch (IOException e) { check("declined throws IOException: " + e, true); }
        // nothing listening
        ServerSocket dead = new ServerSocket(0); int dp = dead.getLocalPort(); dead.close();
        try { new AdbClient("127.0.0.1", dp, key, "k").shell("echo trlink", 1000, 1000); check("refused throws", false); } catch (IOException e) { check("refused throws", true); }

        // --- Switcher over a fake shell ---
        final Set<String> disabled = new LinkedHashSet<String>();
        final List<String> issued = new ArrayList<String>();
        final boolean[] motor = {true}; final boolean[] link = {true}; final int[] motorDieAfter = {-1};
        Switcher.Shell sh = new Switcher.Shell() { public String exec(String cmd) {
            issued.add(cmd);
            if (cmd.equals("pm list packages -d")) { StringBuilder b = new StringBuilder(); for (String s : disabled) b.append("package:").append(s).append("\n"); return b.toString(); }
            String pkg = cmd.substring(cmd.lastIndexOf(' ') + 1);
            if (cmd.startsWith("pm disable-user")) { disabled.add(pkg); if (motorDieAfter[0] >= 0 && disabled.size() == motorDieAfter[0]) motor[0] = false; return "Package " + pkg + " new state: disabled-user\n"; }
            if (cmd.startsWith("pm enable")) { disabled.remove(pkg); motor[0] = true; return "Package " + pkg + " new state: enabled\n"; }
            return "";
        } };
        Switcher.Probe pr = new Switcher.Probe() { public boolean motorOk() { return motor[0]; } public boolean bridgeLinkOk() { return link[0]; } };
        EventRing log = new EventRing(100);
        Switcher sw = new Switcher(sh, pr, log, 0);
        check("initial mode ifit", sw.readMode().equals("ifit"));
        Switcher.Result r = sw.enterTrailRunnerMode();
        check("enter ok", r.ok); check("all three disabled", disabled.size() == 3 && sw.readMode().equals("trailrunner"));
        check("enter only issued allow-listed disable/list", allAllowed(issued));
        check("never touched glassos/launcher", noProtected(issued));
        r = sw.exitIfitMode(); check("exit ok", r.ok && disabled.isEmpty());
        r = sw.exitIfitMode(); check("exit idempotent", r.ok);
        // failure mid-way: motor dies after 2nd disable -> rollback
        motorDieAfter[0] = 2; issued.clear();
        r = sw.enterTrailRunnerMode();
        check("motor failure -> fail", !r.ok); check("motor failure -> rolled back, all enabled", disabled.isEmpty() && r.msg.contains("rolled back"));
        motorDieAfter[0] = -1; motor[0] = true;
        // bridge link bad -> rollback
        link[0] = false; r = sw.enterTrailRunnerMode(); check("link bad -> fail+rollback", !r.ok && disabled.isEmpty()); link[0] = true;
        // motor down at preflight: nothing changed
        motor[0] = false; issued.clear(); r = sw.enterTrailRunnerMode(); check("preflight fail changes nothing", !r.ok && issued.isEmpty()); motor[0] = true;
        // adb failure -> rollback attempted
        final boolean[] boom = {false};
        Switcher.Shell sh2 = new Switcher.Shell() { public String exec(String c) throws IOException { if (boom[0] && c.startsWith("pm disable-user --user 0 com.ifit.gandalf")) throw new IOException("adb down"); return sh.exec(c); } };
        Switcher sw2 = new Switcher(sh2, pr, new EventRing(50), 0); boom[0] = true;
        r = sw2.enterTrailRunnerMode(); boom[0] = false; check("adb error mid-way -> rolled back", !r.ok && disabled.isEmpty());
        // allow-list rejects anything else
        try { Switcher.class.getDeclaredMethod("run", String.class).setAccessible(true);
              java.lang.reflect.Method m = Switcher.class.getDeclaredMethod("run", String.class); m.setAccessible(true);
              m.invoke(sw, "pm disable-user --user 0 com.ifit.glassos_service"); check("allow-list blocks glassos", false); }
        catch (java.lang.reflect.InvocationTargetException e) { check("allow-list blocks glassos", e.getCause() instanceof SecurityException); }
        try { java.lang.reflect.Method m = Switcher.class.getDeclaredMethod("run", String.class); m.setAccessible(true);
              m.invoke(sw, "pm disable-user --user 0 com.ifit.launcher"); check("allow-list blocks launcher", false); }
        catch (java.lang.reflect.InvocationTargetException e) { check("allow-list blocks launcher", e.getCause() instanceof SecurityException); }
        // boot enable-all
        disabled.addAll(Arrays.asList(Switcher.PKGS));
        Switcher sw3 = new Switcher(sh, pr, new EventRing(50), 0);
        sw3.bootEnableAll(3, 1); check("boot enable-all re-enables", disabled.isEmpty());
        // boot retry stops after explicit request
        final int[] tries = {0};
        Switcher.Shell sh4 = new Switcher.Shell() { public String exec(String c) throws IOException { tries[0]++; throw new IOException("adbd not up"); } };
        Switcher sw4 = new Switcher(sh4, pr, new EventRing(50), 0);
        sw4.bootEnableAll(2, 1); check("boot gives up after attempts", tries[0] >= 2 && tries[0] <= 6);
        // ring buffer logging
        check("switch log recorded", log.size() > 5 && log.last(100).toString().contains("rolling back"));

        System.out.println("AdbTests pass=" + pass + " fail=" + fail);
        System.exit(fail == 0 ? 0 : 1);
    }
    static boolean allAllowed(List<String> l) { for (String s : l) if (!(s.equals("pm list packages -d") || s.startsWith("pm disable-user --user 0 com.ifit.") || s.startsWith("pm enable --user 0 com.ifit."))) return false; return true; }
    static boolean noProtected(List<String> l) { for (String s : l) if (s.contains("glassos") || s.contains("launcher")) return false; return true; }
    static byte[] w2(int cmd) { return new byte[]{(byte) cmd, (byte) (cmd >> 8), (byte) (cmd >> 16), (byte) (cmd >> 24)}; }
    static Object call(String name, int a, int b, int c, byte[] d) throws Exception {
        java.lang.reflect.Method m = AdbClient.class.getDeclaredMethod(name, int.class, int.class, int.class, byte[].class); m.setAccessible(true); return m.invoke(null, a, b, c, d);
    }
}
