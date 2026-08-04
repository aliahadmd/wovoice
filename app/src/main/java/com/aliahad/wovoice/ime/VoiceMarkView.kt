package com.aliahad.wovoice.ime

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.view.View
import com.aliahad.wovoice.ui.dp

class VoiceMarkView(context: Context) : View(context) {
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ACCENT }
    private val wave = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.rgb(28, 30, 31)
        strokeCap = Paint.Cap.ROUND
        strokeWidth = context.dp(2).toFloat()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val centerX = width / 2f
        val centerY = height / 2f
        canvas.drawCircle(centerX, centerY, minOf(width, height) * 0.45f, fill)
        val gap = context.dp(3).toFloat()
        val heights = intArrayOf(5, 10, 5)
        heights.forEachIndexed { index, heightDp ->
            val x = centerX + (index - 1) * gap
            val half = context.dp(heightDp).toFloat() / 2f
            canvas.drawLine(x, centerY - half, x, centerY + half, wave)
        }
    }

    private companion object {
        val ACCENT = Color.rgb(125, 228, 182)
    }
}
