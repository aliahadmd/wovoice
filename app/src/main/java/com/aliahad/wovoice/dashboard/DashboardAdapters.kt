package com.aliahad.wovoice.dashboard

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.aliahad.wovoice.data.DictationRecord
import com.aliahad.wovoice.data.DictionaryEntry
import com.aliahad.wovoice.ui.dp
import com.aliahad.wovoice.ui.rounded
import com.aliahad.wovoice.ui.styleText
import com.google.android.material.card.MaterialCardView
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

sealed interface HistoryRow {
    val stableId: String

    data class Header(val label: String, override val stableId: String) : HistoryRow
    data class Item(val record: DictationRecord) : HistoryRow {
        override val stableId: String = "record-${record.id}-${record.requestId}"
    }
}

class HistoryAdapter(
    private val onOpen: (DictationRecord) -> Unit,
    private val onCopy: (DictationRecord) -> Unit,
) : ListAdapter<HistoryRow, RecyclerView.ViewHolder>(HISTORY_DIFF) {

    override fun getItemViewType(position: Int): Int = if (getItem(position) is HistoryRow.Header) HEADER else ITEM

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder = if (viewType == HEADER) {
        HeaderHolder(TextView(parent.context).apply {
            styleText(13f, MUTED)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setPadding(context.dp(4), context.dp(18), context.dp(4), context.dp(7))
        })
    } else {
        ItemHolder(createHistoryCard(parent.context), onOpen, onCopy)
    }

    override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
        when (val value = getItem(position)) {
            is HistoryRow.Header -> (holder as HeaderHolder).label.text = value.label.uppercase(Locale.getDefault())
            is HistoryRow.Item -> (holder as ItemHolder).bind(value.record)
        }
    }

    fun recordAt(position: Int): DictationRecord? = (currentList.getOrNull(position) as? HistoryRow.Item)?.record

    private class HeaderHolder(val label: TextView) : RecyclerView.ViewHolder(label)

    private class ItemHolder(
        card: MaterialCardView,
        private val onOpen: (DictationRecord) -> Unit,
        private val onCopy: (DictationRecord) -> Unit,
    ) : RecyclerView.ViewHolder(card) {
        private val text = card.findViewWithTag<TextView>("text")
        private val metadata = card.findViewWithTag<TextView>("metadata")
        private val copy = card.findViewWithTag<TextView>("copy")
        private var record: DictationRecord? = null

        init {
            card.setOnClickListener { record?.let(onOpen) }
            copy.setOnClickListener { record?.let(onCopy) }
        }

        fun bind(value: DictationRecord) {
            record = value
            text.text = value.finalText
            val time = Instant.ofEpochMilli(value.createdAtMs)
                .atZone(runCatching { ZoneId.of(value.zoneId) }.getOrDefault(ZoneId.systemDefault()))
                .format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT))
            val seconds = value.audioDurationMs / 1_000.0
            metadata.text = "$time  •  ${value.wordCount} words  •  ${formatDuration(seconds)}"
        }
    }

    private companion object {
        const val HEADER = 0
        const val ITEM = 1
        val MUTED = Color.rgb(171, 170, 181)
        val HISTORY_DIFF = object : DiffUtil.ItemCallback<HistoryRow>() {
            override fun areItemsTheSame(oldItem: HistoryRow, newItem: HistoryRow) = oldItem.stableId == newItem.stableId
            override fun areContentsTheSame(oldItem: HistoryRow, newItem: HistoryRow) = oldItem == newItem
        }
    }
}

