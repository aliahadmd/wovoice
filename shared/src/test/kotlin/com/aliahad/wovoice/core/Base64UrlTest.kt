package com.aliahad.wovoice.core

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class Base64UrlTest {
    @Test fun roundTripsWithoutPadding() {
        val value = byteArrayOf(0, 1, 2, 3, 0x7f, 0x80.toByte(), 0xff.toByte())
        val encoded = Base64Url.encode(value)
        assertEquals("AAECA3-A_w", encoded)
        assertArrayEquals(value, Base64Url.decode(encoded))
    }
}
