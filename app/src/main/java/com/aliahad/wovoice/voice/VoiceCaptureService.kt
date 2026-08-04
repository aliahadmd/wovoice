package com.aliahad.wovoice.voice

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.Build
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import android.content.pm.ServiceInfo
import com.aliahad.wovoice.R
import java.io.File

class VoiceCaptureService : Service() {
    interface Listener {
        fun onRecordingStarted()
        fun onLevel(rms: Float)
        fun onRecordingComplete(result: WavRecorder.RecordingResult)
        fun onRecordingError(message: String)
    }

    inner class LocalBinder : Binder() {
        fun startCapture(listener: Listener): Boolean = this@VoiceCaptureService.startCapture(listener)
        fun finishCapture() = recorder?.finish()
        fun cancelCapture() = cancelCaptureInternal()
    }

    private val binder = LocalBinder()
    private val mainHandler = android.os.Handler(Looper.getMainLooper())
    private var recorder: WavRecorder? = null
    private var listener: Listener? = null

    override fun onCreate() {
        super.onCreate()
        cleanupStaleRecordings()
        createChannel()
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startMicrophoneForeground()
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        cancelCaptureInternal()
        cleanupStaleRecordings()
        super.onDestroy()
    }

    private fun startCapture(newListener: Listener): Boolean {
        if (recorder != null) return false
        listener = newListener
        startMicrophoneForeground()
        val target = File(cacheDir, "$FILE_PREFIX${System.currentTimeMillis()}.wav")
        val capture = WavRecorder(applicationContext, target, object : WavRecorder.Callback {
            override fun onStarted() = post { listener?.onRecordingStarted() }
            override fun onLevel(rms: Float) = post { listener?.onLevel(rms) }
            override fun onComplete(result: WavRecorder.RecordingResult) = post {
                recorder = null
                listener?.onRecordingComplete(result)
                listener = null
                leaveForeground()
            }
            override fun onError(message: String) = post {
                recorder = null
                listener?.onRecordingError(message)
                listener = null
                leaveForeground()
            }
        })
        recorder = capture
        capture.start()
        return true
    }

    private fun cancelCaptureInternal() {
        recorder?.cancel()
        recorder = null
        listener = null
        leaveForeground()
    }

    private fun post(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else mainHandler.post(block)
    }

    private fun startMicrophoneForeground() {
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_mic_small)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.recording_notification))
            .setOngoing(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .build()
        val foregroundType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
        } else {
            0
        }
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            foregroundType,
        )
    }

    private fun leaveForeground() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                getString(R.string.recording_channel_name),
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
    }

    private fun cleanupStaleRecordings() {
        cacheDir.listFiles { file -> file.name.startsWith(FILE_PREFIX) }?.forEach(File::delete)
    }

    private companion object {
        const val CHANNEL_ID = "wovoice_recording"
        const val NOTIFICATION_ID = 42
        const val FILE_PREFIX = "active-voice-"
    }
}
