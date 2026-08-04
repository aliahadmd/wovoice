package com.aliahad.wovoice.core

object CorrectionLearning {
    private val token = Regex("[\\p{L}\\p{N}]+(?:['’\u2010-\u2015-][\\p{L}\\p{N}]+)*")
    private val rejected = setOf(
        "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "had", "has",
        "have", "he", "her", "his", "i", "in", "is", "it", "me", "my", "not", "of", "on", "or",
        "our", "she", "that", "the", "their", "there", "they", "this", "to", "was", "we", "were",
        "will", "with", "you", "your",
    )

    fun suggestion(generated: String, textBeforeCursor: String): String? {
        val original = tokens(generated)
        if (original.isEmpty() || original.size > 60) return null
        val current = tokens(textBeforeCursor).takeLast(original.size + 2)
        if (current.isEmpty()) return null

        var best: Candidate? = null
        for (size in (original.size - 1).coerceAtLeast(1)..(original.size + 1)) {
            if (current.size < size) continue
            val window = current.takeLast(size)
            val candidate = compare(original, window) ?: continue
            if (best == null || candidate.unchanged > best.unchanged) best = candidate
        }
        val value = best?.replacement ?: return null
        val normalized = value.lowercase()
        if (normalized in rejected || value.length !in 2..80 || value.all(Char::isDigit)) return null
        if (value.contains('@') || value.contains("//")) return null
        return value
    }

    private fun compare(original: List<String>, current: List<String>): Candidate? {
        var prefix = 0
        while (prefix < minOf(original.size, current.size) && equivalent(original[prefix], current[prefix])) prefix++
        var suffix = 0
        while (
            suffix < original.size - prefix && suffix < current.size - prefix &&
            equivalent(original[original.lastIndex - suffix], current[current.lastIndex - suffix])
        ) suffix++
        val changedOriginal = original.subList(prefix, original.size - suffix)
        val changedCurrent = current.subList(prefix, current.size - suffix)
        if (changedCurrent.size != 1 || changedOriginal.isEmpty() || changedOriginal.size > 2) return null
        if (original.size > 2 && prefix + suffix < original.size - 2) return null
        val replacement = changedCurrent.single()
        if (changedOriginal.size == 1 && equivalent(changedOriginal.single(), replacement)) return null
        return Candidate(replacement, prefix + suffix)
    }

    private fun equivalent(first: String, second: String): Boolean = first.equals(second, ignoreCase = true)
    private fun tokens(value: String): List<String> = token.findAll(value).map { it.value }.toList()
    private data class Candidate(val replacement: String, val unchanged: Int)
}
