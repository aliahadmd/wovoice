package com.aliahad.wovoice.voice

import kotlin.math.sqrt

/**
 * Rejects only recordings that are effectively digital silence.
 *
 * Audio input gain varies substantially between Android devices and audio sources. In particular,
 * VOICE_RECOGNITION can be much quieter than MIC on some Xiaomi builds, so this detector uses a
 * low absolute floor and leaves the actual voice-activity decision to the server-side ASR model.
 */
class SpeechSignalDetector(
    private val sampleRate: Int = DEFAULT_SAMPLE_RATE,
) {
    private var totalSamples = 0L
    private var activeSamples = 0L
    private var totalSquares = 0.0
    private var peakFrameRms = 0f

    fun observe(samples: ShortArray, count: Int): Float {
        if (count <= 0) return 0f
        var squares = 0.0
        for (index in 0 until count) {
            val sample = samples[index].toDouble()
            squares += sample * sample
        }
        val rms = (sqrt(squares / count) / Short.MAX_VALUE).toFloat().coerceIn(0f, 1f)
        totalSamples += count
        totalSquares += squares
        peakFrameRms = maxOf(peakFrameRms, rms)
        if (rms >= ACTIVE_FRAME_RMS) activeSamples += count
        return rms
    }

    fun result(): Result {
        val durationMs = samplesToMillis(totalSamples)
        val activeMs = samplesToMillis(activeSamples)
        val averageRms = if (totalSamples == 0L) {
            0f
        } else {
            (sqrt(totalSquares / totalSamples) / Short.MAX_VALUE).toFloat().coerceIn(0f, 1f)
        }
        return Result(
            containsSpeech = durationMs >= MIN_RECORDING_MS &&
                activeMs >= MIN_ACTIVE_MS &&
                peakFrameRms >= MIN_PEAK_FRAME_RMS,
            durationMs = durationMs,
            activeMs = activeMs,
            averageRms = averageRms,
            peakRms = peakFrameRms,
        )
    }

    private fun samplesToMillis(samples: Long): Long = samples * 1_000L / sampleRate

    data class Result(
        val containsSpeech: Boolean,
        val durationMs: Long,
        val activeMs: Long,
        val averageRms: Float,
        val peakRms: Float,
    )

    private companion object {
        const val DEFAULT_SAMPLE_RATE = 16_000
        const val MIN_RECORDING_MS = 250L
        const val MIN_ACTIVE_MS = 120L

        // Approximately -56.5 dBFS and -52 dBFS. These reject near-zero captures without
        // mistaking a low-gain microphone for silence.
        const val ACTIVE_FRAME_RMS = 0.0015f
        const val MIN_PEAK_FRAME_RMS = 0.0025f
    }
}
