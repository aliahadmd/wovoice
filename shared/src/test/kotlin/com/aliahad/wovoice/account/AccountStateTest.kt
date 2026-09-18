package com.aliahad.wovoice.account

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AccountStateTest {
    @Test
    fun olderResponsesDefaultToOrdinaryActiveAccount() {
        assertEquals(AccountRole.USER, AccountRole.fromWire(null))
        assertEquals(AccountState.ACTIVE, AccountState.fromWire(null))
        assertFalse(AccountState.ACTIVE.restricted)
    }

    @Test
    fun adminAndRestrictionValuesAreParsedCaseInsensitively() {
        assertEquals(AccountRole.ADMIN, AccountRole.fromWire("ADMIN"))
        assertEquals(AccountState.SUSPENDED, AccountState.fromWire("Suspended"))
        assertEquals(AccountState.BANNED, AccountState.fromWire("banned"))
        assertTrue(AccountState.SUSPENDED.restricted)
        assertTrue(AccountState.BANNED.restricted)
    }

    @Test
    fun unknownServerValuesUseBackwardCompatibleDefaults() {
        assertEquals(AccountRole.USER, AccountRole.fromWire("owner"))
        assertEquals(AccountState.ACTIVE, AccountState.fromWire("unknown"))
    }
}
