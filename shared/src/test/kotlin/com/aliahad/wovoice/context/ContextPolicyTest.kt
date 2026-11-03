package com.aliahad.wovoice.context

import org.junit.Assert.*
import org.junit.Test

class ContextPolicyTest {
    @Test fun `apps detect purpose without assuming recipient`() {
        for (app in listOf("com.whatsapp", "com.facebook.orca", "com.tencent.mm")) {
            val result = ContextPolicy.detect(app, level = ContextLevel.APP)!!
            assertEquals("chat", result.purpose); assertEquals("unknown", result.audience); assertNull(result.before)
        }
        assertEquals("notes", ContextPolicy.detect("com.miui.notes", level = ContextLevel.APP)!!.purpose)
        assertEquals("email", ContextPolicy.detect("com.google.android.gm", "Message", level = ContextLevel.APP)!!.purpose)
        assertEquals("subject", ContextPolicy.detect("com.google.android.gm", "Subject", level = ContextLevel.APP)!!.purpose)
        assertNull(ContextPolicy.detect("com.apple.Terminal", level = ContextLevel.NEARBY, before = "private command")!!.before)
        assertEquals("search", ContextPolicy.detect("com.whatsapp", field = "search", level = ContextLevel.APP)!!.purpose)
        assertEquals("unknown", ContextPolicy.detect("com.instagram.android", level = ContextLevel.APP)!!.purpose)
        assertEquals("post", ContextPolicy.detect("com.instagram.android", "Write a post", level = ContextLevel.APP)!!.purpose)
        assertEquals("comment", ContextPolicy.detect("com.instagram.android", "Add a comment", level = ContextLevel.APP)!!.purpose)
    }
    @Test fun `clues require nearby consent and explicit salutation`() {
        assertNull(ContextPolicy.detect("com.whatsapp", level = ContextLevel.OFF, before = "private"))
        assertEquals("unknown", ContextPolicy.detect("com.whatsapp", level = ContextLevel.APP, before = "Dear Professor Khan")!!.audience)
        val result = ContextPolicy.detect("com.whatsapp", level = ContextLevel.NEARBY, before = "Dear Professor Khan, ")!!
        assertEquals("academic", result.audience); assertEquals("nearby", result.source)
        assertNull(result.restricted(ContextLevel.APP)!!.before)
        assertEquals("unknown", result.restricted(ContextLevel.APP)!!.audience)
        assertNull(result.restricted(ContextLevel.OFF))
        assertEquals("unknown", ContextPolicy.detect("com.whatsapp", level = ContextLevel.NEARBY, before = "> Dear Professor Khan")!!.audience)
        assertEquals("unknown", ContextPolicy.detect("com.whatsapp", level = ContextLevel.NEARBY, before = "Hi Jon")!!.audience)
    }
    @Test fun `unicode snippets remain bounded and do not retain NUL`() {
        for (value in listOf("声".repeat(1000), "😀".repeat(1000), "a😀".repeat(1000))) {
            val result = ContextPolicy.detect("com.whatsapp", level = ContextLevel.NEARBY, before = value, after = value)!!
            assertTrue(result.before!!.length <= 512); assertTrue(result.after!!.length <= 128)
            assertTrue((result.before + result.after).toByteArray(Charsets.UTF_8).size <= 2048)
            assertFalse(result.before.any { it == '\uFFFD' })
        }
        assertEquals("Hi Mom", ContextPolicy.detect("com.whatsapp", level = ContextLevel.NEARBY, before = "Hi\u0000 Mom")!!.before)
    }
}
