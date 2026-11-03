package com.aliahad.wovoice.context

import android.text.InputType
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.aliahad.wovoice.settings.SettingsStore
import kotlinx.coroutines.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.atomic.AtomicInteger

@RunWith(AndroidJUnit4::class)
class ContextCaptureInstrumentedTest {
    @Test fun capturesOnlyOptedInSyntheticContextAndRechecksPrivacyBeforeUpload() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val settings = SettingsStore(context)
        val oldLevel = settings.contextLevel; val oldStyle = settings.contextStyle
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val reads = AtomicInteger()
        val connection = object : BaseInputConnection(View(context), false) {
            override fun getTextBeforeCursor(n: Int, flags: Int): CharSequence { reads.incrementAndGet(); return "Dear Professor Test, " }
            override fun getTextAfterCursor(n: Int, flags: Int): CharSequence = ""
        }
        val info = EditorInfo().apply { packageName = "com.google.android.gm"; inputType = InputType.TYPE_CLASS_TEXT; hintText = "Message" }
        try {
            settings.contextStyle = "auto"
            settings.contextLevel = ContextLevel.OFF
            assertNull(ContextCapture.start(scope, settings, info, connection).snapshot(settings)); assertEquals(0, reads.get())
            settings.contextLevel = ContextLevel.APP
            val appOnly = ContextCapture.start(scope, settings, info, connection).snapshot(settings)!!
            assertEquals("email", appOnly.purpose); assertNull(appOnly.before); assertEquals(0, reads.get())
            settings.contextLevel = ContextLevel.NEARBY
            val nearby = ContextCapture.start(scope, settings, info, connection)
            val result = nearby.snapshot(settings)!!
            assertEquals("academic", result.audience); assertEquals("Dear Professor Test, ", result.before)
            settings.contextLevel = ContextLevel.APP
            assertNull(nearby.snapshot(settings)!!.before)
            settings.contextLevel = ContextLevel.OFF
            assertNull(nearby.snapshot(settings))
            settings.contextLevel = ContextLevel.NEARBY
            info.imeOptions = EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
            assertNull(ContextCapture.start(scope, settings, info, connection).snapshot(settings))
            info.imeOptions = 0; info.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            assertNull(ContextCapture.start(scope, settings, info, connection).snapshot(settings))
        } finally { scope.cancel(); settings.contextLevel = oldLevel; settings.contextStyle = oldStyle }
    }

    @Test fun nonProseFieldsUseLiteralOrSearchPolicy() {
        assertEquals("search", ContextCapture.field(InputType.TYPE_CLASS_TEXT, EditorInfo.IME_ACTION_SEARCH))
        assertEquals("literal", ContextCapture.field(InputType.TYPE_CLASS_NUMBER))
        assertEquals("literal", ContextCapture.field(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI))
        assertEquals("text", ContextCapture.field(InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE))
    }
}
