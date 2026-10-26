package dev.silverhouse3.trlink;

import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Binder;
import android.os.IBinder;
import android.os.Parcel;
import android.os.RemoteException;

/**
 * Bound service for the chooser. Raw Binder, transaction 1: in {int mode (1=trailrunner, 0=ifit)},
 * out {int exceptionFlag, int ok, String message}. The caller UID is read with Binder.getCallingUid() and must be
 * the chooser package's UID, shell (2000) or root (0); anything else is refused (SecurityException).
 */
public class SwitchService extends Service {
    public static final String CHOOSER_PKG = "com.silverhouse3.trailrunnerbridge";
    public static final int TX_SET_MODE = 1;
    public static final String DESCRIPTOR = "dev.silverhouse3.trlink.SWITCH";

    private final Binder binder = new Binder() {
        @Override protected boolean onTransact(int code, Parcel data, Parcel reply, int flags) throws RemoteException {
            if (code != TX_SET_MODE) return super.onTransact(code, data, reply, flags);
            int uid = Binder.getCallingUid();
            if (!callerAllowed(uid)) {
                LinkService.switchLog().add("SWITCH refused uid " + uid);
                reply.writeException(new SecurityException("caller not allowed"));
                return true;
            }
            data.enforceInterface(DESCRIPTOR);
            int mode = data.readInt();
            Switcher.Result r = mode == 1 ? LinkService.switcher(SwitchService.this).enterTrailRunnerMode()
                                          : LinkService.switcher(SwitchService.this).exitIfitMode();
            reply.writeNoException();
            reply.writeInt(r.ok ? 1 : 0);
            reply.writeString(r.msg);
            return true;
        }
    };

    private boolean callerAllowed(int uid) {
        if (uid == 2000 || uid == 0) return true;
        try {
            return getPackageManager().getApplicationInfo(CHOOSER_PKG, 0).uid == uid;
        } catch (PackageManager.NameNotFoundException e) { return false; }
    }

    @Override public IBinder onBind(Intent i) { return binder; }
}
