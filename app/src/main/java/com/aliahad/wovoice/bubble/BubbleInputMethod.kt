package com.aliahad.wovoice.bubble

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.InputMethod
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.EditorInfo
import androidx.annotation.RequiresApi
import com.aliahad.wovoice.core.EditorPolicy
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

internal enum class BubbleCommitResult { ACCEPTED, REJECTED, UNCONFIRMED, UNSUPPORTED }

/** Android 13's Accessibility input connection edits a selection without replacing its document. */
@RequiresApi(33)
internal class BubbleInputMethod(service: AccessibilityService, private val changed: () -> Unit) : InputMethod(service) {
    private var generation = 0L

    override fun onStartInput(attribute: EditorInfo, restarting: Boolean) {
        generation++
        changed()
    }

    override fun onFinishInput() {
        generation++
        changed()
    }

    override fun onUpdateSelection(oldSelStart: Int, oldSelEnd: Int, newSelStart: Int, newSelEnd: Int,
        candidatesStart: Int, candidatesEnd: Int) = changed()

    fun capture(node: AccessibilityNodeInfo?): Target? {
        val info = currentInputEditorInfo ?: return null
        if (node == null || !currentInputStarted || node.packageName?.toString() != info.packageName ||
            EditorPolicy.isSensitive(info.inputType)
        ) return null
        return currentInputConnection?.let { Target(it, generation, info.packageName) }
    }

    inner class Target(private val connection: AccessibilityInputConnection, private val session: Long,
        private val ownerPackage: String) {
        val allowsContext: Boolean get() = isCurrent() && (currentInputEditorInfo?.imeOptions ?: 0) and EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING == 0

        fun isCurrent(): Boolean = generation == session && currentInputStarted &&
            currentInputEditorInfo?.packageName == ownerPackage

        suspend fun insert(editor: FocusedEditor, transcript: String, current: () -> AccessibilityNodeInfo?): BubbleCommitResult {
            if (!isCurrent() || editor.packageName != ownerPackage) return BubbleCommitResult.REJECTED
            // This IPC can wait on another application: keep it off the service's main thread.
            val surrounding = withContext(Dispatchers.IO) { connection.getSurroundingText(2_048, 2_048, 0) }
            if (!isCurrent()) return BubbleCommitResult.REJECTED
            if (surrounding != null && !editor.matchesInputWindow(surrounding.text.toString(),
                    surrounding.selectionStart, surrounding.selectionEnd, surrounding.offset)) return BubbleCommitResult.REJECTED
            val insertion = editor.prepare(transcript, current()) ?: return BubbleCommitResult.REJECTED
            // The framework finishes the other IME's composing span in the same batch before committing.
            // This is a single selection edit; HTML, spans, links, and surrounding paragraphs stay owned by the editor.
            connection.commitText(editor.fragment(insertion), 1, null)
            // commitText has no success return. Confirm acceptance before counting History/analytics.
            // Never attempt a second transport after submission: an unacknowledged edit may still arrive.
            repeat(12) {
                delay(50)
                // Some editors restart input after accepting a commit. Session changes now
                // prevent further writes, but do not disprove an edit visible in the original node.
                if (editor.matchesResult(current(), insertion)) return BubbleCommitResult.ACCEPTED
            }
            return BubbleCommitResult.UNCONFIRMED
        }
    }
}
