package dev.silverhouse3.trlink;

import java.util.List;

/** Tiny JSON string helpers (no org.json so it also runs on a plain JVM). */
public final class Json {
    private Json() {}

    public static String str(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20 || c > 0x7e) b.append(String.format("\\u%04x", (int) c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }

    public static String arr(List<String> l) {
        StringBuilder b = new StringBuilder("[");
        for (int i = 0; i < l.size(); i++) {
            if (i > 0) b.append(',');
            b.append(str(l.get(i)));
        }
        return b.append(']').toString();
    }
}
