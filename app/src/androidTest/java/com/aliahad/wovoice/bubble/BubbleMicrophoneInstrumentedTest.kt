package com.aliahad.wovoice.bubble

import android.Manifest
import android.app.Service
import android.app.UiAutomation
import android.content.pm.PackageManager
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.aliahad.wovoice.voice.WavRecorder
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Requires user-enabled Accessibility and microphone permission; never sends audio to the server.
 * Run with `am instrument --no-hidden-api-checks` so the test can locate the system-bound service.
 * Add `-e enableBubbleDuringTest true` to re-enable Accessibility through system settings after startup.
 */
@RunWith(AndroidJUnit4::class)
class BubbleMicrophoneInstrumentedTest {
    @Test fun recordsFromSystemBoundServiceWhileAnotherAppIsVisible() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        // Some vendor builds revoke Accessibility when instrumentation restarts the app.
        // This opt-in leaves time to re-enable the service through the normal system UI.
        val enableDuringTest = InstrumentationRegistry.getArguments().getString("enableBubbleDuringTest") == "true"
        assumeTrue(enableDuringTest || BubbleAccessibilityService.isEnabled(context))
        assumeTrue(context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
        val automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        val service = AtomicReference<BubbleAccessibilityService>()
        val deadline = SystemClock.uptimeMillis() + if (enableDuringTest) 180_000 else 8_000
        while (service.get() == null && SystemClock.uptimeMillis() < deadline) {
            instrumentation.runOnMainSync {
                // Locate the real system-bound instance, rather than starting a test-only service.
                val activityThread = Class.forName("android.app.ActivityThread")
                val thread = activityThread.getDeclaredMethod("currentActivityThread").invoke(null)
                val services = activityThread.getDeclaredField("mServices").apply { isAccessible = true }.get(thread) as Map<*, *>
                service.set(services.values.filterIsInstance<BubbleAccessibilityService>().firstOrNull { it.serviceInfo != null })
            }
            if (service.get() == null) SystemClock.sleep(50)
        }
        assertNotNull("Accessibility service must be bound by Android", service.get())
        automation.executeShellCommand("am start -W -f 0x10008000 -n " +
            "${instrumentation.context.packageName}/${BubbleEditorFixtureActivity::class.java.name}").use { descriptor ->
            ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
        }
        val started = CountDownLatch(1)
        val completed = CountDownLatch(1)
        val recordingResult = AtomicReference<WavRecorder.RecordingResult>()
        val error = AtomicReference<String>()
        val file = File(context.cacheDir, "bubble-microphone-test.wav")
        val recorder = WavRecorder(context, file, object : WavRecorder.Callback {
            override fun onStarted() { started.countDown() }
            override fun onLevel(rms: Float) = Unit
            override fun onComplete(result: WavRecorder.RecordingResult) { recordingResult.set(result); completed.countDown() }
            override fun onError(message: String) { error.set(message); started.countDown(); completed.countDown() }
        })
        try {
            instrumentation.runOnMainSync {
                BubbleAccessibilityService::class.java.getDeclaredMethod("promoteRecording").apply { isAccessible = true }.invoke(service.get())
            }
            recorder.start()
            assertTrue("Microphone did not start: ${error.get()}", started.await(5, TimeUnit.SECONDS))
            assertTrue("Microphone failed: ${error.get()}", error.get() == null)
            SystemClock.sleep(750)
            recorder.finish()
            assertTrue("Microphone did not complete", completed.await(5, TimeUnit.SECONDS))
            assertTrue("Microphone failed: ${error.get()}", error.get() == null)
            assertTrue("Expected recorded PCM frames", (recordingResult.get()?.durationMs ?: 0) >= 250)
        } finally {
            recorder.cancel()
            instrumentation.runOnMainSync {
                androidx.core.app.ServiceCompat.stopForeground(service.get() as Service, androidx.core.app.ServiceCompat.STOP_FOREGROUND_REMOVE)
            }
            file.delete()
        }
    }
}
