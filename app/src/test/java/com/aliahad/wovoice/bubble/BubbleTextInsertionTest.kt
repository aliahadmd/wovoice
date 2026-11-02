package com.aliahad.wovoice.bubble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

class BubbleTextInsertionTest {
    @Test fun confirmsHtmlNonBreakingSpacesWithoutIgnoringOtherEdits() {
        val result = BubbleTextInsertion.create("Bold tail", 9, 9, "spoken")!!
        assertTrue(result.matchesObservedText("Bold tail\u00a0spoken"))
        assertFalse(result.matchesObservedText("Bold tail\nspoken"))
        assertFalse(result.matchesObservedText("Bold tail spoken twice"))
    }
    @Test fun insertsAtCursorWithoutLosingSurroundingText() {
        val result = BubbleTextInsertion.create("Before after", 6, 6, "spoken words")!!
        assertEquals("Before spoken words after", result.text)
        assertEquals(19, result.cursor)
    }

    @Test fun replacesOnlyTheSelectedRangeIncludingReversedSelections() {
        assertEquals("Hello new name!", BubbleTextInsertion.create("Hello old name!", 6, 14, "new name")!!.text)
        assertEquals("Hello new name!", BubbleTextInsertion.create("Hello old name!", 14, 6, "new name")!!.text)
    }

    @Test fun handlesEmptyFieldsPunctuationAndEmoji() {
        assertEquals("Hello.", BubbleTextInsertion.create("", 0, 0, "Hello.")!!.text)
        assertEquals("Hello!", BubbleTextInsertion.create("Hello", 5, 5, "!")!!.text)
        assertEquals("😀 Hello", BubbleTextInsertion.create("😀", 2, 2, "Hello")!!.text)
        assertEquals("Hello world", BubbleTextInsertion.create("world", 0, 0, "Hello")!!.text)
    }

    @Test fun refusesMissingSelectionsAndEmptyTranscripts() {
        assertNull(BubbleTextInsertion.create("Hello", -1, -1, "Words"))
        assertNull(BubbleTextInsertion.create("Hello", 0, 10, "Words"))
        assertNull(BubbleTextInsertion.create("Hello", 5, 5, "  "))
    }
}
