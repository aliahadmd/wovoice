package com.aliahad.wovoice.core

object TextCommitPolicy {
    private val noSpaceBefore = setOf('.', ',', '!', '?', ';', ':', '%', ')', ']', '}')
    private val opening = setOf('(', '[', '{', '/', '\n')

    fun withLocalSpacing(previousCharacter: Char?, transcript: String): String {
        val text = transcript.trimEnd()
        if (text.isEmpty() || previousCharacter == null) return text
        val first = text.first()
        if (previousCharacter.isWhitespace() || previousCharacter in opening || first in noSpaceBefore || first == '\n') {
            return text
        }
        return " $text"
    }

    fun isSentenceStart(previousCharacter: Char?): Boolean =
        previousCharacter == null || previousCharacter == '\n' || previousCharacter in setOf('.', '!', '?')

    /**
     * Sentence boundary judged from the text before the cursor, looking past spaces:
     * after "Hello. " the adjacent character is a space, which the single-character
     * check reads as mid-sentence, so dictation lost its capital and the keyboard its shift.
     */
    fun isSentenceStartAfter(textBeforeCursor: CharSequence?): Boolean =
        isSentenceStart(textBeforeCursor?.trimEnd { it == ' ' || it == '\t' || it == '\u00A0' }?.lastOrNull())
}

object DeletePolicy {
    fun utf16UnitsForLastCodePoint(text: CharSequence): Int {
        if (text.isEmpty()) return 0
        val last = text[text.length - 1]
        return if (Character.isLowSurrogate(last) && text.length >= 2 && Character.isHighSurrogate(text[text.length - 2])) 2 else 1
    }
}

class ShiftState {
    var shifted: Boolean = true
        private set
    var capsLocked: Boolean = false
        private set
    private var lastTapAt = 0L

    fun tap(now: Long) {
        if (now - lastTapAt <= 350L && lastTapAt != 0L) {
            capsLocked = true
            shifted = true
        } else if (capsLocked) {
            capsLocked = false
            shifted = false
        } else {
            shifted = !shifted
        }
        lastTapAt = now
    }

    fun consumeLetter() {
        if (shifted && !capsLocked) shifted = false
    }

    fun resetForField(sentenceStart: Boolean) {
        capsLocked = false
        shifted = sentenceStart
        lastTapAt = 0L
    }
}
