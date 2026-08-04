package com.aliahad.wovoice.account

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PkceTest {
    @Test fun matchesRfc7636Challenge() {
        val verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", Pkce.challenge(verifier))
    }

    @Test fun generatedRequestHasIndependentSafeValues() {
        val value = Pkce.create()
        assertTrue(value.verifier.length in 43..128)
        assertTrue(value.challenge.matches(Regex("[A-Za-z0-9_-]{43,128}")))
        assertTrue(value.state.length >= 20)
    }
}
