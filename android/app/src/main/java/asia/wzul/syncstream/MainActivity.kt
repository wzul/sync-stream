package asia.wzul.syncstream

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.app.Dialog
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.ViewGroup
import android.view.Window
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

/**
 * A thin shell around the Sync Stream web app.
 *
 * Everything the app does exists to remove a browser restriction:
 *  - `mediaPlaybackRequiresUserGesture = false` — no tap before audio can start, ever;
 *  - a foreground service (PlaybackService) keeps the process — and therefore the WebView's audio —
 *    alive when the app is backgrounded or the screen is off;
 *  - the microphone is granted to the page properly, which is what push-to-talk needs;
 *  - the session cookie is kept, so the password is typed once.
 */
class MainActivity : Activity() {

    companion object {
        const val EXTRA_SETTINGS = "settings"
        private const val MIC_REQUEST = 4711
        private const val PREFS = "syncstream"
        private const val KEY_URL = "url"
    }

    private lateinit var web: WebView
    private lateinit var prefs: SharedPreferences
    private var pendingMic: PermissionRequest? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE)

        // Ask for the notification permission once (Android 13+); without it the playback
        // notification stays hidden but the service still runs.
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission("android.permission.POST_NOTIFICATIONS") != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf("android.permission.POST_NOTIFICATIONS"), 4712)
        }

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.cacheMode = WebSettings.LOAD_DEFAULT
            // the whole point of the app: audible autoplay without a gesture, on every launch
            settings.mediaPlaybackRequiresUserGesture = false
            settings.userAgentString = settings.userAgentString + " SyncStreamApp/1.0"
            webViewClient = WebViewClient()
            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    val mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                        PackageManager.PERMISSION_GRANTED
                    if (mic) {
                        request.grant(request.resources)
                    } else {
                        pendingMic = request
                        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), MIC_REQUEST)
                    }
                }
            }
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

        setContentView(web)

        PlaybackService.webView = web
        startForegroundService(Intent(this, PlaybackService::class.java))

        val url = prefs.getString(KEY_URL, null)
        if (url.isNullOrBlank() || intent.getBooleanExtra(EXTRA_SETTINGS, false)) {
            askForServer(url)
        } else {
            web.loadUrl(url)
        }
    }

    /** First run (and the notification's "Server" action) asks where the stream lives. */
    private fun askForServer(current: String?) {
        val input = EditText(this).apply {
            hint = "https://your-host"
            setText(current ?: BuildConfig.STREAM_URL)
            setSingleLine()
        }
        val pad = (16 * resources.displayMetrics.density).toInt()
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, 0)
            addView(input, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        AlertDialog.Builder(this)
            .setTitle("Sync Stream server")
            .setMessage("The address of your stream. It is remembered, and the page asks for the " +
                "password by itself.")
            .setView(box)
            .setCancelable(false)
            .setPositiveButton("Connect") { _, _ ->
                var url = input.text.toString().trim()
                if (url.isEmpty()) url = BuildConfig.STREAM_URL
                if (!url.startsWith("http")) url = "https://$url"
                prefs.edit().putString(KEY_URL, url).apply()
                web.loadUrl(url)
            }
            .setNegativeButton("Quit") { _, _ -> finish() }
            .show()
    }

    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, permissions, results)
        if (code == MIC_REQUEST) {
            val granted = results.isNotEmpty() && results[0] == PackageManager.PERMISSION_GRANTED
            val req = pendingMic
            pendingMic = null
            if (req != null) {
                if (granted) req.grant(req.resources)
                else {
                    req.deny()
                    Toast.makeText(this, "Microphone denied — the DJ talk button needs it",
                        Toast.LENGTH_LONG).show()
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra(EXTRA_SETTINGS, false)) askForServer(prefs.getString(KEY_URL, null))
    }

    override fun onPause() {
        super.onPause()
        // flush the session cookie so the login survives the app being killed
        CookieManager.getInstance().flush()
    }

    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    override fun onDestroy() {
        if (PlaybackService.webView === web) PlaybackService.webView = null
        super.onDestroy()
    }
}
