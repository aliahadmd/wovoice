package com.aliahad.wovoice.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ShiftStateTest {
    @Test
    fun oneShotShiftClearsAfterLetter() {
        val state = ShiftState()
        assertTrue(state.shifted)
        state.consumeLetter()
        assertFalse(state.shifted)
    }

    @Test
    fun doubleTapEnablesCapsLockAndNextTapDisablesIt() {
        val state = ShiftState()
        state.tap(1_000)
        state.tap(1_200)
        assertTrue(state.capsLocked)
        assertTrue(state.shifted)
        state.tap(2_000)
        assertFalse(state.capsLocked)
        assertFalse(state.shifted)
    }
}
