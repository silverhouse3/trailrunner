# TR Chooser v5.0 (versionCode 5) -- BUILT, NOT INSTALLED, NOT TESTED ON THE DEVICE

chooser4 plus mode switching through TR Link v2 (bound service, see ../trlink2/README.md). Changes are only in MainActivity
(chooseIfit/chooseTrailRunner/showSwitchFailed/startTrailRunnerBridge) and the new TrLinkClient.java; BootReceiver and everything else unchanged.
* TRAILRUNNER tapped: "Switching to TrailRunner..." (client budget 15 s) -> TR Link set mode=trailrunner -> on success the same bridge start + WebView as before.
* Switch failed or timed out: a set-mode=ifit is queued (so the treadmill ends in iFit mode even if the late switch completes), and a screen says
  "Could not switch to TrailRunner mode / treadmill is in iFit mode" with START IFIT, TRY AGAIN, OPEN TRAILRUNNER ANYWAY (iFit stays on), BACK TO CHOOSER. Never blank.
* iFIT tapped (or 20 s timer): "Switching to iFit..." -> set mode=ifit (max 8 s, continues to HOME on any outcome) -> stop bridge + HOME as before.
* TR Link not installed / bind not answered in 3 s: behaves exactly like chooser4.
* The `--es url` test override with `--ez bridge true` now starts the bridge directly without switching.
Signed with the same debug key as chooser4 (cert 0eaac1ce...), so it upgrades in place. Build: ./build.sh (WSL). Install and rollback: see ../trlink2/README.md.
