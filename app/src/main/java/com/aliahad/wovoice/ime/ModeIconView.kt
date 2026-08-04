package com.aliahad.wovoice.ime

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.view.View
import com.aliahad.wovoice.ui.dp

class ModeIconView(context: Context) : View(context) {
    enum class Icon { VOICE, KEYBOARD }

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.WHITE
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private var icon = Icon.VOICE

    fun setIcon(value: Icon) {
        if (icon == value) return
        icon = value
        contentDescription = if (value == Icon.VOICE) "Voice keyboard" else "Manual keyboard"
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (icon == Icon.VOICE) drawVoice(canvas) else drawKeyboard(canvas)
    }

    private fun drawVoice(canvas: Canvas) {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = context.dp(3).toFloat()
        val centerX = width / 2f
        val centerY = height / 2f
        val spacing = context.dp(5).toFloat()
        val heights = intArrayOf(8, 15, 21, 15, 8)
        heights.forEachIndexed { index, heightDp ->
            val x = centerX + (index - 2) * spacing
            val half = context.dp(heightDp).toFloat() / 2f
            canvas.drawLine(x, centerY - half, x, centerY + half, paint)
        }
    }

    private fun drawKeyboard(canvas: Canvas) {
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = context.dp(1).toFloat().coerceAtLeast(2f)
        val keyboardWidth = context.dp(27).toFloat()
        val keyboardHeight = context.dp(19).toFloat()
        val left = (width - keyboardWidth) / 2f
        val top = (height - keyboardHeight) / 2f
        val bounds = RectF(left, top, left + keyboardWidth, top + keyboardHeight)
        canvas.drawRoundRect(bounds, context.dp(3).toFloat(), context.dp(3).toFloat(), paint)

        paint.style = Paint.Style.FILL
        val keyWidth = context.dp(4).toFloat()
        val keyHeight = context.dp(3).toFloat()
        val gapX = context.dp(2).toFloat()
        val gapY = context.dp(2).toFloat()
        val gridWidth = keyWidth * 4 + gapX * 3
        val startX = width / 2f - gridWidth / 2f
        val startY = height / 2f - (keyHeight * 2 + gapY) / 2f - context.dp(1)
        repeat(2) { row ->
            repeat(4) { column ->
                val x = startX + column * (keyWidth + gapX)
                val y = startY + row * (keyHeight + gapY)
                canvas.drawRoundRect(
                    RectF(x, y, x + keyWidth, y + keyHeight),
                    context.dp(1).toFloat(),
                    context.dp(1).toFloat(),
                    paint,
                )
            }
        }
        canvas.drawRoundRect(
            RectF(startX, startY + 2 * (keyHeight + gapY), startX + gridWidth, startY + 2 * (keyHeight + gapY) + keyHeight),
            context.dp(1).toFloat(),
            context.dp(1).toFloat(),
            paint,
        )
    }
}
