package com.aliahad.wovoice.desktop

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Tray
import androidx.compose.ui.window.Window
import androidx.compose.ui.window.application
import androidx.compose.ui.window.rememberTrayState
import androidx.compose.ui.window.rememberWindowState
import com.aliahad.wovoice.desktop.capture.DesktopWavRecorder
import java.awt.image.BufferedImage
import java.io.ByteArrayOutputStream
import java.io.File
import javax.imageio.ImageIO
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.toComposeImageBitmap
import org.jetbrains.skia.Image as SkiaImage

fun main() = application {
    val trayState = rememberTrayState()
    var dashboardVisible by remember { mutableStateOf(true) }
    val exitApplication: () -> Unit = { this.exitApplication() }

    Tray(
        icon = rememberTrayIconPainter(),
        state = trayState,
        tooltip = "WoVoice",
        menu = {
            Item("WoVoice dashboard") { dashboardVisible = true }
            Item("Quit") { exitApplication() }
        },
    )

    Window(
        onCloseRequest = { dashboardVisible = false },
        visible = dashboardVisible,
        state = rememberWindowState(width = 900.dp, height = 720.dp),
        title = "WoVoice",
    ) {
        DashboardShell()
    }
}

@Composable
private fun DashboardShell() {
    val scope = remember { CoroutineScope(SupervisorJob() + Dispatchers.IO) }
    var status by remember { mutableStateOf("Idle — Phase C: capture a 5-second test clip.") }

    fun runCaptureTest() {
        status = "Recording 5 seconds from the microphone…"
        scope.launch {
            val recorder = DesktopWavRecorder(File(appDataDir, "capture-test.wav"), object : DesktopWavRecorder.Callback {
                override fun onStarted(nativeRate: Int, resampled: Boolean, mixerName: String, availableMixers: String) {
                    status = buildString {
                        append("Recording (rate $nativeRate Hz, resampled=$resampled)\n")
                        append("mixer: $mixerName\n")
                        append("available: $availableMixers")
                    }
                }

                override fun onLevel(rms: Float) = Unit

                override fun onComplete(result: DesktopWavRecorder.RecordingResult) {
                    val silenceHint = if (result.peakRms == 0.0f) {
                        "\n⚠ All-zero capture — grant WoVoice Microphone permission (System Settings → Privacy & Security → Microphone) or pick a live input device."
                    } else ""
                    status = buildString {
                        append("WAV written: ${result.file.absolutePath}\n")
                        append("duration=${result.durationMs}ms containsSpeech=${result.containsSpeech} ")
                        append("active=${result.activeSpeechMs}ms peak=${result.peakRms}")
                        append(silenceHint)
                    }
                }

                override fun onError(message: String) {
                    status = "Capture error: $message"
                }
            })
            recorder.start()
            Thread.sleep(5_000)
            recorder.finish()
        }
    }

    MaterialTheme {
        Scaffold { padding ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .background(Color(0xFF17161B))
                    .verticalScroll(rememberScrollState())
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Text(
                    text = "WoVoice desktop — Phase C capture test",
                    color = Color(0xFFF7F6F8),
                )
                Button(onClick = ::runCaptureTest) {
                    Text("Record 5 seconds")
                }
                Text(
                    text = status,
                    color = Color(0xFFB1AFBB),
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
    }
}

/**
 * Draws the WoVoice voice-mark (mint circle with three wave bars) in code so the
 * tray needs no bundled image asset.
 */
@Composable
private fun rememberTrayIconPainter(): Painter = remember {
    val image = BufferedImage(64, 64, BufferedImage.TYPE_INT_ARGB)
    val graphics = image.createGraphics()
    graphics.color = java.awt.Color(125, 228, 182)
    graphics.fillOval(2, 2, 60, 60)
    graphics.color = java.awt.Color(28, 30, 31)
    intArrayOf(10, 15, 20).forEachIndexed { index, half ->
        val x = 22 + index * 8
        graphics.fillRect(x, 32 - half, 4, half * 2)
    }
    graphics.dispose()
    val encoded = ByteArrayOutputStream().use { out ->
        ImageIO.write(image, "png", out)
        out.toByteArray()
    }
    val bitmap = SkiaImage.makeFromEncoded(encoded).toComposeImageBitmap()
    ImagePainter(bitmap, bitmap.width, bitmap.height)
}

private class ImagePainter(
    private val image: ImageBitmap,
    private val imageWidth: Int,
    private val imageHeight: Int,
) : Painter() {
    private val intrinsic = Size(imageWidth.toFloat(), imageHeight.toFloat())

    override val intrinsicSize: Size
        get() = intrinsic

    override fun DrawScope.onDraw() {
        drawIntoCanvas {
            withTransform({
                scale(
                    scaleX = size.width / imageWidth,
                    scaleY = size.height / imageHeight,
                    pivot = center,
                )
            }) {
                drawImage(image)
            }
        }
    }
}
