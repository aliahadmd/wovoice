package com.aliahad.wovoice.bubble

import android.app.UiAutomation
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.view.InputDevice
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.FrameLayout
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.aliahad.wovoice.settings.SetupActivity
import com.aliahad.wovoice.ui.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.atomic.AtomicInteger

/** Exercises the real native view with synthetic signal levels; never records or uploads audio. */
@RunWith(AndroidJUnit4::class)
class BubblePresentationInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val automation: UiAutomation get() = instrumentation.uiAutomation
    private lateinit var body: FrameLayout
    private lateinit var editor: EditText
    private lateinit var bubble: DictationBubbleView

    @Test fun compactStatesRemainInteractiveAndRespectReducedMotion() {
        val taps = AtomicInteger()
        val cancels = AtomicInteger()
        val drags = AtomicInteger()
        val retries = AtomicInteger()
        val intent = Intent(instrumentation.targetContext, SetupActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        // The preceding cross-app editor tests can leave the target app in the background.
        // Bring it forward as shell before ActivityScenario launches its controlled instance.
        automation.executeShellCommand("am start -W -f 0x10008000 -n " +
            "${instrumentation.targetContext.packageName}/${SetupActivity::class.java.name}").use { descriptor ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
        }
        ActivityScenario.launch<SetupActivity>(intent).use { scenario ->
            scenario.onActivity { activity ->
                body = FrameLayout(activity).apply { setBackgroundColor(Color.rgb(245, 244, 249)) }
                editor = EditText(activity).apply {
                    contentDescription = "Bubble preview editor"
                    setText("Keep this text")
                    setTextColor(Color.BLACK)
                    setSingleLine()
                }
                body.addView(editor, FrameLayout.LayoutParams(-1, activity.dp(64)).apply {
                    topMargin = activity.dp(90); leftMargin = activity.dp(20); rightMargin = activity.dp(20)
                })
                bubble = DictationBubbleView(activity, onTap = { taps.incrementAndGet() },
                    onCancel = { cancels.incrementAndGet() }, onHide = { cancels.incrementAndGet() },
                    onDrag = { _, _, _ -> drags.incrementAndGet() })
                body.addView(bubble, FrameLayout.LayoutParams(-2, -2).apply {
                    topMargin = activity.dp(220); leftMargin = activity.dp(28)
                })
                activity.setContentView(body)
                editor.requestFocus()
                editor.setSelection(4)
                bubble.setPreferences(haptics = false, animations = true, waveform = true)
                bubble.animateIn()
            }
            await { bubble.width > 0 && bubble.alpha >= .99f }
            val idleWidth = onMain { bubble.width }
            assertTrue("Idle bubble should be compact", idleWidth < instrumentation.targetContext.dp(130))
            save("idle")
            holdPreview()
            tap("Start bubble dictation")
            assertEquals(1, taps.get())
            assertTrue(onMain { editor.isFocused })

            onMain { bubble.render("", recording = true, processing = false) }
            await { bubble.width > idleWidth }
            repeat(12) { index ->
                onMain { bubble.level(floatArrayOf(.001f, .02f, .08f, .008f)[index % 4]) }
                SystemClock.sleep(40)
            }
            onMain { bubble.setElapsed(12_000) }
            save("recording")
            holdPreview()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                assertTrue(onMain { described("Finish bubble recording").stateDescription.toString().contains("0:12") })
            }

            onMain { bubble.render("", recording = false, processing = true) }
            await { bubble.width > idleWidth && described("Transcribing speech").isShown }
            SystemClock.sleep(250)
            save("thinking")
            holdPreview()
            tap("Transcribing speech")
            assertEquals("Thinking must not start another recording", 1, taps.get())
            drag("Transcribing speech")
            assertTrue("Processing must remain draggable", drags.get() > 0)
            assertTrue(onMain { editor.isFocused })

            onMain { bubble.renderMessage("Connection failed", "Retry") { retries.incrementAndGet() } }
            await { described("Connection failed. Retry").isShown }
            SystemClock.sleep(250)
            save("retry")
            holdPreview()
            tap("Connection failed. Retry")
            assertEquals(1, retries.get())

            onMain {
                bubble.setPreferences(haptics = false, animations = false, waveform = false)
                bubble.render("", recording = true, processing = false)
                bubble.setElapsed(5_000)
            }
            await { described("Finish bubble recording").isShown && bubble.alpha == 1f }
            val before = captureBubble()
            onMain { bubble.level(.9f) }
            SystemClock.sleep(120)
            val after = captureBubble()
            assertTrue("Disabled motion/waveform must stay static when audio changes", before.sameAs(after))
            before.recycle(); after.recycle()
            save("reduced-motion")
            holdPreview()
            tap("Cancel bubble dictation")
            assertEquals(1, cancels.get())
            assertEquals("Keep this text", onMain { editor.text.toString() })
            assertEquals(4, onMain { editor.selectionStart })
        }
    }

    private fun described(description: String): View {
        fun find(view: View): View? {
            if (view.contentDescription?.toString() == description) return view
            if (view is ViewGroup) repeat(view.childCount) { index -> find(view.getChildAt(index))?.let { return it } }
            return null
        }
        return find(body) ?: error("Missing control: $description")
    }

    private fun tap(description: String) {
        val bounds = onMain { Rect().also { described(description).getGlobalVisibleRect(it) } }
        val now = SystemClock.uptimeMillis()
        inject(now, now, MotionEvent.ACTION_DOWN, bounds.exactCenterX(), bounds.exactCenterY())
        inject(now, now + 25, MotionEvent.ACTION_UP, bounds.exactCenterX(), bounds.exactCenterY())
        instrumentation.waitForIdleSync()
    }

    private fun drag(description: String) {
        val bounds = onMain { Rect().also { described(description).getGlobalVisibleRect(it) } }
        val now = SystemClock.uptimeMillis()
        inject(now, now, MotionEvent.ACTION_DOWN, bounds.exactCenterX(), bounds.exactCenterY())
        inject(now, now + 40, MotionEvent.ACTION_MOVE, bounds.exactCenterX() + 80, bounds.exactCenterY() + 50)
        inject(now, now + 80, MotionEvent.ACTION_UP, bounds.exactCenterX() + 80, bounds.exactCenterY() + 50)
        instrumentation.waitForIdleSync()
    }

    private fun inject(down: Long, time: Long, action: Int, x: Float, y: Float) {
        val event = MotionEvent.obtain(down, time, action, x, y, 0).apply { source = InputDevice.SOURCE_TOUCHSCREEN }
        try { assertTrue(automation.injectInputEvent(event, true)) } finally { event.recycle() }
    }

    private fun save(state: String) {
        instrumentation.waitForIdleSync()
        // Accessibility state changes before SurfaceFlinger presents the next drawn frame.
        SystemClock.sleep(48)
        val bitmap = automation.takeScreenshot() ?: error("Could not capture native preview")
        File(instrumentation.targetContext.cacheDir, "bubble-preview-$state.png").outputStream().use {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
    }

    private fun captureBubble(): Bitmap {
        instrumentation.waitForIdleSync()
        SystemClock.sleep(48)
        val bounds = onMain { Rect().also { bubble.getGlobalVisibleRect(it) } }
        val screen = automation.takeScreenshot() ?: error("Could not capture bubble")
        return Bitmap.createBitmap(screen, bounds.left, bounds.top, bounds.width(), bounds.height()).also { screen.recycle() }
    }

    private fun holdPreview() {
        if (InstrumentationRegistry.getArguments().getString("recordPreview") == "true") SystemClock.sleep(1_200)
    }

    private fun await(condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 3_000
        while (!onMain(condition) && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(30)
        assertTrue("Bubble did not reach its expected presentation", onMain(condition))
    }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }
}
