package com.aliahad.wovoice.voice

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import androidx.core.content.ContextCompat
import java.io.File
import java.io.RandomAccessFile
import java.util.concurrent.atomic.AtomicBoolean

class WavRecorder(
    private val context: Context,
    private val file: File,
    private val callback: Callback,
) {
    interface Callback {
        fun onStarted()
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
    private var audioRecord: AudioRecord? = null
    private var thread: Thread? = null

    fun start() {
        if (!running.compareAndSet(false, true)) return
        thread = Thread(::recordLoop, "WoVoiceRecorder").apply { start() }
    }

    fun finish() {
        keepFile.set(true)
        running.set(false)
        audioRecord?.stopSafely()
    }

    fun cancel() {
        keepFile.set(false)
        running.set(false)
        audioRecord?.stopSafely()
    }

    @SuppressLint("MissingPermission")
    private fun recordLoop() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            running.set(false)
            callback.onError("Microphone permission is required.")
            return
        }
        val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
        if (minBuffer <= 0) {
            running.set(false)
            callback.onError("The microphone could not be opened.")
            return
        }
        val recorder = createStartedRecorder(maxOf(minBuffer * 2, 4_096))
        if (recorder == null) {
            running.set(false)
            callback.onError("The microphone is busy or unavailable.")
            return
        }
        audioRecord = recorder

        var dataBytes = 0L
        val speechDetector = SpeechSignalDetector(SAMPLE_RATE)
        val buffer = ShortArray(maxOf(minBuffer / 2, 1_024))
        try {
            RandomAccessFile(file, "rw").use { output ->
                output.setLength(0)
                output.write(ByteArray(WAV_HEADER_BYTES))
                callback.onStarted()
                while (running.get() && dataBytes < MAX_DATA_BYTES) {
                    val count = recorder.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                    if (count <= 0) {
                        if (count == AudioRecord.ERROR_DEAD_OBJECT || count == AudioRecord.ERROR_INVALID_OPERATION) break
                        continue
                    }
                    val pcm = ByteArray(count * 2)
                    for (index in 0 until count) {
                        val sample = buffer[index].toInt()
                        pcm[index * 2] = (sample and 0xff).toByte()
                        pcm[index * 2 + 1] = ((sample ushr 8) and 0xff).toByte()
                    }
                    output.write(pcm)
                    val rms = speechDetector.observe(buffer, count)
                    dataBytes += count * 2L
                    callback.onLevel(rms)
                }
                writeHeader(output, dataBytes)
            }
            val signal = speechDetector.result()
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
            recorder.stopSafely()
            recorder.release()
            audioRecord = null
        }
    }

    @SuppressLint("MissingPermission")
    private fun createStartedRecorder(bufferSize: Int): AudioRecord? {
        for (source in intArrayOf(MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC)) {
            val candidate = runCatching {
                AudioRecord.Builder()
                    .setAudioSource(source)
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setEncoding(ENCODING)
                            .setSampleRate(SAMPLE_RATE)
                            .setChannelMask(CHANNEL)
                            .build(),
                    )
                    .setBufferSizeInBytes(bufferSize)
                    .build()
            }.getOrNull() ?: continue
            if (candidate.state != AudioRecord.STATE_INITIALIZED) {
                candidate.release()
                continue
            }
            val started = runCatching {
                candidate.startRecording()
                candidate.recordingState == AudioRecord.RECORDSTATE_RECORDING
            }.getOrDefault(false)
            if (started) return candidate
            candidate.release()
        }
        return null
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
        file.writeLittleEndianInt(BYTES_PER_SECOND)
        file.writeLittleEndianShort(2)
        file.writeLittleEndianShort(16)
        file.writeAscii("data")
        file.writeLittleEndianInt(dataBytes.toInt())
    }

    private fun AudioRecord.stopSafely() {
        runCatching { if (recordingState == AudioRecord.RECORDSTATE_RECORDING) stop() }
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
        const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
        const val WAV_HEADER_BYTES = 44
        const val BYTES_PER_SECOND = SAMPLE_RATE * 2
        const val MAX_DATA_BYTES = BYTES_PER_SECOND * 60L
    }
}
