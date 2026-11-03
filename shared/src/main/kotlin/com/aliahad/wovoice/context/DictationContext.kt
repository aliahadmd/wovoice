package com.aliahad.wovoice.context

import java.util.Locale

enum class ContextLevel(val wire: String) { OFF("off"), APP("app"), NEARBY("nearby");
    companion object { fun from(value: String?) = entries.firstOrNull { it.wire == value } ?: OFF }
}

data class DictationContext(
    val level: String, val purpose: String, val audience: String = "unknown", val source: String = "unknown",
    val style: String = "auto", val before: String? = null, val after: String? = null,
) {
    fun restricted(level: ContextLevel): DictationContext? = when (level) {
        ContextLevel.OFF -> null
        ContextLevel.NEARBY -> this
        ContextLevel.APP -> copy(level = "app", audience = "unknown", source = if (source == "nearby") "unknown" else source, before = null, after = null)
    }
    val label: String get() {
        val task = when (purpose) { "chat" -> "Chat"; "work_chat" -> "Work chat"; "email" -> "Email"; "subject" -> "Subject"; "post" -> "Post"; "comment" -> "Comment"; "notes" -> "Notes"; "search" -> "Search"; "literal" -> "Literal"; "code" -> "Code"; else -> "Natural" }
        val tone = if (style != "auto") style else when (audience) { "academic" -> "polite"; "customer", "colleague" -> "professional"; else -> "" }
        return task + if (tone.isEmpty()) "" else " · $tone"
    }
}

/** Keep this pure policy in parity with worker/src/context.ts; neither sends OS app IDs or labels. */
object ContextPolicy {
    val styles = listOf("auto", "natural", "polite", "professional", "concise")
    fun detect(appId: String, hint: String = "", field: String = "text", level: ContextLevel,
        style: String = "auto", before: String = "", after: String = ""): DictationContext? {
        if (level == ContextLevel.OFF) return null
        val app = appId.lowercase(Locale.ROOT)
        val label = hint.take(256).lowercase(Locale.ROOT)
        var source = "field"
        var purpose = when {
            field in listOf("literal", "code", "search") -> field
            Regex("\\b(search|search query)\\b").containsMatchIn(label) -> "search"
            Regex("\\b(subject|email subject)\\b").containsMatchIn(label) -> "subject"
            Regex("\\b(comment|reply to post)\\b").containsMatchIn(label) -> "comment"
            Regex("\\b(write a post|create post|what.?s on your mind|share an update|new post)\\b").containsMatchIn(label) -> "post"
            else -> "unknown"
        }
        if (purpose == "unknown") {
            purpose = when (app) {
                "com.google.android.gm", "com.microsoft.office.outlook", "com.microsoft.outlook", "com.apple.mail", "org.mozilla.thunderbird" -> "email"
                "com.whatsapp", "net.whatsapp.whatsapp", "com.whatsapp.w4b", "com.facebook.orca", "com.tencent.mm", "com.tencent.xinwechat", "com.apple.ichat", "org.telegram.messenger", "ru.keepcoder.telegram", "ph.telegra.telegraph", "org.thoughtcrime.securesms", "org.whispersystems.signal-desktop", "com.discord" -> "chat"
                "com.slack", "com.tinyspeck.slackmacgap", "com.microsoft.teams", "com.microsoft.teams2" -> "work_chat"
                "com.apple.notes", "com.miui.notes", "com.google.android.keep", "com.microsoft.office.onenote", "notion.id" -> "notes"
                "com.apple.terminal", "com.googlecode.iterm2", "com.microsoft.vscode", "com.sublimetext.4" -> "code"
                else -> "unknown"
            }
            source = if (purpose == "unknown") "unknown" else "app"
        }
        if (purpose == "unknown" && Regex("\\b(message|chat|reply)\\b").containsMatchIn(label)) { purpose = "chat"; source = "field" }
        val left = if (level == ContextLevel.NEARBY && purpose !in listOf("literal", "search", "code")) utf8Tail(before.replace("\u0000", "").takeLast(512).dropWhile { Character.isLowSurrogate(it) }, 1536) else ""
        val right = if (level == ContextLevel.NEARBY && purpose !in listOf("literal", "search", "code")) utf8Head(after.replace("\u0000", "").take(128).dropLastWhile { Character.isHighSurrogate(it) }, 2048 - left.toByteArray(Charsets.UTF_8).size) else ""
        var audience = "unknown"
        if (level == ContextLevel.NEARBY && purpose !in listOf("literal", "search", "code")) {
            val greeting = Regex("(?:^|\\n)\\s*(?:dear|hi|hello|hey)\\s+(professor|prof\\.?|mom|mum|dad|team|customer|client)\\b", RegexOption.IGNORE_CASE).find(left)?.groupValues?.get(1)?.lowercase(Locale.ROOT)
            if (greeting != null) {
                audience = when { greeting.startsWith("prof") -> "academic"; greeting in listOf("mom", "mum", "dad") -> "family"; greeting == "team" -> "colleague"; else -> "customer" }
                source = "nearby"
            }
        }
        return DictationContext(level.wire, purpose, audience, source, style.takeIf(styles::contains) ?: "auto", left.ifEmpty { null }, right.ifEmpty { null })
    }
    private fun utf8Head(text: String, maximum: Int): String {
        val out = StringBuilder(); var bytes = 0; var index = 0
        while (index < text.length) { val point = text.codePointAt(index); val token = String(Character.toChars(point)); val size = token.toByteArray(Charsets.UTF_8).size
            if (bytes + size > maximum) break
            out.append(token); bytes += size; index += Character.charCount(point)
        }
        return out.toString()
    }
    private fun utf8Tail(text: String, maximum: Int): String {
        val points = text.codePoints().toArray().reversedArray()
        val reversed = StringBuilder(); points.forEach { reversed.appendCodePoint(it) }
        val head = utf8Head(reversed.toString(), maximum)
        return StringBuilder().also { out -> head.codePoints().toArray().reversedArray().forEach { out.appendCodePoint(it) } }.toString()
    }
}
