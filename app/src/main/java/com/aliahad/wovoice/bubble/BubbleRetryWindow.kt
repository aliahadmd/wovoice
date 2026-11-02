package com.aliahad.wovoice.bubble

/** A failed upload can be retried briefly; retrying never extends its original local lifetime. */
internal data class BubbleRetryWindow(val expiresAtMs: Long, val attempts: Int) {
    fun allowsRetry(nowMs: Long, retryable: Boolean): Boolean =
        retryable && nowMs < expiresAtMs && attempts < MAX_ATTEMPTS

    fun nextAttempt(): BubbleRetryWindow = copy(attempts = attempts + 1)

    companion object {
        const val LIFETIME_MS = 60_000L
        const val MAX_ATTEMPTS = 3
        fun afterFirstFailure(nowMs: Long) = BubbleRetryWindow(nowMs + LIFETIME_MS, 1)
    }
}
