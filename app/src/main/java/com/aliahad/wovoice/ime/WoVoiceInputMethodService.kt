package com.aliahad.wovoice.ime

import android.Manifest
import android.inputmethodservice.InputMethodService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.os.IBinder
import android.util.Log
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.core.content.ContextCompat
import com.aliahad.wovoice.core.DeletePolicy
import com.aliahad.wovoice.core.CorrectionLearning
import com.aliahad.wovoice.core.EditorPolicy
import com.aliahad.wovoice.core.EditorSessionGuard
import com.aliahad.wovoice.core.KeyboardState
import com.aliahad.wovoice.core.TextCommitPolicy
import com.aliahad.wovoice.network.TranscriptionClient
import com.aliahad.wovoice.data.WoVoiceRepository
import com.aliahad.wovoice.settings.SettingsStore
import com.aliahad.wovoice.settings.SetupActivity
import com.aliahad.wovoice.voice.VoiceCaptureService
import com.aliahad.wovoice.voice.WavRecorder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import android.os.SystemClock

class WoVoiceInputMethodService : InputMethodService(), WoVoiceKeyboardView.Listener,
    VoiceCaptureService.Listener {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val sessions = EditorSessionGuard()
    private val client = TranscriptionClient()
    private lateinit var settings: SettingsStore
    private val repository by lazy { WoVoiceRepository(this) }
    private var keyboard: WoVoiceKeyboardView? = null
    private var state: KeyboardState = KeyboardState.VoiceIdle
    private var currentSession = 0L
    private var captureSession = 0L
    private var sentenceStartForCapture = true
    private var networkJob: Job? = null
    private var activeFile: File? = null
    private var captureBinder: VoiceCaptureService.LocalBinder? = null
    private var pendingCapture = false
    private var bound = false
    private var pendingCorrection: PendingCorrection? = null

    private val serviceConnection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            captureBinder = service as? VoiceCaptureService.LocalBinder
            if (pendingCapture) {
                pendingCapture = false
                beginBoundCapture()
            }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            captureBinder = null
            if (state is KeyboardState.Recording) showError("The recorder disconnected. Tap to try again.")
        }
    }

    override fun onCreate() {
        super.onCreate()
        settings = SettingsStore(this)
        bound = bindService(
            Intent(this, VoiceCaptureService::class.java),
            serviceConnection,
            Context.BIND_AUTO_CREATE,
        )
    }

    override fun onCreateInputView(): View {
        return WoVoiceKeyboardView(this).also {
            it.listener = this
            keyboard = it
            it.setPreferences(settings.hapticsEnabled, settings.animationsEnabled, settings.waveformEnabled)
            configureForEditor(currentInputEditorInfo)
            it.setState(state)
        }
    }

    override fun onEvaluateFullscreenMode(): Boolean = false

    override fun onStartInput(attribute: EditorInfo?, restarting: Boolean) {
        super.onStartInput(attribute, restarting)
        cancelActiveWork()
        currentSession = sessions.begin()
        pendingCorrection = null
        state = if (EditorPolicy.isSensitive(attribute?.inputType ?: 0)) {
            KeyboardState.ManualKeyboard
        } else {
            KeyboardState.VoiceIdle
        }
        configureForEditor(attribute)
    }

    override fun onStartInputView(info: EditorInfo?, restarting: Boolean) {
        super.onStartInputView(info, restarting)
        if (!sessions.isActive(currentSession)) currentSession = sessions.begin()
        configureForEditor(info)
        keyboard?.setPreferences(settings.hapticsEnabled, settings.animationsEnabled, settings.waveformEnabled)
        keyboard?.setState(state)
    }

    override fun onFinishInputView(finishingInput: Boolean) {
        pendingCorrection = null
        cancelActiveWork()
        sessions.invalidate()
        super.onFinishInputView(finishingInput)
    }

    override fun onFinishInput() {
        pendingCorrection = null
        cancelActiveWork()
        sessions.invalidate()
        super.onFinishInput()
    }

    override fun onWindowHidden() {
        pendingCorrection = null
        cancelActiveWork()
        sessions.invalidate()
        super.onWindowHidden()
    }

    override fun onDestroy() {
        cancelActiveWork()
        if (bound) runCatching { unbindService(serviceConnection) }
        bound = false
        scope.cancel()
        super.onDestroy()
    }

    override fun onStartVoice() {
        if (EditorPolicy.isSensitive(currentInputEditorInfo?.inputType ?: 0)) {
            state = KeyboardState.ManualKeyboard
            keyboard?.setVoiceEnabled(false)
            keyboard?.setState(state)
            return
        }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            showError("Allow microphone access in WoVoice settings.")
            return
        }
        if (!settings.isConfigured()) {
            showError("Add your Worker URL and device token in settings.")
            return
        }
        cancelActiveWork(resetState = false)
        captureSession = currentSession
        sentenceStartForCapture = TextCommitPolicy.isSentenceStart(previousCharacter())
        state = KeyboardState.Recording
        keyboard?.setState(state)
        try {
            ContextCompat.startForegroundService(this, Intent(this, VoiceCaptureService::class.java))
            if (captureBinder == null) pendingCapture = true else beginBoundCapture()
        } catch (_: Exception) {
            showError("The microphone could not start. Open WoVoice settings and try again.")
        }
    }

    override fun onFinishVoice() {
        if (state !is KeyboardState.Recording) return
        state = KeyboardState.Processing
        keyboard?.setState(state)
        captureBinder?.finishCapture()
    }

    override fun onCancelVoice() {
        cancelActiveWork()
        state = KeyboardState.VoiceIdle
        keyboard?.setState(state)
    }

    override fun onSelectManual(manual: Boolean) {
        cancelActiveWork()
        state = if (manual) KeyboardState.ManualKeyboard else KeyboardState.VoiceIdle
        keyboard?.setState(state)
    }

    override fun onCommitText(text: String) {
        currentInputConnection?.commitText(text, 1)
    }

    override fun onDelete() {
        val connection = currentInputConnection ?: return
        if (!connection.getSelectedText(0).isNullOrEmpty()) {
            connection.commitText("", 1)
            return
        }
        if (!connection.deleteSurroundingTextInCodePoints(1, 0)) {
            val before = connection.getTextBeforeCursor(2, 0) ?: return
            val units = DeletePolicy.utf16UnitsForLastCodePoint(before)
            if (units > 0) connection.deleteSurroundingText(units, 0)
        }
    }

    override fun onEditorAction() {
        val connection = currentInputConnection ?: return
        val action = (currentInputEditorInfo?.imeOptions ?: 0) and EditorInfo.IME_MASK_ACTION
        if (action in setOf(
                EditorInfo.IME_ACTION_GO,
                EditorInfo.IME_ACTION_NEXT,
                EditorInfo.IME_ACTION_SEARCH,
                EditorInfo.IME_ACTION_SEND,
                EditorInfo.IME_ACTION_DONE,
            )
        ) {
            connection.performEditorAction(action)
        } else {
            connection.commitText("\n", 1)
        }
    }

    override fun onOpenSettings() {
        startActivity(Intent(this, SetupActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    override fun onRecordingStarted() {
        if (!isCaptureActive()) captureBinder?.cancelCapture()
    }

    override fun onLevel(rms: Float) {
        if (isCaptureActive()) keyboard?.updateLevel(rms)
    }

    override fun onRecordingComplete(result: WavRecorder.RecordingResult) {
        Log.i(
            CAPTURE_LOG_TAG,
            "durationMs=${result.durationMs} activeMs=${result.activeSpeechMs} " +
                "averageRms=${result.averageRms} peakRms=${result.peakRms} " +
                "accepted=${result.containsSpeech}",
        )
        if (!isCaptureActive() && state !is KeyboardState.Processing) {
            result.file.delete()
            return
        }
        if (!sessions.isActive(captureSession) || captureSession != currentSession) {
            result.file.delete()
            return
        }
        if (!result.containsSpeech) {
            result.file.delete()
            showError("No clear speech. Tap to try again.")
            return
        }
        state = KeyboardState.Processing
        keyboard?.setState(state)
        activeFile = result.file
        transcribe(result.file, captureSession, result.durationMs)
    }

    override fun onRecordingError(message: String) {
        if (sessions.isActive(captureSession)) showError(message)
    }

    private fun beginBoundCapture() {
        if (state !is KeyboardState.Recording || !sessions.isActive(captureSession)) return
        val started = captureBinder?.startCapture(this) == true
        if (!started) showError("The microphone is already in use.")
    }

    private fun transcribe(file: File, session: Long, audioDurationMs: Long) {
        val workerUrl = settings.workerUrl
        val token = settings.deviceToken()
        if (token.isNullOrBlank()) {
            file.delete()
            showError("The device token is missing. Open WoVoice settings.")
            return
        }
        networkJob?.cancel()
        networkJob = scope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    repository.importGlossary(settings.glossary)
                    val glossary = repository.bestGlossary().ifEmpty { settings.glossary }
                    client.transcribe(workerUrl, token, file, sentenceStartForCapture, glossary)
                }
                if (!sessions.isActive(session) || session != currentSession || !isInputViewShown) return@launch
                when (result) {
                    is TranscriptionClient.Result.Success -> commitFinalText(result, audioDurationMs)
                    is TranscriptionClient.Result.Error -> showError(result.message)
                }
            } finally {
                file.delete()
                if (activeFile == file) activeFile = null
            }
        }
    }

    private fun commitFinalText(result: TranscriptionClient.Result.Success, audioDurationMs: Long) {
        val connection: InputConnection = currentInputConnection ?: return
        val text = TextCommitPolicy.withLocalSpacing(previousCharacter(), result.text)
        val committed = text.isNotEmpty() && connection.commitText(text, 1)
        if (committed) {
            scope.launch(Dispatchers.IO) {
                repository.recordSuccessfulDictation(
                    result = result,
                    committedText = result.text,
                    audioDurationMs = audioDurationMs,
                    keepHistory = settings.historyEnabled,
                )
            }
            if (settings.learningSuggestionsEnabled && EditorPolicy.allowsLearning(currentInputEditorInfo)) {
                pendingCorrection = PendingCorrection(
                    session = currentSession,
                    generatedText = result.text,
                    createdAtUptimeMs = SystemClock.uptimeMillis(),
                )
            }
        }
        state = KeyboardState.VoiceIdle
        keyboard?.setState(state)
    }

    override fun onUpdateSelection(
        oldSelStart: Int,
        oldSelEnd: Int,
        newSelStart: Int,
        newSelEnd: Int,
        candidatesStart: Int,
        candidatesEnd: Int,
    ) {
        super.onUpdateSelection(oldSelStart, oldSelEnd, newSelStart, newSelEnd, candidatesStart, candidatesEnd)
        val pending = pendingCorrection ?: return
        if (
            !settings.learningSuggestionsEnabled ||
            !EditorPolicy.allowsLearning(currentInputEditorInfo) ||
            pending.session != currentSession ||
            !sessions.isActive(pending.session) ||
            SystemClock.uptimeMillis() - pending.createdAtUptimeMs > CORRECTION_WINDOW_MS ||
            newSelStart != newSelEnd
        ) {
            pendingCorrection = null
            return
        }
        val tailLength = (pending.generatedText.length + 64).coerceAtMost(MAX_CORRECTION_WINDOW_CHARS)
        val tail = currentInputConnection?.getTextBeforeCursor(tailLength, 0)?.toString() ?: return
        val suggestion = CorrectionLearning.suggestion(pending.generatedText, tail) ?: return
        pendingCorrection = null
        scope.launch(Dispatchers.IO) {
            if (repository.addSuggestion(suggestion)) repository.noteCorrection()
        }
    }

    private fun configureForEditor(info: EditorInfo?) {
        val sensitive = EditorPolicy.isSensitive(info?.inputType ?: 0)
        keyboard?.setVoiceEnabled(!sensitive)
        if (sensitive) state = KeyboardState.ManualKeyboard
        keyboard?.updateEditor(info, TextCommitPolicy.isSentenceStart(previousCharacter()))
        keyboard?.setState(state)
    }

    private fun previousCharacter(): Char? = currentInputConnection
        ?.getTextBeforeCursor(1, 0)
        ?.lastOrNull()

    private fun isCaptureActive(): Boolean =
        sessions.isActive(captureSession) && captureSession == currentSession &&
            (state is KeyboardState.Recording || state is KeyboardState.Processing)

    private fun showError(message: String) {
        state = KeyboardState.Error(message.take(100))
        keyboard?.setState(state)
    }

    private fun cancelActiveWork(resetState: Boolean = false) {
        pendingCapture = false
        captureBinder?.cancelCapture()
        networkJob?.cancel()
        networkJob = null
        client.cancel()
        activeFile?.delete()
        activeFile = null
        if (resetState) {
            state = KeyboardState.VoiceIdle
            keyboard?.setState(state)
        }
    }

    private companion object {
        const val CAPTURE_LOG_TAG = "WoVoiceCapture"
        const val CORRECTION_WINDOW_MS = 30_000L
        const val MAX_CORRECTION_WINDOW_CHARS = 256
    }

    private data class PendingCorrection(
        val session: Long,
        val generatedText: String,
        val createdAtUptimeMs: Long,
    )
}
