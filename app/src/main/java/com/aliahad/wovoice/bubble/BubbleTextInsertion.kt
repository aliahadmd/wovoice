package com.aliahad.wovoice.bubble

import com.aliahad.wovoice.core.TextCommitPolicy

/** Local editor text is used only to preserve the selection; it never goes to the API. */
internal data class BubbleTextInsertion(val text: String, val cursor: Int) {
    // HTML editors can represent the space just inserted by an IME as NBSP.
    // Keep this equivalence confined to acknowledgement; the pre-edit guard stays exact.
    fun matchesObservedText(observed: String): Boolean = text.replace('\u00a0', ' ') == observed.replace('\u00a0', ' ')

    companion object {
        fun create(original: String, start: Int, end: Int, transcript: String): BubbleTextInsertion? {
            if (start !in 0..original.length || end !in 0..original.length || transcript.isBlank()) return null
            val from = minOf(start, end)
            val to = maxOf(start, end)
            val prefix = original.substring(0, from)
            val suffix = original.substring(to)
            var inserted = TextCommitPolicy.withLocalSpacing(prefix.lastOrNull(), transcript.trim())
            if (suffix.firstOrNull()?.let { it.isLetterOrDigit() } == true &&
                inserted.lastOrNull()?.isWhitespace() == false
            ) inserted += " "
            return BubbleTextInsertion(prefix + inserted + suffix, prefix.length + inserted.length)
        }
    }
}
