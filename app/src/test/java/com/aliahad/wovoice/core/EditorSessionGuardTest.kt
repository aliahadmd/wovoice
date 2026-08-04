package com.aliahad.wovoice.core

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EditorSessionGuardTest {
    @Test
    fun invalidationRejectsLateResult() {
        val guard = EditorSessionGuard()
        val first = guard.begin()
        assertTrue(guard.isActive(first))
        guard.invalidate()
        assertFalse(guard.isActive(first))
        val second = guard.begin()
        assertTrue(guard.isActive(second))
    }
}
