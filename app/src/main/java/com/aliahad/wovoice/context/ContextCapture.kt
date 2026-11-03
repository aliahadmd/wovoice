package com.aliahad.wovoice.context

import android.text.InputType
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import com.aliahad.wovoice.core.EditorPolicy
import com.aliahad.wovoice.settings.SettingsStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.withTimeoutOrNull

/** One user-triggered, account-bound capture. Late IPC never blocks recording or upload. */
class ContextCapture private constructor(
    private val owner: String?, private val baseline: DictationContext?, private val reading: Deferred<DictationContext?>?,
) {
    suspend fun snapshot(settings: SettingsStore): DictationContext? {
        if (owner != settings.accountId || settings.contextLevel == ContextLevel.OFF) { cancel(); return null }
        val value = reading?.let { withTimeoutOrNull(150) { try { it.await() } catch (cancelled: CancellationException) { currentCoroutineContext().ensureActive(); null } } } ?: baseline
        return (value ?: baseline)?.restricted(settings.contextLevel)?.copy(style = settings.contextStyle)
    }
    fun label(settings: SettingsStore): String? = baseline?.takeIf { owner == settings.accountId }?.restricted(settings.contextLevel)?.copy(style = settings.contextStyle)?.label

    fun cancel() { reading?.cancel() }
    companion object {
        fun start(scope: CoroutineScope, settings: SettingsStore, info: EditorInfo?, connection: InputConnection?): ContextCapture {
            val level = settings.contextLevel
            val allowed = info != null && !EditorPolicy.isSensitive(info.inputType) && info.imeOptions and EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING == 0
            if (!allowed || level == ContextLevel.OFF) return ContextCapture(settings.accountId, null, null)
            val app = info!!.packageName.orEmpty(); val hint = info.hintText?.toString().orEmpty()
            val field = field(info.inputType, info.imeOptions)
            val baseline = ContextPolicy.detect(app, hint, field, ContextLevel.APP, settings.contextStyle)
            val reading = if (level == ContextLevel.NEARBY && connection != null && field == "text" && baseline?.purpose !in listOf("literal", "search", "code")) scope.async(Dispatchers.IO) {
                runCatching { ContextPolicy.detect(app, hint, field, level, settings.contextStyle,
                    connection.getTextBeforeCursor(512, 0)?.toString().orEmpty(), connection.getTextAfterCursor(128, 0)?.toString().orEmpty()) }.getOrNull()
            } else null
            return ContextCapture(settings.accountId, baseline, reading)
        }
        fun field(inputType: Int, options: Int = 0): String {
            val kind = inputType and InputType.TYPE_MASK_CLASS
            val variation = inputType and InputType.TYPE_MASK_VARIATION
            return when {
                options and EditorInfo.IME_MASK_ACTION == EditorInfo.IME_ACTION_SEARCH -> "search"
                kind in listOf(InputType.TYPE_CLASS_NUMBER, InputType.TYPE_CLASS_PHONE, InputType.TYPE_CLASS_DATETIME) -> "literal"
                kind == InputType.TYPE_CLASS_TEXT && variation in listOf(InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS, InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS, InputType.TYPE_TEXT_VARIATION_URI) -> "literal"
                else -> "text"
            }
        }
    }
}
