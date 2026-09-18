package com.aliahad.wovoice.core

sealed interface KeyboardState {
    data object VoiceIdle : KeyboardState
    data object Recording : KeyboardState
    data object Processing : KeyboardState
    data class Error(val message: String) : KeyboardState
    data object ManualKeyboard : KeyboardState
}

class EditorSessionGuard {
    private var generation = 0L

    fun begin(): Long = ++generation

    fun invalidate() {
        generation++
    }

    fun isActive(session: Long): Boolean = session == generation
}
