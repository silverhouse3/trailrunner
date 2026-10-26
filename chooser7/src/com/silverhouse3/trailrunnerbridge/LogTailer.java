package com.silverhouse3.trailrunnerbridge;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;

/** Pure: byte-offset tail of a file. First poll starts at the END; a shrinking file means rotation -> restart at 0. */
final class LogTailer {
    private final File file;
    private boolean started;
    private long offset;
    /** True if the last poll detected rotation. */
    boolean rotated;

    LogTailer(File f) { file = f; }

    String poll() throws IOException {
        rotated = false;
        try (RandomAccessFile r = new RandomAccessFile(file, "r")) {
            long len = r.length();
            if (!started) { started = true; offset = len; return ""; }
            if (len < offset) { offset = 0; rotated = true; }
            if (len == offset) return "";
            long n = len - offset;
            if (n > 2000000L) { offset = len - 2000000L; n = 2000000L; }
            byte[] buf = new byte[(int) n];
            r.seek(offset);
            r.readFully(buf);
            offset += n;
            return new String(buf, "ISO-8859-1");
        }
    }
}
