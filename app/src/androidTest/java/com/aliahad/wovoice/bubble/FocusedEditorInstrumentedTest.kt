package com.aliahad.wovoice.bubble

import android.app.UiAutomation
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class FocusedEditorInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private lateinit var automation: UiAutomation

    @Before fun openEditor() {
        automation = instrumentation.getUiAutomation(UiAutomation.FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES)
        // The fixture is a separate app so the service must insert across a real app boundary.
        // Start as shell: a background instrumentation app cannot launch another app on recent Android.
        automation.executeShellCommand("am start -W -f 0x10008000 -n " +
            "${instrumentation.context.packageName}/${BubbleEditorFixtureActivity::class.java.name}").use { descriptor ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
        }
        await { focused()?.contentDescription == "First test text box" }
    }

    @Test fun insertsIntoOriginalFieldWithAnotherKeyboardSelected() {
        val editor = FocusedEditor.capture(focused())
        assertNotNull(editor)
        assertTrue(editor!!.insert("spoken words", focused()))
        await { focused()?.text?.toString() == "Before spoken words after" }
        assertEquals("Untouched", field("Second test text box").text.toString())
    }

    @Test fun refusesAnotherFieldOrAnEditMadeWhileWaiting() {
        val editor = FocusedEditor.capture(focused())!!
        field("Second test text box").performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        await { focused()?.contentDescription == "Second test text box" }
        assertFalse(editor.insert("must not appear", focused()))
        assertEquals("Untouched", focused()?.text.toString())

        val second = FocusedEditor.capture(focused())!!
        focused()!!.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, "New typing")
        })
        await { focused()?.text?.toString() == "New typing" }
        assertFalse(second.insert("must not replace typing", focused()))
    }

    @Test fun refusesPasswordFields() {
        field("Password test text box").performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        await { focused()?.isPassword == true }
        assertNull(FocusedEditor.capture(focused()))
    }

    @Test fun preservesRichFormattingOutsideTheInsertion() {
        field("Rich test text box").performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        await { focused()?.contentDescription == "Rich test text box" }
        focused()!!.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, 5)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, 5)
        })
        await { focused()?.textSelectionStart == 5 }
        assertTrue(FocusedEditor.capture(focused())!!.insert("spoken words", focused()))
        await { focused()?.text?.toString() == "Bold spoken words tail" }
        assertEquals("Formatting preserved", field("Rich formatting status").text.toString())
    }

    @Test fun validatesPartialInputWindowsAndEditorsWithoutDocumentOffsets() {
        val editor = FocusedEditor.capture(focused())!!
        assertTrue(editor.matchesInputWindow("Before after", 6, 6, -1))
        assertTrue(editor.matchesInputWindow("fore af", 4, 4, 2))
        assertTrue(editor.matchesInputWindow("fore af", 4, 4, -1))
        assertFalse(editor.matchesInputWindow("fore af", 3, 3, 2))
        assertFalse(editor.matchesInputWindow("fore xx", 4, 4, -1))
    }

    @Test fun refusesToFlattenHtmlWhenNoInputConnectionIsProvided() {
        automation.executeShellCommand("am start -W -f 0x10008000 -n " +
            "${instrumentation.context.packageName}/${BubbleWebEditorFixtureActivity::class.java.name} --ez autofocus true").use { descriptor ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
        }
        await { runCatching { field("rich").let { it.isFocused && it.textSelectionStart >= 0 } }.getOrDefault(false) }
        val editor = FocusedEditor.capture(field("rich"))!!
        assertTrue(editor.isWebContent())
        assertFalse(editor.insert("Must not replace HTML", field("rich")))
        assertEquals("Bold tail link", field("rich").text.toString())
        assertEquals("Formatting preserved", field("status").text.toString())
    }

    @Test fun insertsIntoEmptyFieldWithoutCopyingItsHint() {
        field("Empty test text box").performAction(AccessibilityNodeInfo.ACTION_FOCUS)
        await { focused()?.contentDescription == "Empty test text box" }
        val node = focused()!!
        val editor = FocusedEditor.capture(node)
        assertNotNull("An empty editor showing its hint must accept dictation", editor)
        assertTrue(editor!!.insert("Hello.", focused()))
        await { focused()?.text?.toString() == "Hello." }
    }

    @Test fun refusesOversizedInsertionWithoutTruncatingExistingText() {
        focusLimitedField(5, 5)
        val editor = FocusedEditor.capture(focused())!!
        assertFalse(editor.insert("new", focused()))
        assertEquals("HelloWorld", focused()?.text?.toString())
        assertEquals(5, focused()?.textSelectionStart)
        assertEquals(5, focused()?.textSelectionEnd)
    }

    @Test fun replacesSelectionAtCharacterLimitWithoutLosingSuffix() {
        focusLimitedField(0, 5)
        val editor = FocusedEditor.capture(focused())!!
        assertTrue(editor.insert("Good", focused()))
        await {
            focused()?.let { it.text?.toString() == "Good World" &&
                it.textSelectionStart == 5 && it.textSelectionEnd == 5 } == true
        }
        assertEquals("Untouched", field("Second test text box").text.toString())
    }

    private fun focusLimitedField(start: Int, end: Int) {
        assertTrue(field("Limited test text box").performAction(AccessibilityNodeInfo.ACTION_FOCUS))
        await { focused()?.contentDescription == "Limited test text box" }
        assertEquals(10, focused()?.maxTextLength)
        assertTrue(focused()!!.performAction(AccessibilityNodeInfo.ACTION_SET_SELECTION, Bundle().apply {
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, start)
            putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, end)
        }))
        await { focused()?.let { it.textSelectionStart == start && it.textSelectionEnd == end } == true }
    }

    private fun focused(): AccessibilityNodeInfo? = automation.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)

    private fun field(label: String): AccessibilityNodeInfo {
        fun find(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
            if (node.contentDescription == label || node.viewIdResourceName == label) return node
            repeat(node.childCount) { index -> node.getChild(index)?.let { find(it)?.let { found -> return found } } }
            return null
        }
        return find(automation.rootInActiveWindow!!) ?: error("Missing fixture field")
    }

    private fun await(condition: () -> Boolean) {
        val deadline = android.os.SystemClock.uptimeMillis() + 8_000
        while (!condition() && android.os.SystemClock.uptimeMillis() < deadline) android.os.SystemClock.sleep(50)
        assertTrue("Editor did not reach the expected state", condition())
    }
}
