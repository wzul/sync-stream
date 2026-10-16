package asia.wzul.syncstream

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.graphics.drawable.Icon
import android.content.Intent
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.webkit.WebView
import org.json.JSONObject
import org.json.JSONTokener

/**
 * Keeps the WebView (and therefore its audio) alive while the app is in the background, and puts the
 * room's controls on the lock screen.
 *
 * Android kills background processes; a foreground service with an ongoing notification is the
 * supported way to say "this is still playing". The transport buttons are wired to the page's own
 * buttons, so pausing from the lock screen pauses the room for everyone — exactly like tapping it in
 * the page.
 */
class PlaybackService : Service() {

    companion object {
        @Volatile var webView: WebView? = null
        private const val CHANNEL = "playback"
        private const val NOTIFICATION_ID = 1001
        private const val EXTRA_CLICK = "click"
    }

    private lateinit var session: MediaSession
    private val handler = Handler(Looper.getMainLooper())
    private var playing = false
    private var title = "Sync Stream"
    private var subtitle = ""

    private val poller = object : Runnable {
        override fun run() {
            readPageState()
            handler.postDelayed(this, 4000)
        }
    }

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps the stream playing in the background"
                setShowBadge(false)
            })

        session = MediaSession(this, "SyncStream").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = click("#playBtn")
                override fun onPause() = click("#playBtn")
                override fun onSkipToNext() = click("#nextBtn")
                override fun onSkipToPrevious() = click("#prevBtn")
                override fun onStop() = click("#playBtn")
            })
            isActive = true
        }
        startForeground(NOTIFICATION_ID, buildNotification())
        handler.post(poller)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.getStringExtra(EXTRA_CLICK)?.let { click(it) }
        startForeground(NOTIFICATION_ID, buildNotification())
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        handler.removeCallbacks(poller)
        session.isActive = false
        session.release()
        super.onDestroy()
    }

    private fun js(code: String, then: ((String) -> Unit)? = null) {
        val w = webView ?: return
        handler.post { w.evaluateJavascript(code) { value -> then?.invoke(value ?: "") } }
    }

    /** Tapping the room's own button — the shared control, not a local mute. */
    private fun click(selector: String) {
        js("(function(){var e=document.querySelector('$selector');if(e)e.click();})()")
    }

    /** Ask the page what is playing, so the notification and lock screen tell the truth. */
    private fun readPageState() {
        js(
            "(function(){var p=document.querySelector('#playBtn');" +
                "var t=document.querySelector('#npTitle');var m=document.querySelector('#npMeta');" +
                "return JSON.stringify({p:!!(p&&p.textContent.indexOf('Pause')>=0)," +
                "t:t?t.textContent:'',m:m?m.textContent:''});})()"
        ) { raw ->
            try {
                // evaluateJavascript hands back a JSON-encoded string: decode it, then parse
                val decoded = if (raw.trimStart().startsWith("\"")) {
                    JSONTokener(raw).nextValue().toString()
                } else raw
                val json = JSONObject(decoded)
                playing = json.optBoolean("p", playing)
                val t = json.optString("t", "")
                val m = json.optString("m", "")
                if (t.isNotBlank()) title = t
                if (m.isNotBlank()) subtitle = m
            } catch (e: Exception) {
                // the page is not ready yet — keep the last known state
            }
            updateSessionAndNotification()
        }
    }

    private fun updateSessionAndNotification() {
        session.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, subtitle)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "Sync Stream")
                .build())
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
                        PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or
                        PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_STOP)
                .setState(
                    if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                    PlaybackState.PLAYBACK_POSITION_UNKNOWN, 1f)
                .build())
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification())
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val settings = PendingIntent.getActivity(
            this, 1, Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_SETTINGS, true),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        val builder = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_stream)
            .setContentTitle(title)
            .setContentText(subtitle)
            .setContentIntent(open)
            .setOngoing(playing)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken))
            .addAction(action(if (playing) "Pause" else "Play", "#playBtn", 0))
            .addAction(action("Next", "#nextBtn", 1))
            .addAction(action("Previous", "#prevBtn", 2))
            .addAction(Notification.Action.Builder(
                Icon.createWithResource(this, R.drawable.ic_stat_stream), "Server", settings).build())

        if (Build.VERSION.SDK_INT >= 31) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }
        return builder.build()
    }

    private fun action(label: String, selector: String, code: Int): Notification.Action {
        val intent = Intent(this, PlaybackService::class.java).putExtra(EXTRA_CLICK, selector)
        val pending = PendingIntent.getService(
            this, 100 + code, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return Notification.Action.Builder(
            Icon.createWithResource(this, R.drawable.ic_stat_stream), label, pending).build()
    }
}
