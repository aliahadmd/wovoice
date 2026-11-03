package com.aliahad.wovoice.bubble

import android.os.Bundle
import android.os.Build
import android.text.SpannableStringBuilder
import android.text.SpannedString
import android.view.accessibility.AccessibilityNodeInfo
import com.aliahad.wovoice.core.EditorPolicy
import com.aliahad.wovoice.core.TextCommitPolicy
import com.aliahad.wovoice.context.ContextCapture
import com.aliahad.wovoice.context.ContextLevel
import com.aliahad.wovoice.context.ContextPolicy
import com.aliahad.wovoice.context.DictationContext

/** Holds exactly the focused editor, never a screen dump or a clipboard fallback. */
internal class FocusedEditor private constructor(
    private val node: AccessibilityNodeInfo,
    private val original: String,
    private val styledOriginal: CharSequence,
    private val start: Int,
    private val end: Int,
    private val usesInputConnection: Boolean,
) {
    val packageName: String = node.packageName.toString()
    val sentenceStart: Boolean = TextCommitPolicy.isSentenceStartAfter(original.take(minOf(start, end)).takeLast(16))

    fun context(level: ContextLevel, style: String): DictationContext? {
        if (Build.VERSION.SDK_INT >= 34 && node.isAccessibilityDataSensitive) return null
        val field = ContextCapture.field(node.inputType)
        return ContextPolicy.detect(packageName, (if (Build.VERSION.SDK_INT >= 26) node.hintText?.toString() else null).orEmpty(), field, level, style,
            if (level == ContextLevel.NEARBY && field == "text") original.take(minOf(start, end)).takeLast(512) else "",
            if (level == ContextLevel.NEARBY && field == "text") original.drop(maxOf(start, end)).take(128) else "")
    }

    fun matches(current: AccessibilityNodeInfo?): Boolean {
        if (current == null || current != node || !isSupported(current, usesInputConnection)) return false
        val text = textOf(current)
        val selection = selectionOf(current, text)
        return text == original && selection.first == start && selection.second == end
    }

    fun isSameNode(current: AccessibilityNodeInfo?): Boolean = current == node

    fun isWebContent(): Boolean {
        var ancestor: AccessibilityNodeInfo? = node
        repeat(24) {
            val current = ancestor ?: return false
            if (current.className?.toString() == "android.webkit.WebView") return true
            ancestor = current.parent
        }
        // An unknown, deeply nested document must not be flattened as a fallback.
        return ancestor != null
    }

    fun prepare(transcript: String, current: AccessibilityNodeInfo?): BubbleTextInsertion? {
        if (!matches(current) || !node.refresh() || !matches(node)) return null
        val insertion = BubbleTextInsertion.create(original, start, end, transcript) ?: return null
        // ACTION_SET_TEXT replaces the whole value. A length filter would truncate the
        // replacement, potentially deleting the untouched suffix while still reporting success.
        val maximumLength = node.maxTextLength
        if (maximumLength >= 0 && insertion.text.length > maximumLength) return null
        return insertion
    }

    fun fragment(insertion: BubbleTextInsertion): String = insertion.text.substring(minOf(start, end), insertion.cursor)

    fun matchesInputWindow(text: String, selectionStart: Int, selectionEnd: Int, offset: Int): Boolean {
        if (selectionStart !in 0..text.length || selectionEnd !in 0..text.length) return false
        // InputConnection's default implementation uses -1 when it cannot report a document offset.
        val actualOffset = if (offset >= 0) offset else start - selectionStart
        return actualOffset >= 0 && actualOffset <= original.length && text.length <= original.length - actualOffset &&
            start == selectionStart + actualOffset && end == selectionEnd + actualOffset &&
            original.regionMatches(actualOffset, text, 0, text.length)
    }

    fun matchesResult(current: AccessibilityNodeInfo?, insertion: BubbleTextInsertion): Boolean =
        current != null && current == node && insertion.matchesObservedText(textOf(current)) &&
            selectionOf(current, insertion.text) == (insertion.cursor to insertion.cursor)

    fun insert(transcript: String, current: AccessibilityNodeInfo?): Boolean {
        if (isWebContent()) return false
        val insertion = prepare(transcript, current) ?: return false
        val changed = node.performAction(
            AccessibilityNodeInfo.ACTION_SET_TEXT,
            Bundle().apply {
                val styled = SpannableStringBuilder(styledOriginal).replace(minOf(start, end), maxOf(start, end), fragment(insertion))
                putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, styled)
            },
        )
        if (!changed) return false
        node.performAction(
            AccessibilityNodeInfo.ACTION_SET_SELECTION,
            Bundle().apply {
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, insertion.cursor)
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, insertion.cursor)
            },
        )
        return true
    }

    companion object {
        private fun textOf(node: AccessibilityNodeInfo): String =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && node.isShowingHintText) ""
            else node.text?.toString().orEmpty()

        private fun selectionOf(node: AccessibilityNodeInfo, text: String): Pair<Int, Int> =
            // Android can omit selection offsets for an empty editor showing its hint.
            // Its only possible insertion position is zero; missing offsets in nonempty text remain invalid.
            if (text.isEmpty() && node.textSelectionStart == -1 && node.textSelectionEnd == -1) 0 to 0
            else node.textSelectionStart to node.textSelectionEnd

        fun isSupported(node: AccessibilityNodeInfo, inputConnectionAvailable: Boolean = false): Boolean = node.isEditable && node.isEnabled &&
            node.isFocused && node.isVisibleToUser && !node.isPassword && !EditorPolicy.isSensitive(node.inputType) &&
            (inputConnectionAvailable || node.actionList.any { it.id == AccessibilityNodeInfo.ACTION_SET_TEXT })

        fun capture(node: AccessibilityNodeInfo?, inputConnectionAvailable: Boolean = false): FocusedEditor? {
            if (node == null || !isSupported(node, inputConnectionAvailable)) return null
            val text = textOf(node)
            val (start, end) = selectionOf(node, text)
            if (start !in 0..text.length || end !in 0..text.length) return null
            val styled = if (text.isEmpty()) "" else SpannedString(node.text ?: "")
            return FocusedEditor(node, text, styled, start, end, inputConnectionAvailable)
        }
    }
}
