package com.aliahad.wovoice.voice

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechSignalDetectorTest {
    @Test
    fun acceptsLowGainSpeechFromQuietAndroidInput() {
        val detector = SpeechSignalDetector()

        repeat(8) {
            detector.observe(alternatingSamples(amplitude = 100, count = 1_024), 1_024)
        }

        val result = detector.result()
        assertTrue(result.peakRms < 0.012f)
        assertTrue(result.containsSpeech)
    }

    @Test
    fun rejectsDigitalSilence() {
        val detector = SpeechSignalDetector()

        repeat(8) { detector.observe(ShortArray(1_024), 1_024) }

        assertFalse(detector.result().containsSpeech)
    }

    @Test
    fun rejectsVeryLowElectricalNoise() {
        val detector = SpeechSignalDetector()

        repeat(8) {
            detector.observe(alternatingSamples(amplitude = 20, count = 1_024), 1_024)
        }

        assertFalse(detector.result().containsSpeech)
    }

    @Test
    fun rejectsAnAccidentalShortTap() {
        val detector = SpeechSignalDetector()

        repeat(2) {
            detector.observe(alternatingSamples(amplitude = 500, count = 1_024), 1_024)
        }

        assertFalse(detector.result().containsSpeech)
    }

    private fun alternatingSamples(amplitude: Int, count: Int): ShortArray =
        ShortArray(count) { index -> if (index % 2 == 0) amplitude.toShort() else (-amplitude).toShort() }
}
