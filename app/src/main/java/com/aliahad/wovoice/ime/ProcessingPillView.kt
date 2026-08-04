package com.aliahad.wovoice.ime

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.os.SystemClock
import android.util.TypedValue
import android.view.View
import com.aliahad.wovoice.ui.dp

class ProcessingPillView(context: Context) : View(context) {
    private val bounds = RectF()
    private val clipPath = Path()
    private val backgroundPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(231, 229, 228) }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(91, 91, 96)
        textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 18f, context.resources.displayMetrics)
        textAlign = Paint.Align.CENTER
        typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
    }
    private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(91, 91, 96) }
    private val shimmerPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val shimmerMatrix = Matrix()
    private var shimmerShader: LinearGradient? = null
    private var active = false
    private var startedAt = 0L

    fun setActive(value: Boolean) {
        if (active == value) return
        active = value
        if (value) {
            startedAt = SystemClock.uptimeMillis()
            invalidate()
        }
    }

    override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
        super.onSizeChanged(width, height, oldWidth, oldHeight)
        val radius = height / 2f
        bounds.set(0f, 0f, width.toFloat(), height.toFloat())
        clipPath.reset()
        clipPath.addRoundRect(bounds, radius, radius, Path.Direction.CW)
        shimmerShader = LinearGradient(
            -width * 0.35f,
            0f,
            width * 0.35f,
            0f,
            intArrayOf(Color.TRANSPARENT, Color.argb(72, 255, 255, 255), Color.TRANSPARENT),
            null,
            Shader.TileMode.CLAMP,
        ).also { shimmerPaint.shader = it }
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val radius = height / 2f
        canvas.drawRoundRect(bounds, radius, radius, backgroundPaint)

        if (active) {
            val progress = ((SystemClock.uptimeMillis() - startedAt) % SHIMMER_DURATION_MS) / SHIMMER_DURATION_MS.toFloat()
            val center = -width * 0.55f + progress * width * 2.1f
            shimmerMatrix.setTranslate(center, 0f)
            shimmerShader?.setLocalMatrix(shimmerMatrix)
            canvas.save()
            canvas.clipPath(clipPath)
            canvas.drawRect(bounds, shimmerPaint)
            canvas.restore()
        }

        val metrics = textPaint.fontMetrics
        val baseline = height / 2f - (metrics.ascent + metrics.descent) / 2f
        canvas.drawText("Thinking", width / 2f - context.dp(8), baseline, textPaint)
        val elapsed = (SystemClock.uptimeMillis() - startedAt).coerceAtLeast(0L)
        repeat(3) { index ->
            val phase = ((elapsed - index * 150L) % 900L).coerceAtLeast(0L) / 900f
            dotPaint.alpha = (75 + 180 * (1f - kotlin.math.abs(phase * 2f - 1f))).toInt()
            canvas.drawCircle(
                width / 2f + context.dp(35 + index * 6).toFloat(),
                height / 2f + context.dp(5),
                context.dp(1).toFloat().coerceAtLeast(3f),
                dotPaint,
            )
        }
        dotPaint.alpha = 255
        if (active) postInvalidateDelayed(FRAME_DELAY_MS)
    }

    private companion object {
        const val FRAME_DELAY_MS = 33L
        const val SHIMMER_DURATION_MS = 1_500L
    }
}