class DictionaryAdapter(
    private val confirmed: Boolean,
    private val onPrimary: (DictionaryEntry) -> Unit,
    private val onDelete: (DictionaryEntry) -> Unit,
) : ListAdapter<DictionaryEntry, DictionaryAdapter.Holder>(DICTIONARY_DIFF) {

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder =
        Holder(createDictionaryCard(parent.context), confirmed, onPrimary, onDelete)

    override fun onBindViewHolder(holder: Holder, position: Int) = holder.bind(getItem(position))

    class Holder(
        card: MaterialCardView,
        private val confirmed: Boolean,
        private val onPrimary: (DictionaryEntry) -> Unit,
        private val onDelete: (DictionaryEntry) -> Unit,
    ) : RecyclerView.ViewHolder(card) {
        private val term = card.findViewWithTag<TextView>("term")
        private val source = card.findViewWithTag<TextView>("source")
        private val primary = card.findViewWithTag<TextView>("primary")
        private val delete = card.findViewWithTag<TextView>("delete")
        private var entry: DictionaryEntry? = null

        init {
            primary.setOnClickListener { entry?.let(onPrimary) }
            delete.setOnClickListener { entry?.let(onDelete) }
        }

        fun bind(value: DictionaryEntry) {
            entry = value
            term.text = value.term
            source.text = when (value.source) {
                DictionaryEntry.SOURCE_MANUAL -> "Added manually"
                DictionaryEntry.SOURCE_IMPORTED -> "Imported vocabulary"
                else -> "Learned from a correction"
            }
            primary.text = if (confirmed) "Edit" else "Accept"
            delete.text = if (confirmed) "Delete" else "Dismiss"
        }
    }

    private companion object {
        val DICTIONARY_DIFF = object : DiffUtil.ItemCallback<DictionaryEntry>() {
            override fun areItemsTheSame(oldItem: DictionaryEntry, newItem: DictionaryEntry) = oldItem.id == newItem.id
            override fun areContentsTheSame(oldItem: DictionaryEntry, newItem: DictionaryEntry) = oldItem == newItem
        }
    }
}

private fun createHistoryCard(context: Context): MaterialCardView = MaterialCardView(context).apply {
    radius = context.dp(18).toFloat()
    cardElevation = 0f
    setCardBackgroundColor(CARD)
    strokeWidth = context.dp(1)
    setStrokeColor(BORDER)
    isClickable = true
    foreground = context.obtainStyledAttributes(intArrayOf(android.R.attr.selectableItemBackground)).run {
        getDrawable(0).also { recycle() }
    }
    layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        bottomMargin = context.dp(10)
    }
    addView(LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(context.dp(16), context.dp(15), context.dp(12), context.dp(12))
        addView(TextView(context).apply {
            tag = "text"
            styleText(16f)
            maxLines = 4
            setLineSpacing(0f, 1.12f)
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        addView(LinearLayout(context).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(TextView(context).apply {
                tag = "metadata"
                styleText(12.5f, MUTED)
            }, LinearLayout.LayoutParams(0, context.dp(42), 1f).apply { gravity = Gravity.CENTER_VERTICAL })
            addView(TextView(context).apply {
                tag = "copy"
                text = "Copy"
                styleText(14f, ACCENT)
                gravity = Gravity.CENTER
                background = rounded(ACTION, context.dp(18).toFloat())
            }, LinearLayout.LayoutParams(context.dp(68), context.dp(38)))
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(46)).apply { topMargin = context.dp(6) })
    })
}

private fun createDictionaryCard(context: Context): MaterialCardView = MaterialCardView(context).apply {
    radius = context.dp(17).toFloat()
    cardElevation = 0f
    setCardBackgroundColor(CARD)
    strokeWidth = context.dp(1)
    setStrokeColor(BORDER)
    layoutParams = RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
        bottomMargin = context.dp(10)
    }
    addView(LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(context.dp(16), context.dp(14), context.dp(12), context.dp(10))
        addView(TextView(context).apply {
            tag = "term"
            styleText(17f)
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        })
        addView(TextView(context).apply {
            tag = "source"
            styleText(12.5f, MUTED)
            setPadding(0, context.dp(4), 0, context.dp(8))
        })
        addView(LinearLayout(context).apply {
            gravity = Gravity.END
            addView(action(context, "primary"), LinearLayout.LayoutParams(context.dp(82), context.dp(38)))
            addView(action(context, "delete", destructive = true), LinearLayout.LayoutParams(context.dp(82), context.dp(38)).apply {
                leftMargin = context.dp(8)
            })
        }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, context.dp(40)))
    })
}

private fun action(context: Context, tagValue: String, destructive: Boolean = false) = TextView(context).apply {
    tag = tagValue
    gravity = Gravity.CENTER
    styleText(13.5f, if (destructive) DANGER else ACCENT)
    background = rounded(ACTION, context.dp(18).toFloat())
}

private fun formatDuration(seconds: Double): String = when {
    seconds < 60 -> "${seconds.toInt()}s"
    else -> "${(seconds / 60).toInt()}m ${(seconds.toInt() % 60)}s"
}

private val CARD = Color.rgb(36, 35, 41)
private val BORDER = Color.rgb(55, 53, 65)
private val ACTION = Color.rgb(50, 47, 63)
private val ACCENT = Color.rgb(174, 163, 255)
private val DANGER = Color.rgb(255, 151, 158)
private val MUTED = Color.rgb(171, 170, 181)
