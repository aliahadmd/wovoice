package com.aliahad.wovoice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class TextCommitPolicyTest {
    @Test
    fun addsOneSpaceAfterAWord() {
        assertEquals(" hello", TextCommitPolicy.withLocalSpacing('x', "hello"))
    }

    @Test
    fun doesNotAddSpaceAfterWhitespaceOrBeforePunctuation() {
        assertEquals("hello", TextCommitPolicy.withLocalSpacing(' ', "hello"))
        assertEquals("?", TextCommitPolicy.withLocalSpacing('x', "?"))
        assertEquals("\nNext", TextCommitPolicy.withLocalSpacing('x', "\nNext"))
    }

    @Test
    fun detectsSentenceBoundaryFromAdjacentCharacterOnly() {
        assertTrue(TextCommitPolicy.isSentenceStart(null))
        assertTrue(TextCommitPolicy.isSentenceStart('.'))
        assertFalse(TextCommitPolicy.isSentenceStart(','))
    }

    @Test
    fun sentenceStartLooksPastTrailingSpaces() {
        assertTrue(TextCommitPolicy.isSentenceStartAfter(null))
        assertTrue(TextCommitPolicy.isSentenceStartAfter(""))
        assertTrue(TextCommitPolicy.isSentenceStartAfter("   "))
        assertTrue(TextCommitPolicy.isSentenceStartAfter("Hello. "))
        assertTrue(TextCommitPolicy.isSentenceStartAfter("Really?\u00A0\u00A0"))
        assertTrue(TextCommitPolicy.isSentenceStartAfter("First line\n"))
        assertFalse(TextCommitPolicy.isSentenceStartAfter("Hello "))
        assertFalse(TextCommitPolicy.isSentenceStartAfter("Hello, "))
    }

    @Test
    fun unicodeDeleteCountsSurrogatePair() {
        assertEquals(2, DeletePolicy.utf16UnitsForLastCodePoint("a😀"))
        assertEquals(1, DeletePolicy.utf16UnitsForLastCodePoint("é"))
    }
}
