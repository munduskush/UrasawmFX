# Trade Journal (offline Android app)

Native Android project (Java + WebView) with the whole app bundled in `app/src/main/assets`.
No Expo, no internet needed, all data stays on the device.

Build: push to GitHub -> Actions tab -> "Build APK" -> download the `tradejournal-apk` artifact.
Install on a Chromebook: `adb install -r app-release.apk`  (the `-r` keeps your data when updating).

Tests (optional, need Node): `node tests/core.test.js` and `node tests/parsers.test.js`.
