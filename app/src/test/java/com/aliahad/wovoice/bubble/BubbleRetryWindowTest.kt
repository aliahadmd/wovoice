package com.aliahad.wovoice.bubble

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BubbleRetryWindowTest {
    @Test fun expiresAtTheOriginalDeadline() {
        val window = BubbleRetryWindow.afterFirstFailure(1_000)
        assertTrue(window.allowsRetry(60_999, true))
        assertFalse(window.allowsRetry(61_000, true))
    }

    @Test fun retriesDoNotExtendRetentionAndStopAfterThreeAttempts() {
        val first = BubbleRetryWindow.afterFirstFailure(1_000)
        val second = first.nextAttempt()
        assertTrue(second.allowsRetry(20_000, true))
        val third = second.nextAttempt()
        assertEquals(first.expiresAtMs, third.expiresAtMs)
        assertFalse(third.allowsRetry(20_000, true))
    }

    @Test fun accountAndOtherPermanentFailuresAreNotRetried() {
        assertFalse(BubbleRetryWindow.afterFirstFailure(1_000).allowsRetry(2_000, false))
    }
}
