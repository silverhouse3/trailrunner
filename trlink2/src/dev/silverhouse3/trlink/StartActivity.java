package dev.silverhouse3.trlink;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;

/**
 * Invisible (Theme.NoDisplay) entry point. Takes the app out of the "stopped" state,
 * optionally stores a token (--es token T [--es old OLD]) and starts the service. Draws nothing.
 */
public class StartActivity extends Activity {
    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        try {
            Intent in = getIntent();
            String token = in == null ? null : in.getStringExtra("token");
            if (token != null) {
                SharedPreferences sp = getSharedPreferences(LinkService.PREFS, MODE_PRIVATE);
                String old = in.getStringExtra("old");
                if (!Auth.validToken(token)) {
                    sp.edit().putString("lastTokenMsg", "rejected: invalid token (8-128 printable ASCII)").commit();
                } else if (!Auth.mayReplace(sp.getString("tokhash", null), old)) {
                    sp.edit().putString("lastTokenMsg", "rejected: token already set, pass --es old <OLD>").commit();
                } else {
                    sp.edit().putString("tokhash", Auth.hex(Auth.sha256(token)))
                            .putString("lastTokenMsg", "token stored").commit();
                }
            }
            startService(new Intent(this, LinkService.class));
        } catch (RuntimeException e) {
            // fall through to finish()
        }
        finish();
    }
}
