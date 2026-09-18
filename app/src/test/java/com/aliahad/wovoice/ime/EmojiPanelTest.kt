package com.aliahad.wovoice.ime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class EmojiRecentsTest {

    @Test
    fun `most recent emoji moves to front`() {
        val updated = EmojiRecents.updated(listOf("😀", "😂", "👍"), "😂")
        assertEquals(listOf("😂", "😀", "👍"), updated)
    }

    @Test
    fun `new emoji is prepended`() {
        val updated = EmojiRecents.updated(listOf("😀", "👍"), "🎉")
        assertEquals(listOf("🎉", "😀", "👍"), updated)
    }

    @Test
    fun `cap keeps only the newest entries`() {
        var recents = listOf<String>()
        for (index in 0 until 40) recents = EmojiRecents.updated(recents, "e$index", cap = 10)
        assertEquals(10, recents.size)
        assertEquals("e39", recents.first())
        assertEquals("e30", recents.last())
    }

    @Test
    fun `blank emoji is ignored`() {
        val updated = EmojiRecents.updated(listOf("😀"), "  ")
        assertEquals(listOf("😀"), updated)
    }

    @Test
    fun `default cap matches the settings budget`() {
        assertEquals(32, EmojiRecents.DEFAULT_CAP)
        var recents = listOf<String>()
        for (index in 0 until 50) recents = EmojiRecents.updated(recents, "e$index")
        assertEquals(EmojiRecents.DEFAULT_CAP, recents.size)
    }
}

class EmojiCatalogTest {

    @Test
    fun `catalog covers the eight planned categories`() {
        assertEquals(8, EmojiCatalog.categories.size)
    }

    @Test
    fun `every entry is a clean single emoji token`() {
        EmojiCatalog.categories.forEach { category ->
            assertTrue("category ${category.label} is too small", category.emojis.size >= 30)
            category.emojis.forEach { emoji ->
                assertTrue("blank entry in ${category.label}", emoji.isNotBlank())
                assertEquals("untrimmed entry '$emoji' in ${category.label}", emoji, emoji.trim())
                assertTrue("whitespace inside entry '$emoji' in ${category.label}", emoji.none(Char::isWhitespace))
                assertTrue("entry '$emoji' in ${category.label} is not emoji-like", emoji.length in 1..8)
            }
        }
    }

    @Test
    fun `entries are unique within each category`() {
        EmojiCatalog.categories.forEach { category ->
            assertEquals(
                "duplicate entries in ${category.label}",
                category.emojis.size,
                category.emojis.toSet().size,
            )
        }
    }
}
