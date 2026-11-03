package com.aliahad.wovoice.bubble

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.InputMethod
import android.app.KeyguardManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ComponentName
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.view.Gravity
import android.view.WindowManager
import android.view.WindowInsets
import android.view.inputmethod.InputMethodManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.annotation.RequiresApi
import com.aliahad.wovoice.R
import com.aliahad.wovoice.account.AccountResult
import com.aliahad.wovoice.account.SessionManager
import com.aliahad.wovoice.core.EditorSessionGuard
import com.aliahad.wovoice.context.DictationContext
import com.aliahad.wovoice.data.AndroidGraph
import com.aliahad.wovoice.network.TranscriptionClient
import com.aliahad.wovoice.settings.SecretStore
import com.aliahad.wovoice.settings.SettingsStore
import com.aliahad.wovoice.settings.SetupActivity
import com.aliahad.wovoice.settings.androidDeviceName
import com.aliahad.wovoice.ui.dp
import com.aliahad.wovoice.voice.WavRecorder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.lang.ref.WeakReference

/** User-triggered dictation with another IME. Only the focused editable node is inspected. */
class BubbleAccessibilityService : AccessibilityService() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val handler = Handler(Looper.getMainLooper())
    private val sessions = EditorSessionGuard()
    private val client = TranscriptionClient()
    private lateinit var settings: SettingsStore
    private lateinit var account: SessionManager
    private val repository by lazy { AndroidGraph.repository(this) }
    private val windowManager by lazy { getSystemService(WindowManager::class.java) }
    private var bubble: DictationBubbleView? = null
    private var bubbleParams: WindowManager.LayoutParams? = null
    private var removeSettingsListener: (() -> Unit)? = null
    private var recorder: WavRecorder? = null
    private var networkJob: Job? = null
    private var target: FocusedEditor? = null
    private var targetInput: BubbleInputMethod.Target? = null
    private var editorMethod: BubbleInputMethod? = null
    private var captureSession = 0L
    private var state = State.IDLE
    private var activeFile: File? = null
    private var committing = false
    private var foreground = false
    private var appliedX = Int.MIN_VALUE
    private var appliedY = Int.MIN_VALUE
    private var refreshScheduled = false
    private var recordingStartedAt = 0L
    private var captureOwner: String? = null
    private var capturedContext: DictationContext? = null
    private var retry: RetryRecording? = null
    private var screenReceiverRegistered = false
    private val exitingBubbles = mutableSetOf<DictationBubbleView>()
    private val refresh = Runnable { refreshScheduled = false; refreshBubble() }
    private val recordingClock = object : Runnable {
        override fun run() {
            if (state != State.RECORDING) return
            bubble?.setElapsed(SystemClock.elapsedRealtime() - recordingStartedAt)
            handler.postDelayed(this, 250)
        }
    }
    private val expireRetry = Runnable {
        if (retry != null && (state == State.RETRY || state == State.PROCESSING)) {
            cancelWork()
            showMessage("Recording expired", "Speak again", ::startRecording)
        }
    }
    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            when (intent?.action) {
                Intent.ACTION_SCREEN_OFF -> {
                    cancelWork()
                    removeBubble(animate = false)
                }
                Intent.ACTION_SCREEN_ON, Intent.ACTION_USER_PRESENT -> scheduleRefresh(250)
            }
        }
    }

    override fun onServiceConnected() {
        cancelWork()
        removeSettingsListener?.invoke()
        settings = SettingsStore(this)
        account = SessionManager.get(settings, SecretStore(this), { settings.workerUrl }, ::androidDeviceName)
        connectedInstance = WeakReference(this)
        removeSettingsListener = settings.observeFloatingBubble {
            handler.post {
                if (!settings.floatingBubbleEnabled || (state != State.IDLE && !targetIsCurrent())) cancelWork()
                refreshBubble()
            }
        }
        if (!screenReceiverRegistered) {
            val filter = IntentFilter(Intent.ACTION_SCREEN_OFF).apply {
                addAction(Intent.ACTION_SCREEN_ON)
                addAction(Intent.ACTION_USER_PRESENT)
            }
            ContextCompat.registerReceiver(this, screenReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
            screenReceiverRegistered = true
        }
        createChannel()
        // A killed process must not leave audio files from an interrupted capture behind.
        cacheDir.listFiles { file -> file.name.startsWith(FILE_PREFIX) }?.forEach(File::delete)
        refreshBubble()
    }

    @RequiresApi(33)
    override fun onCreateInputMethod(): InputMethod = BubbleInputMethod(this) {
        if (::settings.isInitialized) {
            if (state != State.IDLE && !committing && !targetIsCurrent()) cancelWork()
            scheduleRefresh()
        }
    }.also { editorMethod = it }

    private fun scheduleRefresh(delayMs: Long = 80) {
        if (!refreshScheduled) {
            refreshScheduled = true
            handler.postDelayed(refresh, delayMs)
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (!::settings.isInitialized) return
        if (state != State.IDLE && !committing) {
            val editor = target
            val anotherField = event?.eventType == AccessibilityEvent.TYPE_VIEW_FOCUSED &&
                event.source?.let { it.isEditable && editor?.isSameNode(it) == false } == true
            if (anotherField || !targetIsCurrent()) cancelWork()
        }
        // Throttle instead of restarting a debounce: a changing app must not starve the bubble.
        scheduleRefresh()
    }

    override fun onInterrupt() {
        cancelWork()
        removeBubble()
        scheduleRefresh(160)
    }

    override fun onUnbind(intent: Intent?): Boolean {
        if (connectedInstance?.get() === this) connectedInstance = null
        cancelWork()
        removeBubble(animate = false)
        return super.onUnbind(intent)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_CANCEL) cancelWork()
        stopSelf(startId)
        return START_NOT_STICKY
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        handler.removeCallbacks(refresh)
        refreshScheduled = true
        handler.post(refresh)
    }

    override fun onDestroy() {
        if (connectedInstance?.get() === this) connectedInstance = null
        removeSettingsListener?.invoke()
        if (screenReceiverRegistered) unregisterReceiver(screenReceiver)
        handler.removeCallbacksAndMessages(null)
        cancelWork()
        removeBubble(animate = false)
        exitingBubbles.toList().forEach { if (it.isAttachedToWindow) runCatching { windowManager.removeView(it) } }
        exitingBubbles.clear()
        scope.cancel()
        super.onDestroy()
    }

    private fun inputFocus(): AccessibilityNodeInfo? = runCatching {
        // A tap can make our overlay the active window. Input focus still belongs to the editor.
        findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
    }.getOrNull()

    private fun ownKeyboardSelected(): Boolean = Settings.Secure.getString(
        contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD,
    )?.substringBefore('/') == packageName

    private fun deviceLocked(): Boolean = getSystemService(KeyguardManager::class.java).isKeyguardLocked ||
        !getSystemService(PowerManager::class.java).isInteractive

    private fun targetIsCurrent(): Boolean = !deviceLocked() && !ownKeyboardSelected() &&
        settings.accountId == captureOwner &&
        (Build.VERSION.SDK_INT < 33 || targetInput?.isCurrent() != false) &&
        target?.matches(inputFocus()) == true

    private fun nativeInput(node: AccessibilityNodeInfo?): BubbleInputMethod.Target? =
        if (Build.VERSION.SDK_INT >= 33) editorMethod?.capture(node) else null

    private fun refreshBubble() {
        if (!settings.floatingBubbleEnabled || deviceLocked() || ownKeyboardSelected()) {
            if (state != State.IDLE) cancelWork()
            removeBubble()
            return
        }
        val focused = inputFocus()
        if (focused == null || !FocusedEditor.isSupported(focused, nativeInput(focused) != null)) {
            if (state != State.IDLE && !committing) cancelWork()
            removeBubble()
            return
        }
        if (bubble == null) showBubble()
        bubble?.setPreferences(settings.hapticsEnabled, settings.animationsEnabled, settings.waveformEnabled)
        bubbleParams?.let { params -> clampPosition(params); updatePosition() }
    }

    private fun showBubble() {
        val view = DictationBubbleView(
            this,
            onTap = { if (state == State.RECORDING) finishRecording() else if (state == State.IDLE) startRecording() },
            onCancel = ::cancelWork,
            onHide = {
                settings.floatingBubbleEnabled = false
                Toast.makeText(this, "Bubble hidden. Turn it on again in WoVoice Settings.", Toast.LENGTH_LONG).show()
            },
            onDrag = { dx, dy, finished ->
                bubbleParams?.let { params ->
                    params.x += dx.toInt(); params.y += dy.toInt()
                    clampPosition(params)
                    updatePosition()
                    if (finished) {
                        val bounds = screenBounds()
                        settings.bubblePositionX = params.x.toFloat() / bounds.width().coerceAtLeast(1)
                        settings.bubblePositionY = params.y.toFloat() / bounds.height().coerceAtLeast(1)
                    }
                }
            },
        )
        val bounds = screenBounds()
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.LEFT
            x = (settings.bubblePositionX * bounds.width()).toInt()
            y = (settings.bubblePositionY * bounds.height()).toInt()
            title = "WoVoice dictation bubble"
        }
        bubble = view
        bubbleParams = params
        view.setPreferences(settings.hapticsEnabled, settings.animationsEnabled, settings.waveformEnabled)
        view.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, _, oldRight, _ ->
            if (bubble !== view) return@addOnLayoutChangeListener
            val oldWidth = oldRight - oldLeft
            val newWidth = right - left
            if (oldWidth > 0 && oldWidth != newWidth && params.x + oldWidth / 2 > screenBounds().width() / 2) {
                params.x += oldWidth - newWidth
            }
            if (right > left && bottom > top) { clampPosition(params); updatePosition() }
        }
        clampPosition(params)
        try {
            windowManager.addView(view, params)
            appliedX = params.x
            appliedY = params.y
            view.post { if (bubble === view) { clampPosition(params); updatePosition(); view.animateIn() } }
        } catch (_: RuntimeException) {
            bubble = null
            bubbleParams = null
        }
    }

    private fun screenBounds(): Rect = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        windowManager.currentWindowMetrics.bounds
    } else {
        @Suppress("DEPRECATION")
        android.util.DisplayMetrics().also { windowManager.defaultDisplay.getMetrics(it) }.let {
            Rect(0, 0, it.widthPixels, it.heightPixels)
        }
    }

    private fun clampPosition(params: WindowManager.LayoutParams) {
        val bounds = screenBounds()
        // Overlay y is relative to the usable window; keyboard bounds are screen coordinates.
        val topInset = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            windowManager.currentWindowMetrics.windowInsets.getInsets(WindowInsets.Type.statusBars()).top
        } else {
            @Suppress("DEPRECATION")
            bubble?.rootWindowInsets?.systemWindowInsetTop ?: 0
        }
        val width = (bubble?.width ?: 0).takeIf { it > 0 } ?: dp(100)
        val height = (bubble?.height ?: 0).takeIf { it > 0 } ?: dp(60)
        var bottom = bounds.height() - topInset - dp(40)
        // Stay above the other keyboard; never take input focus to measure it.
        runCatching {
            windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }?.let { keyboard ->
                val rect = Rect()
                keyboard.getBoundsInScreen(rect)
                if (!rect.isEmpty) bottom = minOf(bottom, rect.top - topInset - dp(8))
            }
        }
        params.x = params.x.coerceIn(dp(4), (bounds.width() - width - dp(4)).coerceAtLeast(dp(4)))
        params.y = params.y.coerceIn(dp(12), (bottom - height).coerceAtLeast(dp(12)))
    }

    private fun updatePosition() {
        val view = bubble ?: return
        val params = bubbleParams ?: return
        if (view.isAttachedToWindow && (params.x != appliedX || params.y != appliedY)) {
            runCatching { windowManager.updateViewLayout(view, params) }
            appliedX = params.x
            appliedY = params.y
        }
    }

    private fun removeBubble(animate: Boolean = true) {
        val view = bubble
        bubble = null
        bubbleParams = null
        if (view?.isAttachedToWindow != true) return
        if (animate) {
            exitingBubbles += view
            view.animateOut {
                if (view.isAttachedToWindow) runCatching { windowManager.removeView(view) }
                exitingBubbles -= view
            }
        } else runCatching { windowManager.removeView(view) }
    }

    private fun startRecording() {
        if (state == State.MESSAGE || state == State.RETRY) cancelWork()
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            showMessage("Microphone needed", "Open app", ::openSetup)
            return
        }
        if (!account.signedIn || !account.cloudServicesAllowed) {
            showMessage(if (account.signedIn) "Account unavailable" else "Sign in to dictate", "Open app", ::openSetup)
            return
        }
        val focused = inputFocus()
        val connection = nativeInput(focused)
        val editor = FocusedEditor.capture(focused, connection != null)
        if (editor == null) {
            showMessage("Select a text box first.")
            return
        }
        target = editor
        targetInput = connection
        captureOwner = settings.accountId
        capturedContext = if (Build.VERSION.SDK_INT >= 33 && connection?.allowsContext == false) null else editor.context(settings.contextLevel, settings.contextStyle)
        captureSession = sessions.begin()
        val session = captureSession
        state = State.RECORDING
        recordingStartedAt = SystemClock.elapsedRealtime()
        handler.post(recordingClock)
        bubble?.render(capturedContext?.label?.let { "$it · Tap to finish" } ?: "Tap to finish", recording = true, processing = false)
        try {
            promoteRecording()
            val file = File(cacheDir, "$FILE_PREFIX${System.nanoTime()}.wav")
            activeFile = file
            recorder = WavRecorder(this, file, object : WavRecorder.Callback {
                override fun onStarted() {
                    handler.post { if (sessions.isActive(session)) recordingStartedAt = SystemClock.elapsedRealtime() }
                }
                override fun onLevel(rms: Float) { handler.post { if (sessions.isActive(session)) bubble?.level(rms) } }
                override fun onComplete(result: WavRecorder.RecordingResult) {
                    handler.post { captureComplete(session, result) }
                }
                override fun onError(message: String) {
                    handler.post { if (sessions.isActive(session)) { cancelWork(); showMessage(message, "Speak again", ::startRecording) } }
                }
            }).also(WavRecorder::start)
        } catch (_: RuntimeException) {
            cancelWork()
            showMessage("Microphone unavailable", "Open app", ::openSetup)
        }
    }

    private fun finishRecording() {
        handler.removeCallbacks(recordingClock)
        state = State.PROCESSING
        bubble?.render("Thinking…", recording = false, processing = true)
        recorder?.finish()
    }

    private fun captureComplete(session: Long, result: WavRecorder.RecordingResult) {
        if (!sessions.isActive(session)) { result.file.delete(); return }
        recorder = null
        handler.removeCallbacks(recordingClock)
        stopRecordingNotification()
        if (!targetIsCurrent() || !result.containsSpeech) {
            cancelWork()
            result.file.delete()
            if (!result.containsSpeech) showMessage("No clear speech", "Speak again", ::startRecording)
            return
        }
        processRecording(session, result)
    }

    private fun processRecording(session: Long, result: WavRecorder.RecordingResult) {
        state = State.PROCESSING
        bubble?.render("Thinking…", recording = false, processing = true)
        networkJob = scope.launch {
            try {
                val editor = target ?: return@launch
                val response = withContext(Dispatchers.IO) { transcribe(result.file, editor.sentenceStart) }
                if (!sessions.isActive(session) || !targetIsCurrent()) return@launch
                when (response) {
                    is TranscriptionClient.Result.Success -> {
                        result.file.delete()
                        retry = null
                        capturedContext = null
                        handler.removeCallbacks(expireRetry)
                        val profile = withContext(Dispatchers.IO) { account.loadProfile() }
                        if (!sessions.isActive(session) || !targetIsCurrent()) return@launch
                        if (profile !is AccountResult.Success || !account.cloudServicesAllowed) {
                            showMessage("Check your account", "Open app", ::openSetup)
                            return@launch
                        }
                        committing = true
                        val insertionResult = try {
                            val connection = targetInput
                            if (Build.VERSION.SDK_INT >= 33 && connection != null) connection.insert(editor, response.text, ::inputFocus)
                            else {
                                val focused = inputFocus()
                                withContext(Dispatchers.IO) {
                                    if (editor.isWebContent()) BubbleCommitResult.UNSUPPORTED
                                    else if (editor.insert(response.text, focused)) BubbleCommitResult.ACCEPTED else BubbleCommitResult.REJECTED
                                }
                            }
                        } finally { committing = false }
                        if (insertionResult == BubbleCommitResult.ACCEPTED) {
                            retry = null
                            handler.removeCallbacks(expireRetry)
                            target = null
                            targetInput = null
                            state = State.IDLE
                            renderIdle()
                            // History and analytics count only text accepted by the original editor.
                            withContext(Dispatchers.IO) {
                                repository.recordSuccessfulDictation(response, response.text, result.durationMs, settings.historyEnabled)
                                AndroidGraph.sync(this@BubbleAccessibilityService).syncNow()
                            }
                        } else if (insertionResult == BubbleCommitResult.UNCONFIRMED) {
                            showMessage("Sent to editor", "Check text · Done", ::cancelWork)
                        } else if (insertionResult == BubbleCommitResult.UNSUPPORTED) {
                            showMessage("Editor needs keyboard", "Choose keyboard") {
                                cancelWork()
                                getSystemService(InputMethodManager::class.java).showInputMethodPicker()
                            }
                        } else showMessage("Text changed or field is full", "Speak again", ::startRecording)
                    }
                    is TranscriptionClient.Result.Error -> {
                        account.markRestricted(response.code, response.message)
                        if (!offerRetry(session, result, response.retryable)) {
                            showMessage(if (response.retryable) "Connection failed" else response.message,
                                "Open app", ::openSetup)
                        }
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                showMessage("Dictation failed", "Speak again", ::startRecording)
            } finally {
                val retained = state == State.RETRY && retry?.result?.file == result.file && sessions.isActive(session)
                if (!retained) result.file.delete()
                if (sessions.isActive(session)) {
                    if (!retained) { activeFile = null; capturedContext = null }
                    if (state == State.PROCESSING) {
                        target = null
                        targetInput = null
                        state = State.IDLE
                        renderIdle()
                    }
                    refreshBubble()
                }
            }
        }
    }

    private fun offerRetry(session: Long, result: WavRecorder.RecordingResult, retryable: Boolean): Boolean {
        val now = SystemClock.elapsedRealtime()
        val window = retry?.window ?: BubbleRetryWindow.afterFirstFailure(now)
        if (!sessions.isActive(session) || !targetIsCurrent() || !account.cloudServicesAllowed ||
            !window.allowsRetry(now, retryable)
        ) return false
        retry = RetryRecording(result, window)
        state = State.RETRY
        bubble?.renderMessage("Connection failed", "Retry", ::retryRecording)
        handler.removeCallbacks(expireRetry)
        handler.postDelayed(expireRetry, (window.expiresAtMs - now).coerceAtLeast(1))
        return true
    }

    private fun retryRecording() {
        val pending = retry ?: return
        if (!account.signedIn || !account.cloudServicesAllowed) {
            cancelWork()
            showMessage("Check your account", "Open app", ::openSetup)
            return
        }
        if (!pending.window.allowsRetry(SystemClock.elapsedRealtime(), true) || !targetIsCurrent() || !pending.result.file.exists()) {
            cancelWork()
            showMessage("Select the original text box", "Speak again", ::startRecording)
            return
        }
        retry = pending.copy(window = pending.window.nextAttempt())
        processRecording(captureSession, pending.result)
    }

    private suspend fun transcribe(file: File, sentenceStart: Boolean): TranscriptionClient.Result {
        val auth = account.validAccessToken()
        if (auth is AccountResult.Error) return TranscriptionClient.Result.Error(auth.message, auth.retryable, auth.code, auth.status)
        val token = (auth as AccountResult.Success).value
        val glossary = repository.bestGlossary()
        val context = capturedContext?.takeIf { captureOwner == settings.accountId }?.restricted(settings.contextLevel)?.copy(style = settings.contextStyle)
        if (captureOwner != settings.accountId) return TranscriptionClient.Result.Error("Account changed. Speak again.", false)
        val first = client.transcribe(settings.workerUrl, token, file, sentenceStart, glossary, context)
        if (first !is TranscriptionClient.Result.Error || first.code !in setOf("TOKEN_EXPIRED", "AUTH_REQUIRED")) return first
        return when (val refreshed = account.refreshAfterRejected(token)) {
            is AccountResult.Success -> if (captureOwner != settings.accountId) TranscriptionClient.Result.Error("Account changed. Speak again.", false) else client.transcribe(settings.workerUrl, refreshed.value, file, sentenceStart, glossary, context?.restricted(settings.contextLevel))
            is AccountResult.Error -> TranscriptionClient.Result.Error(refreshed.message, refreshed.retryable, refreshed.code, refreshed.status)
        }
    }

    private fun cancelWork() {
        sessions.invalidate()
        handler.removeCallbacks(recordingClock)
        handler.removeCallbacks(expireRetry)
        recorder?.cancel()
        recorder = null
        networkJob?.cancel()
        networkJob = null
        client.cancel()
        activeFile?.delete()
        activeFile = null
        retry = null
        target = null
        targetInput = null
        captureOwner = null
        capturedContext = null
        state = State.IDLE
        stopRecordingNotification()
        renderIdle()
    }

    private fun renderIdle() = bubble?.render("Tap to speak", recording = false, processing = false)

    private fun showMessage(message: String, actionLabel: String? = null, onAction: (() -> Unit)? = null) {
        val focused = inputFocus()
        val editor = FocusedEditor.capture(focused, nativeInput(focused) != null)
        if (bubble == null || editor == null) {
            Toast.makeText(this, message, Toast.LENGTH_LONG).show()
            return
        }
        target = editor
        targetInput = nativeInput(focused)
        captureOwner = settings.accountId
        state = State.MESSAGE
        bubble?.renderMessage(message, actionLabel, onAction)
    }

    private fun openSetup() {
        cancelWork()
        startActivity(Intent(this, SetupActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(CHANNEL_ID, "Bubble dictation", NotificationManager.IMPORTANCE_LOW))
    }

    private fun promoteRecording() {
        val open = PendingIntent.getActivity(this, 0, Intent(this, SetupActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val cancel = PendingIntent.getService(this, 1, Intent(this, javaClass).setAction(ACTION_CANCEL), PendingIntent.FLAG_IMMUTABLE)
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_mic_small)
            .setContentTitle("WoVoice is listening")
            .setContentText("Tap the bubble to finish, or cancel this recording.")
            .setContentIntent(open)
            .addAction(0, "Cancel", cancel)
            .setOngoing(true).setSilent(true).setCategory(NotificationCompat.CATEGORY_SERVICE).build()
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE else 0)
        foreground = true
    }

    private fun stopRecordingNotification() {
        if (foreground) ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        foreground = false
    }

    private data class RetryRecording(val result: WavRecorder.RecordingResult, val window: BubbleRetryWindow)

    private enum class State { IDLE, RECORDING, PROCESSING, MESSAGE, RETRY }

    companion object {
        @Volatile private var connectedInstance: WeakReference<BubbleAccessibilityService>? = null
        private const val FILE_PREFIX = "bubble-voice-"
        private const val CHANNEL_ID = "wovoice_bubble_recording"
        private const val NOTIFICATION_ID = 43
        private const val ACTION_CANCEL = "com.aliahad.wovoice.CANCEL_BUBBLE_DICTATION"

        fun isConnected(): Boolean = connectedInstance?.get() != null

        fun refreshConnection() {
            connectedInstance?.get()?.let { service -> service.handler.post { service.scheduleRefresh() } }
        }

        fun isEnabled(context: Context): Boolean {
            val expected = ComponentName(context, BubbleAccessibilityService::class.java)
            val manager = context.getSystemService(AccessibilityManager::class.java)
            return manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK).any {
                ComponentName(it.resolveInfo.serviceInfo.packageName, it.resolveInfo.serviceInfo.name) == expected
            }
        }
    }
}
