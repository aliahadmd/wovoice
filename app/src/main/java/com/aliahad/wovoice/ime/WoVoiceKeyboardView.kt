package com.aliahad.wovoice.ime

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.inputmethod.EditorInfo
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import com.aliahad.wovoice.R
import com.aliahad.wovoice.core.EditorPolicy
import com.aliahad.wovoice.core.KeyboardState
import com.aliahad.wovoice.core.ShiftState
import com.aliahad.wovoice.ui.dp
import com.aliahad.wovoice.ui.rounded
import com.aliahad.wovoice.ui.styleText

@SuppressLint("SetTextI18n")
class WoVoiceKeyboardView(context: Context) : SwipeFrameLayout(context) {
    interface Listener {
        fun onStartVoice()
        fun onFinishVoice()
        fun onCancelVoice()
        fun onSelectManual(manual: Boolean)
        fun onCommitText(text: String)
        fun onDelete()
        fun onEditorAction()
        fun onOpenSettings()
    }

    lateinit var listener: Listener
    private val modeSwitcher: LinearLayout
    private val modeIcon: ModeIconView
    private val languageLabel: TextView
    private val voiceBody: FrameLayout
    private val manualBody: LinearLayout
    private val status: TextView
    private val microphone: ImageView
    private val waveform: WaveformView
    private val processing: ProcessingPillView
    private val cancel: TextView
    private val sideDelete: TextView
    private val atKey: TextView
    private val returnKey: TextView
    private val shiftState = ShiftState()
    private var state: KeyboardState = KeyboardState.VoiceIdle
    private var voiceEnabled = true
    private var symbolPage = 0
    private var actionLabel = "↵"
    private var modeSlideDirection = 1
    private var initialRender = true
    private var hapticsEnabled = true
    private var animationsEnabled = true
    private var waveformEnabled = true
    private val motionInterpolator = DecelerateInterpolator()

