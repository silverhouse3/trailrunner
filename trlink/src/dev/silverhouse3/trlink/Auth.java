package dev.silverhouse3.trlink;

import java.nio.charset.Charset;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/** Token hashing and comparison. Only the SHA-256 of the token is ever stored. */
public final class Auth {
    private Auth() {}
    public static final int MIN_TOKEN_LEN = 8;
    public static final int MAX_TOKEN_LEN = 128;
    private static final Charset UTF8 = Charset.forName("UTF-8");

    public static byte[] sha256(String s) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(s.getBytes(UTF8));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    public static String hex(byte[] b) {
        char[] h = "0123456789abcdef".toCharArray();
        char[] o = new char[b.length * 2];
        for (int i = 0; i < b.length; i++) {
            o[i * 2] = h[(b[i] >> 4) & 15];
            o[i * 2 + 1] = h[b[i] & 15];
        }
        return new String(o);
    }

    public static byte[] unhex(String s) {
        if (s == null || s.length() != 64) return null;
        byte[] b = new byte[32];
        for (int i = 0; i < 32; i++) {
            int hi = Character.digit(s.charAt(i * 2), 16);
            int lo = Character.digit(s.charAt(i * 2 + 1), 16);
            if (hi < 0 || lo < 0) return null;
            b[i] = (byte) (hi * 16 + lo);
        }
        return b;
    }

    public static boolean validToken(String t) {
        if (t == null || t.length() < MIN_TOKEN_LEN || t.length() > MAX_TOKEN_LEN) return false;
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (c <= 32 || c >= 127) return false;
        }
        return true;
    }

    /** Constant-time check of an Authorization header value against the stored hash. */
    public static boolean checkHeader(String authHeader, byte[] storedHash) {
        if (storedHash == null || authHeader == null) return false;
        String prefix = "Bearer ";
        if (authHeader.length() <= prefix.length()
                || !authHeader.regionMatches(true, 0, prefix, 0, prefix.length())) {
            // still do a comparison of equal cost
            MessageDigest.isEqual(sha256(""), storedHash);
            return false;
        }
        String supplied = authHeader.substring(prefix.length()).trim();
        return MessageDigest.isEqual(sha256(supplied), storedHash);
    }

    /** A token may be (re)set if none exists yet, or the caller proves knowledge of the old one. */
    public static boolean mayReplace(String storedHex, String oldToken) {
        if (storedHex == null || storedHex.length() == 0) return true;
        byte[] stored = unhex(storedHex);
        if (stored == null) return true; // corrupt value: allow recovery
        return oldToken != null && MessageDigest.isEqual(sha256(oldToken), stored);
    }
}
