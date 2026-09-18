package com.aliahad.wovoice.ime

import android.content.Context
import android.graphics.Color
import android.view.Gravity
import android.view.ViewGroup
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.aliahad.wovoice.ui.dp
import com.aliahad.wovoice.ui.rounded

/**
 * The emoji page shown inside the manual keyboard: a category tab strip over a
 * scrollable grid, with an optional Recents tab kept at the front. Entirely
 * code-built to match the rest of the keyboard's view layer.
 */
class EmojiPanelView(context: Context) : LinearLayout(context) {

    var onEmojiSelected: ((String) -> Unit)? = null

    private val tabRow: LinearLayout
    private val adapter = EmojiAdapter { emoji -> onEmojiSelected?.invoke(emoji) }
    private var selectedCategory = 0
    private var recents: List<String> = emptyList()

    init {
        orientation = VERTICAL
        setBackgroundColor(PANEL_BACKGROUND)

        val tabsScroll = HorizontalScrollView(context).apply {
            isHorizontalScrollBarEnabled = false
            isFillViewport = true
            clipToPadding = false
            setPadding(context.dp(6), context.dp(4), context.dp(6), 0)
        }
        tabRow = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        tabsScroll.addView(tabRow, ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.MATCH_PARENT))
        addView(tabsScroll, LayoutParams(LayoutParams.MATCH_PARENT, context.dp(42)))

        val grid = RecyclerView(context).apply {
            layoutManager = GridLayoutManager(context, GRID_SPAN)
            adapter = this@EmojiPanelView.adapter
            clipToPadding = false
            setPadding(context.dp(4), context.dp(2), context.dp(4), context.dp(6))
        }
        addView(grid, LayoutParams(LayoutParams.MATCH_PARENT, 0, 1f))

        selectCategory(if (recents.isEmpty()) RECENTS_INDEX + 1 else RECENTS_INDEX)
    }

    /** Recents tab index, or -1 when there is no recents history yet. */
    private fun recentsTabIndex(): Int = if (recents.isEmpty()) -1 else 0

    private fun categoryCount(): Int = EmojiCatalog.categories.size + recentsTabIndex() + 1

    private fun categoryAt(index: Int): List<String> =
        if (index == recentsTabIndex()) recents else EmojiCatalog.categories[index - (recentsTabIndex() + 1)].emojis

    private fun tabLabelAt(index: Int): String =
        if (index == recentsTabIndex()) RECENTS_TAB_EMOJI else EmojiCatalog.categories[index - (recentsTabIndex() + 1)].tabEmoji

    private fun tabDescriptionAt(index: Int): String =
        if (index == recentsTabIndex()) "Recently used emojis" else EmojiCatalog.categories[index - (recentsTabIndex() + 1)].label

    fun setRecents(values: List<String>) {
        val hadRecents = recents.isNotEmpty()
        recents = values
        if (hadRecents != recents.isNotEmpty()) {
            selectedCategory += if (recents.isNotEmpty()) 1 else -1
            rebuildTabs()
        }
        if (selectedCategory == RECENTS_INDEX) adapter.submit(recents)
        restyleTabs()
    }

    fun selectCategory(index: Int) {
        selectedCategory = index.coerceIn(0, categoryCount() - 1)
        adapter.submit(categoryAt(selectedCategory))
        rebuildTabs()
    }

    private fun rebuildTabs() {
        tabRow.removeAllViews()
        repeat(categoryCount()) { index ->
            val tab = TextView(context).apply {
                text = tabLabelAt(index)
                contentDescription = tabDescriptionAt(index)
                gravity = Gravity.CENTER
                textSize = 17f
                includeFontPadding = false
                setOnClickListener {
                    if (selectedCategory != index) selectCategory(index)
                }
            }
            tabRow.addView(
                tab,
                LayoutParams(context.dp(TAB_WIDTH_DP), ViewGroup.LayoutParams.MATCH_PARENT),
            )
        }
        restyleTabs()
    }

    private fun restyleTabs() {
        repeat(categoryCount()) { index ->
            val tab = tabRow.getChildAt(index) as? TextView ?: return@repeat
            val selected = index == selectedCategory
            tab.background = rounded(
                if (selected) TAB_ACTIVE else Color.TRANSPARENT,
                context.dp(10).toFloat(),
            )
            tab.alpha = if (selected) 1f else 0.45f
        }
    }

    private class EmojiAdapter(
        private val onPick: (String) -> Unit,
    ) : RecyclerView.Adapter<EmojiHolder>() {

        private val emojis = mutableListOf<String>()

        fun submit(values: List<String>) {
            emojis.clear()
            emojis.addAll(values)
            notifyDataSetChanged()
        }

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): EmojiHolder {
            val cell = TextView(parent.context).apply {
                gravity = Gravity.CENTER
                textSize = 24f
                includeFontPadding = false
                setBackgroundColor(PANEL_BACKGROUND)
            }
            return EmojiHolder(cell, onPick)
        }

        override fun onBindViewHolder(holder: EmojiHolder, position: Int) = holder.bind(emojis[position])

        override fun getItemCount(): Int = emojis.size
    }

    private class EmojiHolder(
        private val cell: TextView,
        private val onPick: (String) -> Unit,
    ) : RecyclerView.ViewHolder(cell) {

        private var emoji: String = ""

        init {
            cell.minimumHeight = cell.context.dp(CELL_HEIGHT_DP)
            cell.setOnClickListener {
                if (emoji.isNotEmpty()) onPick(emoji)
            }
            cell.setOnTouchListener { view, event ->
                when (event.actionMasked) {
                    android.view.MotionEvent.ACTION_DOWN -> {
                        view.animate().cancel()
                        view.animate().scaleX(0.82f).scaleY(0.82f).setDuration(45).start()
                        view.performHapticFeedback(android.view.HapticFeedbackConstants.KEYBOARD_TAP)
                        true
                    }
                    android.view.MotionEvent.ACTION_UP, android.view.MotionEvent.ACTION_CANCEL -> {
                        view.animate().cancel()
                        view.animate().scaleX(1f).scaleY(1f).setDuration(90).start()
                        if (event.actionMasked == android.view.MotionEvent.ACTION_UP) view.performClick()
                        true
                    }
                    else -> true
                }
            }
        }

        fun bind(value: String) {
            emoji = value
            cell.text = value
            cell.contentDescription = value
        }
    }

    private companion object {
        val PANEL_BACKGROUND = Color.rgb(48, 48, 50)
        val TAB_ACTIVE = Color.rgb(78, 78, 82)
        const val RECENTS_INDEX = 0
        const val RECENTS_TAB_EMOJI = "🕘"
        const val GRID_SPAN = 8
        const val TAB_WIDTH_DP = 38
        const val CELL_HEIGHT_DP = 44
    }
}
