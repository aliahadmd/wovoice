package com.aliahad.wovoice.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class CorrectionLearningTest {
    @Test
    fun suggestsOneCorrectedUniqueWord() {
        assertEquals(
            "Aliahad",
            CorrectionLearning.suggestion("Please call Alihad tomorrow.", "Earlier text Please call Aliahad tomorrow"),
        )
    }

    @Test
    fun ignoresPunctuationAndCommonWordChanges() {
        assertNull(CorrectionLearning.suggestion("hello world", "Hello, world"))
        assertNull(CorrectionLearning.suggestion("I am ready", "I was ready"))
    }

    @Test
    fun ignoresLargeRewrites() {
        assertNull(CorrectionLearning.suggestion("Please call Rahim tomorrow", "Cancel every meeting today"))
    }
}
