package com.aliahad.wovoice.desktop.capture

import com.aliahad.wovoice.voice.SpeechSignalDetector
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.atomic.AtomicBoolean
import javax.sound.sampled.AudioFormat
import javax.sound.sampled.AudioSystem
import kotlin.concurrent.thread

/**
 * Desktop port of the phone's WavRecorder: captures mono 16-bit PCM, converts to
 * 16 kHz (resampling from the device's native rate when required), writes the same
 * 44-byte-header WAV the Worker validates, applies the identical 60-second cap and
 * silence gate, and keeps finish()/cancel() semantics.
 */
class DesktopWavRecorder(
    private val file: File,
    private val callback: Callback,
) {
    interface Callback {
        fun onStarted(nativeRate: Int, resampled: Boolean, mixerName: String, availableMixers: String)
        fun onLevel(rms: Float)
        fun onComplete(result: RecordingResult)
        fun onError(message: String)
    }

    data class RecordingResult(
        val file: File,
        val durationMs: Long,
        val containsSpeech: Boolean,
        val activeSpeechMs: Long,
        val averageRms: Float,
        val peakRms: Float,
    )

    private val running = AtomicBoolean(false)
    private val keepFile = AtomicBoolean(true)
    @Volatile private var line: javax.sound.sampled.TargetDataLine? = null

    fun start(): Boolean {
        if (!running.compareAndSet(false, true)) return false
        val opened = openLine()
        if (opened == null) {
            running.set(false)
            callback.onError("The microphone could not be opened.")
            return false
        }
        val (dataLine, nativeRate, resampled, mixerName, available) = opened
        line = dataLine
        thread(name = "WoVoiceDesktopRecorder") {
            recordLoop(dataLine, nativeRate, resampled, mixerName, available)
        }
        return true
    }

    fun finish() {
        keepFile.set(true)
        running.set(false)
        line?.stop()
        line?.close()
    }

    fun cancel() {
        keepFile.set(false)
        running.set(false)
        line?.stop()
        line?.close()
    }

    /** Returns the opened line, capture rate, resample flag, chosen mixer, and all mixer names. */
    private fun openLine(): Quintuple<javax.sound.sampled.TargetDataLine, Int, Boolean, String, String>? {
        val allNames = AudioSystem.getMixerInfo().joinToString(" | ") { it.name }
        val mixers = AudioSystem.getMixerInfo().toList()
        // Hardware microphones first; virtual devices (Camo, aggregates) last.
        val preferred = mixers.filter { it.name.contains("mic", ignoreCase = true) || it.name.contains("MacBook", ignoreCase = true) }
        val ordered = preferred + (mixers - preferred.toSet())
        for (rate in intArrayOf(SAMPLE_RATE, 48_000, 44_100)) {
            val resampled = rate != SAMPLE_RATE
            for (mixerInfo in ordered) {
                val line = runCatching {
                    val mixer = AudioSystem.getMixer(mixerInfo)
                    val info = javax.sound.sampled.DataLine.Info(javax.sound.sampled.TargetDataLine::class.java, AudioFormat(rate.toFloat(), 16, 1, true, false))
                    if (!mixer.isLineSupported(info)) return@runCatching null
                    val candidate = mixer.getLine(info) as javax.sound.sampled.TargetDataLine
                    candidate.open(AudioFormat(rate.toFloat(), 16, 1, true, false), BUFFER_BYTES)
                    candidate.start()
                    candidate
                }.getOrNull() ?: continue
                return Quintuple(line, rate, resampled, mixerInfo.name, allNames)
            }
        }
        return null
    }

    private fun recordLoop(
        dataLine: javax.sound.sampled.TargetDataLine,
        nativeRate: Int,
        resampled: Boolean,
        mixerName: String,
        availableMixers: String,
    ) {
        val detector = SpeechSignalDetector(SAMPLE_RATE)
        var dataBytes = 0L
        // Carry samples between reads when resampling so group boundaries stay aligned.
        val carry = ArrayList<Short>()
        try {
            RandomAccessFile(file, "rw").use { output ->
                output.setLength(0)
                output.write(ByteArray(WAV_HEADER_BYTES))
                callback.onStarted(nativeRate, resampled, mixerName, availableMixers)
                val byteBuffer = ByteArray(4_096)
                while (running.get() && dataBytes < MAX_DATA_BYTES) {
                    val read = dataLine.read(byteBuffer, 0, byteBuffer.size)
                    if (read <= 0) continue
                    val samples = toShortSamples(byteBuffer, read)
                    val at16k = if (resampled) downsample(carry, samples, nativeRate) else samples
                    if (at16k.isEmpty()) continue
                    val pcm = toLittleEndian(at16k)
                    output.write(pcm)
                    val rms = detector.observe(at16k, at16k.size)
                    dataBytes += at16k.size * 2L
                    callback.onLevel(rms)
                }
                writeHeader(output, dataBytes)
            }
            val signal = detector.result()
            if (keepFile.get() && dataBytes > 0L) {
                callback.onComplete(
                    RecordingResult(
                        file = file,
                        durationMs = signal.durationMs,
                        containsSpeech = signal.containsSpeech,
                        activeSpeechMs = signal.activeMs,
                        averageRms = signal.averageRms,
                        peakRms = signal.peakRms,
                    ),
                )
            } else {
                file.delete()
            }
        } catch (_: Exception) {
            file.delete()
            if (keepFile.get()) callback.onError("Recording stopped unexpectedly.")
        } finally {
            running.set(false)
            runCatching { dataLine.stop() }
            runCatching { dataLine.close() }
            line = null
        }
    }

    private fun toShortSamples(bytes: ByteArray, count: Int): ShortArray {
        val samples = ShortArray(count / 2)
        for (index in samples.indices) {
            samples[index] = ((bytes[index * 2].toInt() and 0xff) or (bytes[index * 2 + 1].toInt() shl 8)).toShort()
        }
        return samples
    }

    /** Naive rate conversion by averaging each group of `factor` samples (48k→16k = 3). */
    private fun downsample(carry: MutableList<Short>, samples: ShortArray, nativeRate: Int): ShortArray {
        val factor = (nativeRate / SAMPLE_RATE).coerceAtLeast(1)
        if (factor == 1) return samples
        val pooled = carry.toList() + samples.toList()
        carry.clear()
        val usable = pooled.size / factor * factor
        carry.addAll(pooled.subList(usable, pooled.size))
        val out = ShortArray(usable / factor)
        for (index in out.indices) {
            var sum = 0
            for (offset in 0 until factor) sum += pooled[index * factor + offset]
            out[index] = (sum / factor).toShort()
        }
        return out
    }

    private fun toLittleEndian(samples: ShortArray): ByteArray {
        val pcm = ByteArray(samples.size * 2)
        for (index in samples.indices) {
            val sample = samples[index].toInt()
            pcm[index * 2] = (sample and 0xff).toByte()
            pcm[index * 2 + 1] = ((sample ushr 8) and 0xff).toByte()
        }
        return pcm
    }

    private fun writeHeader(file: RandomAccessFile, dataBytes: Long) {
        file.seek(0)
        file.writeAscii("RIFF")
        file.writeLittleEndianInt((36L + dataBytes).toInt())
        file.writeAscii("WAVEfmt ")
        file.writeLittleEndianInt(16)
        file.writeLittleEndianShort(1)
        file.writeLittleEndianShort(1)
        file.writeLittleEndianInt(SAMPLE_RATE)
        file.writeLittleEndianInt(SAMPLE_RATE * 2)
        file.writeLittleEndianShort(2)
        file.writeLittleEndianShort(16)
        file.writeAscii("data")
        file.writeLittleEndianInt(dataBytes.toInt())
    }

    private fun RandomAccessFile.writeAscii(value: String) = write(value.toByteArray(Charsets.US_ASCII))
    private fun RandomAccessFile.writeLittleEndianShort(value: Int) {
        write(value and 0xff)
        write((value ushr 8) and 0xff)
    }
    private fun RandomAccessFile.writeLittleEndianInt(value: Int) {
        write(value and 0xff)
        write((value ushr 8) and 0xff)
        write((value ushr 16) and 0xff)
        write((value ushr 24) and 0xff)
    }

    private companion object {
        const val SAMPLE_RATE = 16_000
        const val WAV_HEADER_BYTES = 44
        const val MAX_DATA_BYTES = SAMPLE_RATE * 2L * 60
        const val BUFFER_BYTES = 8_192
    }
}

private data class Quintuple<A, B, C, D, E>(val first: A, val second: B, val third: C, val fourth: D, val fifth: E)
