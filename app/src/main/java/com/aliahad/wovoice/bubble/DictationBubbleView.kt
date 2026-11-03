package com.aliahad.wovoice.bubble

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.text.TextPaint
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.accessibility.AccessibilityNodeInfo
import android.view.animation.DecelerateInterpolator
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.aliahad.wovoice.ui.dp
import com.aliahad.wovoice.ui.rounded
import java.util.Locale
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.log10
import kotlin.math.sin

/** Measured bounds follow the visible pill; no transparent wide overlay intercepts other app taps. */
@SuppressLint("SetTextI18n", "ClickableViewAccessibility", "ViewConstructor")
internal class DictationBubbleView(
    context: Context,
    onTap: () -> Unit,
    onCancel: () -> Unit,
    onHide: () -> Unit,
    onDrag: (Float, Float, Boolean) -> Unit,
) : LinearLayout(context) {
    private enum class Mode { IDLE, RECORDING, PROCESSING, MESSAGE }
    private data class Display(val mode: Mode, val message: String = "", val actionLabel: String? = null)

    private val control = SignalButton(context)
    private val close = TextView(context)
    private val motionInterpolator = DecelerateInterpolator()
    private var presentation = Display(Mode.IDLE)
    private var messageAction: (() -> Unit)? = null
    private var hapticsEnabled = true
    private var animationsEnabled = true
    private var waveformEnabled = true
    private var motionAllowed = systemAnimationsEnabled()
    private var transition: ValueAnimator? = null
    private var exiting = false
    private var downX = 0f
    private var downY = 0f
    private var lastX = 0f
    private var lastY = 0f
    private var dragging = false
    private var longPressed = false
    private var touchCancelled = false
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private val longPress = Runnable {
        if (!dragging && !touchCancelled && !exiting) {
            longPressed = control.performLongClick()
            press(false)
        }
    }

    init {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        elevation = context.dp(6).toFloat()
        setPadding(context.dp(4), context.dp(4), context.dp(4), context.dp(4))
        background = rounded(SURFACE, context.dp(28).toFloat(), BORDER, context.dp(1))
        addView(control, LayoutParams(context.dp(48), context.dp(48)))
        control.isClickable = true
        control.isFocusable = true
        control.setOnClickListener {
            if (exiting || presentation.mode == Mode.PROCESSING) return@setOnClickListener
            haptic(HapticFeedbackConstants.KEYBOARD_TAP)
            if (presentation.mode == Mode.MESSAGE) messageAction?.invoke() else onTap()
        }
        control.setOnLongClickListener {
            haptic(HapticFeedbackConstants.LONG_PRESS)
            Toast.makeText(context, "Drag to move. Tap to speak or finish. × cancels or hides the bubble.", Toast.LENGTH_LONG).show()
            true
        }
        close.apply {
            text = "×"
            textSize = 25f
            setTextColor(Color.rgb(195, 191, 207))
            gravity = Gravity.CENTER
            isFocusable = true
            setOnClickListener {
                if (!exiting) {
                    haptic(HapticFeedbackConstants.KEYBOARD_TAP)
                    if (presentation.mode == Mode.IDLE) onHide() else onCancel()
                }
            }
        }
        addView(close, LayoutParams(context.dp(44), context.dp(48)))
        control.setOnTouchListener { view, event ->
            if (exiting) return@setOnTouchListener true
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downX = event.rawX; downY = event.rawY
                    lastX = downX; lastY = downY
                    dragging = false; longPressed = false; touchCancelled = false
                    press(true)
                    postDelayed(longPress, ViewConfiguration.getLongPressTimeout().toLong())
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    if (!touchCancelled && (abs(event.rawX - downX) > slop || abs(event.rawY - downY) > slop)) {
                        dragging = true
                        removeCallbacks(longPress)
                        press(false)
                    }
                    if (dragging && !touchCancelled) onDrag(event.rawX - lastX, event.rawY - lastY, false)
                    lastX = event.rawX; lastY = event.rawY
                    true
                }
                MotionEvent.ACTION_POINTER_DOWN -> {
                    touchCancelled = true
                    removeCallbacks(longPress)
                    press(false)
                    if (dragging) { onDrag(0f, 0f, true); dragging = false }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    removeCallbacks(longPress)
                    press(false)
                    if (dragging) onDrag(0f, 0f, true)
                    else if (!longPressed && !touchCancelled) view.performClick()
                    dragging = false
                    true
                }
                MotionEvent.ACTION_CANCEL -> {
                    removeCallbacks(longPress)
                    press(false)
                    if (dragging) onDrag(0f, 0f, true)
                    dragging = false
                    true
                }
                else -> true
            }
        }
        render("Tap to speak", recording = false, processing = false)
    }

    fun setPreferences(haptics: Boolean, animations: Boolean, waveform: Boolean) {
        hapticsEnabled = haptics
        animationsEnabled = animations
        waveformEnabled = waveform
        val allowed = animations && systemAnimationsEnabled()
        if (motionAllowed != allowed) {
            motionAllowed = allowed
            if (!allowed) {
                transition?.cancel(); transition = null
                if (!exiting) {
                    animate().cancel()
                    alpha = 1f; scaleX = 1f; scaleY = 1f
                }
                control.animate().cancel()
                control.scaleX = 1f; control.scaleY = 1f; control.alpha = 1f
                control.layoutParams.width = control.desiredWidth(presentation)
                control.requestLayout()
                control.setDisplay(presentation, presentation, 1f)
            }
        }
        control.updateMotion(motionAllowed, waveformEnabled)
    }

    fun render(text: String, recording: Boolean, processing: Boolean) {
        messageAction = null
        val mode = when { recording -> Mode.RECORDING; processing -> Mode.PROCESSING; else -> Mode.IDLE }
        show(Display(mode))
        if (recording || processing) {
            control.contentDescription = "${control.contentDescription}. $text"
            if (Build.VERSION.SDK_INT >= 26) control.tooltipText = text
        } else if (Build.VERSION.SDK_INT >= 26) control.tooltipText = null
    }

    fun renderMessage(message: String, actionLabel: String? = null, onAction: (() -> Unit)? = null) {
        messageAction = onAction
        show(Display(Mode.MESSAGE, message, actionLabel))
    }

    fun level(rms: Float) = control.level(rms)
    fun setElapsed(durationMs: Long) = control.setElapsed(durationMs)

    fun animateIn() {
        if (exiting) return
        animate().cancel()
        if (!animationsEnabled || !systemAnimationsEnabled()) {
            alpha = 1f; scaleX = 1f; scaleY = 1f
            return
        }
        alpha = 0f; scaleX = .96f; scaleY = .96f
        animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(160L)
            .setInterpolator(motionInterpolator).withEndAction(null).start()
    }

    fun animateOut(onFinished: () -> Unit) {
        if (exiting) return
        exiting = true
        removeCallbacks(longPress)
        control.isEnabled = false; close.isEnabled = false
        transition?.cancel(); transition = null
        control.stopMotion()
        animate().cancel()
        if (!isAttachedToWindow || !animationsEnabled || !systemAnimationsEnabled()) { onFinished(); return }
        animate().alpha(0f).scaleX(.97f).scaleY(.97f).setDuration(120L)
            .setInterpolator(motionInterpolator).withEndAction(onFinished).start()
    }

    private fun show(next: Display) {
        if (exiting) return
        motionAllowed = animationsEnabled && systemAnimationsEnabled()
        control.updateMotion(motionAllowed, waveformEnabled)
        control.contentDescription = when (next.mode) {
            Mode.IDLE -> "Start bubble dictation"
            Mode.RECORDING -> "Finish bubble recording"
            Mode.PROCESSING -> "Transcribing speech"
            Mode.MESSAGE -> listOfNotNull(next.message, next.actionLabel).joinToString(". ")
        }
        close.contentDescription = if (next.mode == Mode.IDLE) "Hide dictation bubble" else "Cancel bubble dictation"
        if (next == presentation) { control.invalidate(); return }
        val previous = presentation
        presentation = next
        transition?.cancel()
        val fromWidth = control.layoutParams.width
        val toWidth = control.desiredWidth(next)
        if (!motionAllowed || !isLaidOut) {
            control.layoutParams.width = toWidth
            control.requestLayout()
            control.setDisplay(next, next, 1f)
            return
        }
        transition = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = 180L
            interpolator = motionInterpolator
            addUpdateListener { animation ->
                val progress = animation.animatedValue as Float
                val width = (fromWidth + (toWidth - fromWidth) * progress).toInt()
                if (control.layoutParams.width != width) {
                    control.layoutParams.width = width
                    control.requestLayout()
                }
                control.setDisplay(previous, next, progress)
            }
            start()
        }
    }

    private fun press(pressed: Boolean) {
        control.animate().cancel()
        if (!motionAllowed) {
            control.alpha = if (pressed) .76f else 1f
            return
        }
        control.animate().scaleX(if (pressed) .94f else 1f).scaleY(if (pressed) .94f else 1f)
            .alpha(if (pressed) .76f else 1f).setDuration(if (pressed) 45L else 90L)
            .setInterpolator(motionInterpolator).start()
    }

    private fun haptic(kind: Int) { if (hapticsEnabled) control.performHapticFeedback(kind) }

    private fun systemAnimationsEnabled(): Boolean = runCatching {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f
    }.getOrDefault(true)

    override fun onDetachedFromWindow() {
        removeCallbacks(longPress)
        transition?.cancel(); transition = null
        animate().cancel()
        control.animate().cancel()
        control.stopMotion()
        super.onDetachedFromWindow()
    }

    /** Real audio history, isolated bars and frame-rate independent smoothing; idle never redraws. */
    private class SignalButton(context: Context) : View(context) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = ACCENT
            strokeCap = Paint.Cap.ROUND
            strokeJoin = Paint.Join.ROUND
        }
        private val textPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            typeface = android.graphics.Typeface.create("sans-serif-medium", android.graphics.Typeface.NORMAL)
            textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 14f, resources.displayMetrics)
            color = Color.WHITE
        }
        private val smallTextPaint = TextPaint(textPaint).apply {
            textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 10f, resources.displayMetrics)
        }
        private val bounds = RectF()
        private val targets = FloatArray(5) { .1f }
        private val levels = FloatArray(5) { .1f }
        private var previous = Display(Mode.IDLE)
        private var current = previous
        private var progress = 1f
        private var motion = true
        private var waveform = true
        private var framePending = false
        private var lastFrame = 0L
        private var elapsedText = "0:00"
        private var elapsedSeconds = -1L
        private val frame = object : Runnable {
            override fun run() {
                framePending = false
                if (!isAttachedToWindow || !motion) return
                val now = SystemClock.uptimeMillis()
                val elapsed = if (lastFrame == 0L) 16L else (now - lastFrame).coerceAtMost(64L)
                lastFrame = now
                val smoothing = (1.0 - exp(-elapsed / 70.0)).toFloat()
                var settling = false
                if (current.mode == Mode.RECORDING && waveform) levels.indices.forEach { index ->
                    levels[index] += (targets[index] - levels[index]) * smoothing
                    if (abs(targets[index] - levels[index]) > .004f) settling = true
                }
                invalidate()
                if (settling || current.mode == Mode.PROCESSING) scheduleFrame()
            }
        }

        fun desiredWidth(value: Display): Int = when (value.mode) {
            Mode.IDLE -> context.dp(48)
            Mode.RECORDING -> maxOf(context.dp(96), (context.dp(52) + textPaint.measureText("0:00")).toInt())
            Mode.PROCESSING -> maxOf(context.dp(116), (context.dp(48) + textPaint.measureText("Thinking…")).toInt())
            Mode.MESSAGE -> maxOf(context.dp(128), (textPaint.measureText(value.message) + context.dp(24)).toInt())
                .coerceAtMost(context.dp(180))
        }

        fun setDisplay(from: Display, to: Display, fraction: Float) {
            val enteringRecording = current.mode != Mode.RECORDING && to.mode == Mode.RECORDING
            previous = from; current = to; progress = fraction
            if (enteringRecording) { targets.fill(.1f); levels.fill(.1f); elapsedSeconds = -1; setElapsed(0) }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && current.mode != Mode.RECORDING) stateDescription = null
            if (current.mode == Mode.PROCESSING || (current.mode == Mode.RECORDING && waveform)) scheduleFrame()
            else if (current.mode != Mode.RECORDING) stopMotion()
            invalidate()
        }

        fun updateMotion(enabled: Boolean, showWaveform: Boolean) {
            motion = enabled; waveform = showWaveform
            if (!motion) stopMotion()
            else if (current.mode == Mode.PROCESSING) scheduleFrame()
            invalidate()
        }

        fun setElapsed(durationMs: Long) {
            val seconds = durationMs.coerceIn(0, 60_000) / 1000
            if (seconds == elapsedSeconds) return
            elapsedSeconds = seconds
            elapsedText = String.format(Locale.ROOT, "%d:%02d", seconds / 60, seconds % 60)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                stateDescription = if (current.mode == Mode.RECORDING) "$elapsedText of 1 minute" else null
            }
            if (current.mode == Mode.RECORDING) invalidate()
        }

        fun level(rms: Float) {
            if (current.mode != Mode.RECORDING || !waveform || !motion) return
            for (index in 0 until targets.lastIndex) targets[index] = targets[index + 1]
            val db = 20f * log10(rms.coerceAtLeast(.00001f))
            targets[targets.lastIndex] = ((db + 60f) / 25f).coerceIn(.1f, 1f)
            scheduleFrame()
        }

        private fun scheduleFrame() {
            if (framePending || !motion || !isAttachedToWindow) return
            framePending = true
            postOnAnimation(frame)
        }

        fun stopMotion() {
            removeCallbacks(frame)
            framePending = false
            lastFrame = 0
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            if (progress < 1f && previous != current) drawDisplay(canvas, previous, 1f - progress)
            drawDisplay(canvas, current, progress)
        }

        private fun drawDisplay(canvas: Canvas, value: Display, opacity: Float) {
            if (opacity <= 0f) return
            val alpha = (opacity * 255).toInt().coerceIn(0, 255)
            paint.color = ACCENT; paint.alpha = alpha
            textPaint.alpha = alpha; smallTextPaint.alpha = (alpha * .7f).toInt()
            val centerY = height / 2f
            when (value.mode) {
                Mode.IDLE -> drawMicrophone(canvas, width / 2f, centerY)
                Mode.RECORDING -> {
                    val centerX = context.dp(22).toFloat()
                    if (waveform && motion) drawSignal(canvas, centerX, centerY)
                    else {
                        paint.style = Paint.Style.FILL
                        bounds.set(centerX - context.dp(7), centerY - context.dp(7), centerX + context.dp(7), centerY + context.dp(7))
                        canvas.drawRoundRect(bounds, context.dp(2).toFloat(), context.dp(2).toFloat(), paint)
                    }
                    textPaint.textAlign = Paint.Align.LEFT
                    canvas.drawText(elapsedText, context.dp(46).toFloat(), centerY - context.dp(1), textPaint)
                    smallTextPaint.textAlign = Paint.Align.LEFT
                    canvas.drawText("/ 1:00", context.dp(46).toFloat(), centerY + context.dp(13), smallTextPaint)
                }
                Mode.PROCESSING -> {
                    paint.style = Paint.Style.FILL
                    repeat(3) { index ->
                        val phase = if (motion) (sin(SystemClock.uptimeMillis() / 180.0 - index * .8).toFloat() + 1f) / 2 else .5f
                        paint.alpha = (alpha * (.35f + phase * .65f)).toInt()
                        canvas.drawCircle(context.dp(15 + index * 5).toFloat(), centerY, context.dp(1).toFloat().coerceAtLeast(2f), paint)
                    }
                    textPaint.textAlign = Paint.Align.LEFT
                    canvas.drawText("Thinking…", context.dp(36).toFloat(), centerY - (textPaint.ascent() + textPaint.descent()) / 2f, textPaint)
                }
                Mode.MESSAGE -> {
                    textPaint.textAlign = Paint.Align.CENTER
                    smallTextPaint.textAlign = Paint.Align.CENTER
                    val available = (width - context.dp(16)).coerceAtLeast(1).toFloat()
                    val message = TextUtils.ellipsize(value.message, textPaint, available, TextUtils.TruncateAt.END).toString()
                    if (value.actionLabel == null) canvas.drawText(message, width / 2f, centerY - (textPaint.ascent() + textPaint.descent()) / 2f, textPaint)
                    else {
                        val action = TextUtils.ellipsize(value.actionLabel, smallTextPaint, available, TextUtils.TruncateAt.END).toString()
                        canvas.drawText(message, width / 2f, centerY - context.dp(2), textPaint)
                        canvas.drawText(action, width / 2f, centerY + context.dp(13), smallTextPaint)
                    }
                }
            }
        }

        private fun drawMicrophone(canvas: Canvas, x: Float, y: Float) {
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = context.dp(2).toFloat()
            bounds.set(x - context.dp(4), y - context.dp(11), x + context.dp(4), y + context.dp(3))
            canvas.drawRoundRect(bounds, context.dp(4).toFloat(), context.dp(4).toFloat(), paint)
            bounds.set(x - context.dp(8), y - context.dp(5), x + context.dp(8), y + context.dp(7))
            canvas.drawArc(bounds, 0f, 180f, false, paint)
            canvas.drawLine(x, y + context.dp(7), x, y + context.dp(12), paint)
            canvas.drawLine(x - context.dp(4), y + context.dp(12), x + context.dp(4), y + context.dp(12), paint)
        }

        private fun drawSignal(canvas: Canvas, x: Float, y: Float) {
            paint.style = Paint.Style.STROKE
            paint.strokeWidth = context.dp(3).toFloat()
            levels.forEachIndexed { index, level ->
                val half = context.dp(3) / 2f + context.dp(18) * level / 2f
                val barX = x + context.dp(5) * (index - 2)
                canvas.drawLine(barX, y - half, barX, y + half, paint)
            }
        }

        override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
            super.onInitializeAccessibilityNodeInfo(info)
            info.className = Button::class.java.name
        }

        override fun onAttachedToWindow() {
            super.onAttachedToWindow()
            if (current.mode == Mode.PROCESSING) scheduleFrame()
        }

        override fun onDetachedFromWindow() {
            stopMotion()
            super.onDetachedFromWindow()
        }
    }

    private companion object {
        val SURFACE = Color.rgb(31, 30, 37)
        val BORDER = Color.rgb(93, 86, 116)
        val ACCENT = Color.rgb(125, 228, 182)
    }
}