    init {
        setBackgroundColor(BACKGROUND)
        clipChildren = false
        clipToPadding = false
        minimumHeight = context.dp(336)
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(336))

        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BACKGROUND)
        }
        addView(column, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

        val header = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(context.dp(16), context.dp(5), context.dp(14), context.dp(3))
        }
        column.addView(header, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(52)))
        val brand = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            isClickable = true
            contentDescription = "Open WoVoice settings"
        }
        brand.addView(VoiceMarkView(context), LinearLayout.LayoutParams(context.dp(24), context.dp(24)))
        brand.addView(TextView(context).apply {
            text = "WoVoice"
            styleText(19f)
            gravity = Gravity.CENTER_VERTICAL
            typeface = Typeface.create("sans-serif", Typeface.BOLD)
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT).apply {
            leftMargin = context.dp(8)
        })
        installTapFeedback(brand, listenerAction = { listener.onOpenSettings() }, pressedScale = 0.98f)
        header.addView(brand, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))

        modeSwitcher = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(context.dp(2), context.dp(2), context.dp(2), context.dp(2))
            background = rounded(PILL_DARK, context.dp(22).toFloat())
        }
        header.addView(modeSwitcher, LinearLayout.LayoutParams(context.dp(112), context.dp(43)))
        modeIcon = ModeIconView(context).apply {
            contentDescription = "Voice keyboard"
        }
        modeSwitcher.addView(modeIcon, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        languageLabel = TextView(context).apply {
            text = "EN"
            styleText(17f, MUTED)
            gravity = Gravity.CENTER
            contentDescription = "English manual keyboard"
        }
        modeSwitcher.addView(languageLabel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        installTapFeedback(modeIcon, listenerAction = { toggleMode() })
        installTapFeedback(languageLabel, listenerAction = { toggleMode() })

        val content = FrameLayout(context)
        column.addView(content, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        voiceBody = FrameLayout(context)
        manualBody = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
        }
        content.addView(voiceBody, LayoutParams(LayoutParams.MATCH_PARENT, context.dp(256)))
        content.addView(manualBody, LayoutParams(LayoutParams.MATCH_PARENT, context.dp(256)))

        status = TextView(context).apply {
            text = "Tap to speak"
            styleText(17f, MUTED)
            gravity = Gravity.CENTER
            maxLines = 2
        }
        voiceBody.addView(status, frame(context.dp(300), context.dp(44), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = context.dp(8) })

        microphone = ImageView(context).apply {
            setImageResource(R.drawable.ic_mic_keyboard)
            scaleType = ImageView.ScaleType.CENTER
            background = rounded(Color.rgb(246, 245, 244), context.dp(48).toFloat())
            contentDescription = "Start voice recording"
        }
        installTapFeedback(microphone, listenerAction = { handleVoiceCenter() }, pressedScale = 0.96f)
        voiceBody.addView(microphone, frame(context.dp(188), context.dp(72), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = context.dp(58) })

        waveform = WaveformView(context).apply {
            visibility = View.GONE
            contentDescription = "Finish voice recording"
        }
        installTapFeedback(waveform, listenerAction = { handleVoiceCenter() }, pressedScale = 0.96f)
        voiceBody.addView(waveform, frame(context.dp(120), context.dp(120), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = context.dp(36) })

        processing = ProcessingPillView(context).apply {
            visibility = View.GONE
            contentDescription = "Processing speech"
        }
        voiceBody.addView(processing, frame(context.dp(172), context.dp(60), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = context.dp(70) })

        cancel = circleKey("×", 29f).apply {
            visibility = View.GONE
            contentDescription = "Cancel recording"
        }
        installTapFeedback(cancel, listenerAction = { listener.onCancelVoice() })
        addView(cancel, frame(context.dp(46), context.dp(46), Gravity.TOP or Gravity.END).apply {
            topMargin = context.dp(4); rightMargin = context.dp(16)
        })

        sideDelete = circleKey("⌫", 22f).apply { contentDescription = "Delete" }
        installDeleteTouch(sideDelete)
        voiceBody.addView(sideDelete, frame(context.dp(52), context.dp(52), Gravity.TOP or Gravity.END).apply {
            rightMargin = context.dp(18); topMargin = context.dp(64)
        })
        atKey = circleKey("@", 23f).apply { contentDescription = "At sign" }
        installTapFeedback(atKey, listenerAction = { listener.onCommitText("@") })
        voiceBody.addView(atKey, frame(context.dp(52), context.dp(52), Gravity.TOP or Gravity.END).apply {
            rightMargin = context.dp(18); topMargin = context.dp(127)
        })
        returnKey = TextView(context).apply {
            text = actionLabel
            styleText(19f)
            gravity = Gravity.CENTER
            background = rounded(KEY_DARK, context.dp(35).toFloat())
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            contentDescription = "Editor action"
        }
        installTapFeedback(returnKey, listenerAction = { listener.onEditorAction() })
        voiceBody.addView(returnKey, frame(context.dp(176), context.dp(58), Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply { topMargin = context.dp(188) })

        onHorizontalSwipe = { direction -> toggleMode(direction) }
        rebuildManualKeyboard()
        render()
    }

    fun setState(value: KeyboardState) {
        if (state == value && !initialRender) return
        state = value
        render()
    }

    fun setPreferences(haptics: Boolean, animations: Boolean, waveform: Boolean) {
        hapticsEnabled = haptics
        animationsEnabled = animations
        waveformEnabled = waveform
    }

    fun setVoiceEnabled(enabled: Boolean) {
        voiceEnabled = enabled
        if (!enabled && state !is KeyboardState.ManualKeyboard) state = KeyboardState.ManualKeyboard
        modeSwitcher.alpha = if (enabled) 1f else 0.45f
        render()
    }

    fun updateEditor(editorInfo: EditorInfo?, sentenceStart: Boolean) {
        actionLabel = EditorPolicy.actionLabel(editorInfo)
        returnKey.text = actionLabel
        shiftState.resetForField(sentenceStart)
        symbolPage = if ((editorInfo?.inputType ?: 0) and android.text.InputType.TYPE_MASK_CLASS == android.text.InputType.TYPE_CLASS_NUMBER) 1 else 0
        rebuildManualKeyboard()
    }

    fun updateLevel(rms: Float) {
        if (state is KeyboardState.Recording && waveformEnabled) waveform.setLevel(rms)
    }

    private fun toggleMode(direction: Int = 0) {
        if (state is KeyboardState.Recording || state is KeyboardState.Processing) return
        modeSlideDirection = when {
            direction != 0 -> direction
            state is KeyboardState.ManualKeyboard -> -1
            else -> 1
        }
        if (state is KeyboardState.ManualKeyboard) {
            if (voiceEnabled) listener.onSelectManual(false)
        } else {
            listener.onSelectManual(true)
        }
    }

    private fun handleVoiceCenter() {
        when (state) {
            KeyboardState.Recording -> listener.onFinishVoice()
            KeyboardState.Processing -> Unit
            KeyboardState.ManualKeyboard -> Unit
            else -> if (voiceEnabled) listener.onStartVoice()
        }
    }

    private fun render() {
        val manual = state is KeyboardState.ManualKeyboard
        val animate = isLaidOut && !initialRender && animationsEnabled && systemAnimationsEnabled()
        showMode(manual, animate)
        // The left segment always represents voice; EN represents the manual English layout.
        // Selection styling, rather than a changing glyph, makes the switcher's meaning stable.
        modeIcon.setIcon(ModeIconView.Icon.VOICE)
        modeIcon.background = rounded(
            if (!manual) SEGMENT_ACTIVE else Color.TRANSPARENT,
            context.dp(20).toFloat(),
        )
        languageLabel.background = rounded(
            if (manual) SEGMENT_ACTIVE else Color.TRANSPARENT,
            context.dp(20).toFloat(),
        )
        languageLabel.setTextColor(if (manual) Color.WHITE else MUTED)
        if (manual) {
            waveform.setActive(false)
            processing.setActive(false)
            setElementVisible(modeSwitcher, true, animate)
            setElementVisible(cancel, false, animate)
            initialRender = false
            return
        }

        val recording = state is KeyboardState.Recording
        val thinking = state is KeyboardState.Processing
        val error = state as? KeyboardState.Error
        val statusText = when {
            recording -> "Tap again to finish"
            thinking -> null
            error != null -> error.message
            else -> "Tap to speak"
        }
        updateStatus(statusText, recording, error != null, animate)
        microphone.contentDescription = if (recording) "Finish voice recording" else "Start voice recording"
        waveform.setActive(recording)
        processing.setActive(thinking)
        setElementVisible(microphone, !recording && !thinking, animate)
        setElementVisible(waveform, recording, animate)
        setElementVisible(processing, thinking, animate)
        setElementVisible(modeSwitcher, !recording && !thinking, animate)
        setElementVisible(cancel, recording || thinking, animate)
        setElementVisible(sideDelete, !recording && !thinking, animate)
        setElementVisible(atKey, !recording && !thinking, animate)
        setElementVisible(returnKey, !recording && !thinking, animate)
        initialRender = false
    }

    private fun showMode(manual: Boolean, animate: Boolean) {
        val incoming = if (manual) manualBody else voiceBody
        val outgoing = if (manual) voiceBody else manualBody
        if (!animate || incoming.visibility == View.VISIBLE) {
            incoming.animate().cancel()
            outgoing.animate().cancel()
            incoming.visibility = View.VISIBLE
            incoming.alpha = 1f
            incoming.translationX = 0f
            outgoing.visibility = View.GONE
            outgoing.alpha = 1f
            outgoing.translationX = 0f
            return
        }

        val distance = context.dp(22).toFloat()
        incoming.animate().cancel()
        outgoing.animate().cancel()
        incoming.visibility = View.VISIBLE
        incoming.alpha = 0f
        incoming.translationX = -modeSlideDirection * distance
        incoming.animate()
            .alpha(1f)
            .translationX(0f)
            .setDuration(MODE_TRANSITION_MS)
            .setInterpolator(motionInterpolator)
            .start()
        outgoing.animate()
            .alpha(0f)
            .translationX(modeSlideDirection * distance)
            .setDuration(MODE_TRANSITION_MS - 25L)
            .setInterpolator(motionInterpolator)
            .withEndAction {
                outgoing.visibility = View.GONE
                outgoing.alpha = 1f
                outgoing.translationX = 0f
            }
            .start()
    }

    private fun updateStatus(text: String?, recording: Boolean, isError: Boolean, animate: Boolean) {
        status.animate().cancel()
        if (text == null) {
            setElementVisible(status, false, animate)
            return
        }
        status.text = text
        status.textSize = if (isError) 14f else 17f
        status.setTextColor(if (isError) ERROR else MUTED)
        status.visibility = View.VISIBLE
        val targetY = if (recording) context.dp(166).toFloat() else 0f
        if (animate) {
            status.alpha = 0f
            status.translationY = targetY + if (recording) context.dp(5) else -context.dp(4)
            status.animate()
                .alpha(1f)
                .translationY(targetY)
                .setDuration(STATUS_TRANSITION_MS)
                .setInterpolator(motionInterpolator)
                .start()
        } else {
            status.alpha = 1f
            status.translationY = targetY
        }
    }

    private fun setElementVisible(view: View, visible: Boolean, animate: Boolean) {
        view.animate().cancel()
        if (!animate) {
            view.visibility = if (visible) View.VISIBLE else View.GONE
            view.alpha = 1f
            view.scaleX = 1f
            view.scaleY = 1f
            return
        }
        if (visible) {
            if (view.visibility == View.VISIBLE && view.alpha == 1f) return
            view.visibility = View.VISIBLE
            view.alpha = 0f
            view.scaleX = 0.92f
            view.scaleY = 0.92f
            view.animate()
                .alpha(1f)
                .scaleX(1f)
                .scaleY(1f)
                .setDuration(ELEMENT_IN_MS)
                .setInterpolator(motionInterpolator)
                .start()
        } else {
            if (view.visibility != View.VISIBLE) return
            view.animate()
                .alpha(0f)
                .scaleX(0.94f)
                .scaleY(0.94f)
                .setDuration(ELEMENT_OUT_MS)
                .setInterpolator(motionInterpolator)
                .withEndAction {
                    view.visibility = View.GONE
                    view.alpha = 1f
                    view.scaleX = 1f
                    view.scaleY = 1f
                }
                .start()
        }
    }

    private fun rebuildManualKeyboard(animate: Boolean = manualBody.isShown && animationsEnabled, direction: Int = 0) {
        manualBody.removeAllViews()
        val rows: List<List<KeySpec>> = when (symbolPage) {
            1 -> symbolRowsOne()
            2 -> symbolRowsTwo()
            else -> letterRows()
        }
        rows.forEach { specs ->
            val row = LinearLayout(context).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER
                setPadding(context.dp(3), context.dp(2), context.dp(3), context.dp(2))
            }
            manualBody.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
            specs.forEach { spec ->
                val key = TextView(context).apply {
                    text = spec.label
                    styleText(keyTextSize(spec))
                    gravity = Gravity.CENTER
                    background = rounded(keyColor(spec), context.dp(10).toFloat())
                    when {
                        spec.action == ENTER -> setTextColor(Color.rgb(30, 30, 33))
                        spec.action == SHIFT && shiftState.shifted -> setTextColor(Color.rgb(30, 30, 33))
                        spec.action == " " -> setTextColor(MUTED)
                    }
                    setPadding(context.dp(2), 0, context.dp(2), 0)
                    contentDescription = keyDescription(spec)
                }
                val params = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, spec.weight).apply {
                    leftMargin = context.dp(3); rightMargin = context.dp(3); topMargin = context.dp(2); bottomMargin = context.dp(2)
                }
                row.addView(key, params)
                if (spec.action == DELETE) installDeleteTouch(key) else installKeyTouch(key) { performKey(spec) }
            }
        }
        if (animate) {
            manualBody.animate().cancel()
            manualBody.alpha = 0.72f
            manualBody.translationX = direction * context.dp(14).toFloat()
            manualBody.animate()
                .alpha(1f)
                .translationX(0f)
                .setDuration(MANUAL_REBUILD_MS)
                .setInterpolator(motionInterpolator)
                .start()
        }
    }

    private fun performKey(spec: KeySpec) {
        when (spec.action) {
            SHIFT -> {
                shiftState.tap(SystemClock.uptimeMillis())
                rebuildManualKeyboard(animate = true)
            }
            SYMBOLS -> {
                symbolPage = 1
                rebuildManualKeyboard(animate = true, direction = 1)
            }
            LETTERS -> {
                symbolPage = 0
                rebuildManualKeyboard(animate = true, direction = -1)
            }
            SYMBOL_PAGE -> {
                symbolPage = if (symbolPage == 1) 2 else 1
                rebuildManualKeyboard(animate = true, direction = if (symbolPage == 2) 1 else -1)
            }
            ENTER -> listener.onEditorAction()
            else -> {
                listener.onCommitText(spec.value)
                if (spec.value.length == 1 && spec.value[0].isLetter()) {
                    shiftState.consumeLetter()
                    if (!shiftState.shifted) rebuildManualKeyboard(animate = true)
                }
            }
        }
    }

    private fun letterRows(): List<List<KeySpec>> {
        fun letters(value: String) = value.map { char ->
            val output = if (shiftState.shifted) char.uppercaseChar() else char.lowercaseChar()
            KeySpec(output.toString(), output.toString())
        }
        return listOf(
            letters("QWERTYUIOP"),
            letters("ASDFGHJKL"),
            listOf(KeySpec(if (shiftState.capsLocked) "⇪" else "⇧", SHIFT, 1.25f)) + letters("ZXCVBNM") + KeySpec("⌫", DELETE, 1.25f),
            listOf(
                KeySpec("123", SYMBOLS, 1.55f),
                KeySpec("English", " ", 3f),
                KeySpec(actionLabel, ENTER, 1.55f),
            ),
        )
    }

    private fun symbolRowsOne() = listOf(
        "1234567890".map { KeySpec(it.toString(), it.toString()) },
        listOf("@", "#", "\$", "%", "&", "-", "+", "(", ")").map { KeySpec(it, it) },
        listOf(KeySpec("#+=", SYMBOL_PAGE, 1.25f)) + listOf("*", "\"", "'", ",", ".", "!", "?").map { KeySpec(it, it) } + KeySpec("⌫", DELETE, 1.25f),
        listOf(KeySpec("ABC", LETTERS, 1.55f), KeySpec("English", " ", 3f), KeySpec(actionLabel, ENTER, 1.55f)),
    )

    private fun symbolRowsTwo() = listOf(
        listOf("[", "]", "{", "}", "#", "%", "^", "*", "+", "=").map { KeySpec(it, it) },
        listOf("_", "\\", "|", "~", "<", ">", "€", "£", "¥").map { KeySpec(it, it) },
        listOf(KeySpec("123", SYMBOL_PAGE, 1.25f)) + listOf("•", "`", ":", ";", "©", "✓", "÷").map { KeySpec(it, it) } + KeySpec("⌫", DELETE, 1.25f),
        listOf(KeySpec("ABC", LETTERS, 1.55f), KeySpec("English", " ", 3f), KeySpec(actionLabel, ENTER, 1.55f)),
    )

    private fun keyTextSize(spec: KeySpec): Float = when {
        spec.action == " " -> 13f
        spec.label.length >= 4 -> 15f
        spec.label.length == 3 -> 18f
        else -> 21f
    }

    private fun keyColor(spec: KeySpec): Int = when {
        spec.action == ENTER -> Color.rgb(242, 241, 240)
        spec.action == SHIFT && shiftState.shifted -> Color.rgb(224, 223, 224)
        else -> KEY
    }

    private fun keyDescription(spec: KeySpec): String = when (spec.action) {
        SHIFT -> if (shiftState.capsLocked) "Caps lock on" else "Shift"
        DELETE -> "Delete"
        SYMBOLS -> "Numbers and symbols"
        LETTERS -> "Letters"
        SYMBOL_PAGE -> "More symbols"
        ENTER -> actionLabel
        " " -> "Space"
        else -> spec.label
    }

    private fun installKeyTouch(view: View, action: () -> Unit) {
        view.setOnClickListener { action() }
        view.setOnTouchListener { key, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    animatePressed(key, true)
                    if (hapticsEnabled) key.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    true
                }
                MotionEvent.ACTION_UP -> {
                    animatePressed(key, false)
                    if (event.x in 0f..key.width.toFloat() && event.y in 0f..key.height.toFloat()) key.performClick()
                    true
                }
                MotionEvent.ACTION_CANCEL -> { animatePressed(key, false); true }
                else -> true
            }
        }
    }

    private fun installDeleteTouch(view: TextView) {
        val handler = Handler(Looper.getMainLooper())
        var repeated = false
        val repeater = object : Runnable {
            override fun run() {
                repeated = true
                listener.onDelete()
                handler.postDelayed(this, 55)
            }
        }
        view.setOnClickListener { listener.onDelete() }
        view.setOnTouchListener { key, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    repeated = false
                    animatePressed(key, true)
                    if (hapticsEnabled) key.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    handler.postDelayed(repeater, 350)
                    true
                }
                MotionEvent.ACTION_UP -> {
                    handler.removeCallbacks(repeater)
                    animatePressed(key, false)
                    if (!repeated && event.x in 0f..key.width.toFloat() && event.y in 0f..key.height.toFloat()) key.performClick()
                    true
                }
                MotionEvent.ACTION_CANCEL -> { handler.removeCallbacks(repeater); animatePressed(key, false); true }
                else -> true
            }
        }
    }

    private fun installTapFeedback(
        view: View,
        listenerAction: () -> Unit,
        pressedScale: Float = 0.93f,
    ) {
        view.setOnClickListener { listenerAction() }
        view.setOnTouchListener { target, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    target.animate().cancel()
                    target.animate()
                        .scaleX(pressedScale)
                        .scaleY(pressedScale)
                        .alpha(0.78f)
                        .setDuration(PRESS_IN_MS)
                        .start()
                    if (hapticsEnabled) target.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
                    true
                }
                MotionEvent.ACTION_UP -> {
                    animatePressed(target, false)
                    if (event.x in 0f..target.width.toFloat() && event.y in 0f..target.height.toFloat()) target.performClick()
                    true
                }
                MotionEvent.ACTION_CANCEL -> {
                    animatePressed(target, false)
                    true
                }
                else -> true
            }
        }
    }

    private fun animatePressed(view: View, pressed: Boolean) {
        if (!animationsEnabled || !systemAnimationsEnabled()) {
            view.scaleX = if (pressed) 0.96f else 1f
            view.scaleY = if (pressed) 0.96f else 1f
            view.alpha = if (pressed) 0.78f else 1f
            return
        }
        view.animate().cancel()
        view.animate()
            .scaleX(if (pressed) 0.94f else 1f)
            .scaleY(if (pressed) 0.94f else 1f)
            .alpha(if (pressed) 0.72f else 1f)
            .setDuration(if (pressed) PRESS_IN_MS else PRESS_OUT_MS)
            .setInterpolator(motionInterpolator)
            .start()
    }

    private fun systemAnimationsEnabled(): Boolean = runCatching {
        android.provider.Settings.Global.getFloat(
            context.contentResolver,
            android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        ) > 0f
    }.getOrDefault(true)

    private fun circleKey(label: String, textSize: Float) = TextView(context).apply {
        text = label
        styleText(textSize, MUTED)
        gravity = Gravity.CENTER
        background = rounded(KEY_DARK, context.dp(40).toFloat())
    }

    override fun onDetachedFromWindow() {
        waveform.setActive(false)
        processing.setActive(false)
        super.onDetachedFromWindow()
    }

    private fun frame(width: Int, height: Int, gravity: Int) = FrameLayout.LayoutParams(width, height, gravity)
    private data class KeySpec(val label: String, val action: String, val weight: Float = 1f) {
        val value: String get() = action
    }

    private companion object {
        val BACKGROUND = Color.rgb(48, 48, 50)
        val KEY = Color.rgb(82, 82, 85)
        val KEY_DARK = Color.rgb(74, 74, 77)
        val PILL_DARK = Color.rgb(35, 35, 38)
        val SEGMENT_ACTIVE = Color.rgb(78, 78, 82)
        val MUTED = Color.rgb(199, 198, 202)
        val ERROR = Color.rgb(255, 150, 150)
        const val PRESS_IN_MS = 45L
        const val PRESS_OUT_MS = 90L
        const val ELEMENT_IN_MS = 175L
        const val ELEMENT_OUT_MS = 105L
        const val STATUS_TRANSITION_MS = 180L
        const val MODE_TRANSITION_MS = 185L
        const val MANUAL_REBUILD_MS = 115L
        const val SHIFT = "__shift"
        const val DELETE = "__delete"
        const val SYMBOLS = "__symbols"
        const val LETTERS = "__letters"
        const val SYMBOL_PAGE = "__symbol_page"
        const val ENTER = "__enter"
    }
}
