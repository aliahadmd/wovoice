package com.aliahad.wovoice.settings

import android.Manifest
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.provider.Settings
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.aliahad.wovoice.R
import com.aliahad.wovoice.dashboard.DictionaryAdapter
import com.aliahad.wovoice.dashboard.HistoryAdapter
import com.aliahad.wovoice.dashboard.HistoryRow
import com.aliahad.wovoice.data.AnalyticsPeriod
import com.aliahad.wovoice.data.DashboardMetrics
import com.aliahad.wovoice.data.DictationRecord
import com.aliahad.wovoice.data.DictionaryEntry
import com.aliahad.wovoice.data.WoVoiceRepository
import com.aliahad.wovoice.network.TranscriptionClient
import com.aliahad.wovoice.ui.dp
import com.aliahad.wovoice.ui.rounded
import com.aliahad.wovoice.ui.styleText
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.navigation.NavigationBarView
import com.google.android.material.card.MaterialCardView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import com.google.android.material.switchmaterial.SwitchMaterial
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlin.math.roundToInt

@SuppressLint("SetTextI18n")
class SetupActivity : AppCompatActivity() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val client = TranscriptionClient()
    private lateinit var store: SettingsStore
    private lateinit var repository: WoVoiceRepository
    private lateinit var contentHost: FrameLayout
    private lateinit var bottomNavigation: BottomNavigationView
    private val screens = mutableMapOf<Int, View>()
    private var activeTab = TAB_HOME
    private var analyticsPeriod = AnalyticsPeriod.TODAY
    private var historyJob: Job? = null
    private var dictionaryJob: Job? = null

    private val metricViews = mutableMapOf<String, TextView>()
    private lateinit var readinessText: TextView
    private lateinit var aiInsightsText: TextView
    private lateinit var usageTotalText: TextView
    private lateinit var usageBreakdownText: TextView
    private lateinit var recentContainer: LinearLayout
    private lateinit var periodSelector: LinearLayout

    private lateinit var historyAdapter: HistoryAdapter
    private lateinit var historyEmpty: TextView
    private lateinit var historySearch: EditText
    private lateinit var historyRecycler: RecyclerView

    private var dictionaryConfirmed = true
    private lateinit var dictionaryAdapter: DictionaryAdapter
    private lateinit var dictionaryEmpty: TextView
    private lateinit var dictionarySearch: EditText
    private lateinit var dictionaryRecycler: RecyclerView
    private lateinit var dictionaryTabs: LinearLayout
    private var dictionaryAdapterConfirmed: Boolean? = null

    private var microphoneStatus: TextView? = null
    private var keyboardStatus: TextView? = null
    private var urlField: EditText? = null
    private var tokenField: EditText? = null
    private var connectionStatus: TextView? = null
    private var testButton: Button? = null

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        updateSetupStatus()
        refreshHome()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = SettingsStore(this)
        repository = WoVoiceRepository(this)
        activeTab = savedInstanceState?.getInt(STATE_TAB, TAB_HOME) ?: TAB_HOME
        analyticsPeriod = AnalyticsPeriod.entries.getOrElse(savedInstanceState?.getInt(STATE_PERIOD) ?: 0) {
            AnalyticsPeriod.TODAY
        }
        configureWindow()
        setContentView(buildShell())
        bottomNavigation.selectedItemId = activeTab
        showTab(activeTab, animate = false)
        scope.launch(Dispatchers.IO) {
            repository.importGlossary(store.glossary)
            syncGlossaryCache()
        }
    }

    override fun onResume() {
        super.onResume()
        updateSetupStatus()
        when (activeTab) {
            TAB_HOME -> refreshHome()
            TAB_HISTORY -> refreshHistory()
            TAB_DICTIONARY -> refreshDictionary()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putInt(STATE_TAB, activeTab)
        outState.putInt(STATE_PERIOD, analyticsPeriod.ordinal)
        super.onSaveInstanceState(outState)
    }

    override fun onDestroy() {
        historyJob?.cancel()
        dictionaryJob?.cancel()
        client.cancel()
        scope.cancel()
        super.onDestroy()
    }

    private fun configureWindow() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = BACKGROUND
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
    }

    private fun buildShell(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BACKGROUND)
        }
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        contentHost = FrameLayout(this).apply {
            clipChildren = false
            clipToPadding = false
        }
        root.addView(contentHost, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))

        bottomNavigation = BottomNavigationView(this).apply {
            setBackgroundColor(NAVIGATION)
            elevation = 0f
            itemIconSize = dp(23)
            itemTextAppearanceActive = com.google.android.material.R.style.TextAppearance_Material3_LabelMedium
            itemTextAppearanceInactive = com.google.android.material.R.style.TextAppearance_Material3_LabelMedium
            itemIconTintList = navigationColors()
            itemTextColor = navigationColors()
            itemRippleColor = ColorStateList.valueOf(Color.argb(34, 174, 163, 255))
            labelVisibilityMode = NavigationBarView.LABEL_VISIBILITY_LABELED
            menu.add(0, TAB_HOME, 0, "Home").setIcon(R.drawable.ic_nav_home)
            menu.add(0, TAB_HISTORY, 1, "History").setIcon(R.drawable.ic_nav_history)
            menu.add(0, TAB_DICTIONARY, 2, "Dictionary").setIcon(R.drawable.ic_nav_dictionary)
            menu.add(0, TAB_SETTINGS, 3, "Settings").setIcon(R.drawable.ic_nav_settings)
            setOnItemSelectedListener { item ->
                if (item.itemId != activeTab) showTab(item.itemId, animate = true)
                true
            }
        }
        root.addView(bottomNavigation, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(72)))
        return root
    }

    private fun showTab(tab: Int, animate: Boolean) {
        val previous = contentHost.getChildAt(0)
        val incoming = screens.getOrPut(tab) {
            when (tab) {
                TAB_HISTORY -> buildHistoryScreen()
                TAB_DICTIONARY -> buildDictionaryScreen()
                TAB_SETTINGS -> buildSettingsScreen()
                else -> buildHomeScreen()
            }
        }
        if (previous === incoming) {
            refreshTab(tab)
            return
        }
        (incoming.parent as? ViewGroup)?.removeView(incoming)
        if (!animate || previous == null || !store.animationsEnabled) {
            contentHost.removeAllViews()
            contentHost.addView(incoming, FrameLayout.LayoutParams(-1, -1))
        } else {
            incoming.alpha = 0f
            incoming.translationX = dp(16).toFloat()
            contentHost.addView(incoming, FrameLayout.LayoutParams(-1, -1))
            incoming.animate().alpha(1f).translationX(0f).setDuration(190).start()
            previous.animate().alpha(0f).translationX(-dp(12).toFloat()).setDuration(150).withEndAction {
                contentHost.removeView(previous)
                previous.alpha = 1f
                previous.translationX = 0f
            }.start()
        }
        activeTab = tab
        refreshTab(tab)
    }

    private fun refreshTab(tab: Int) {
        when (tab) {
            TAB_HOME -> refreshHome()
            TAB_HISTORY -> refreshHistory()
            TAB_DICTIONARY -> refreshDictionary()
            TAB_SETTINGS -> updateSetupStatus()
        }
    }

    private fun buildHomeScreen(): View {
        val body = pageColumn()
        body.addView(hero("Your voice workspace", "Private analytics and recent dictations"))

        readinessText = TextView(this).apply {
            styleText(14f)
            setLineSpacing(0f, 1.2f)
        }
        body.addView(card("READY STATUS", readinessText))

        body.addView(sectionHeader("Overview"))
        periodSelector = segmented(
            listOf("Today", "7 days", "30 days", "All time"),
            analyticsPeriod.ordinal,
        ) { index ->
            analyticsPeriod = AnalyticsPeriod.entries[index]
            styleSegmented(periodSelector, index)
            refreshHome()
        }
        body.addView(periodSelector, linear(match = true, height = dp(48)).apply { bottomMargin = dp(14) })

        body.addView(metricRow(metric("dictations", "Dictations"), metric("duration", "Dictation time")))
        body.addView(metricRow(metric("words", "Words dictated"), metric("wpm", "Speaking pace")))

        aiInsightsText = TextView(this).apply {
            styleText(15f)
            setLineSpacing(dp(3).toFloat(), 1.18f)
        }
        body.addView(card("AI INSIGHTS", aiInsightsText))

        val usageContent = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            usageTotalText = TextView(this@SetupActivity).apply {
                styleText(26f)
                typeface = Typeface.create("sans-serif", Typeface.BOLD)
            }
            addView(usageTotalText)
            addView(TextView(this@SetupActivity).apply {
                text = "Estimated WoVoice usage — not a Cloudflare invoice"
                styleText(12.5f, MUTED)
                setPadding(0, dp(3), 0, dp(12))
            })
            usageBreakdownText = TextView(this@SetupActivity).apply {
                styleText(14f, MUTED)
                setLineSpacing(dp(2).toFloat(), 1.16f)
            }
            addView(usageBreakdownText)
        }
        body.addView(card("ESTIMATED AI USAGE", usageContent))

        body.addView(sectionHeader("Recent dictations", "View all") {
            bottomNavigation.selectedItemId = TAB_HISTORY
        })
        recentContainer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        body.addView(recentContainer)
        return scroll(body)
    }

    private fun refreshHome() {
        if (!::readinessText.isInitialized) return
        updateReadiness()
        scope.launch {
            val now = ZonedDateTime.now()
            val (snapshot, usageRanges) = withContext(Dispatchers.IO) {
                val selected = repository.dashboard(analyticsPeriod)
                val today = repository.metricsSince(AnalyticsPeriod.TODAY.sinceMs(now))
                val month = repository.metricsSince(now.withDayOfMonth(1).toLocalDate().atStartOfDay(now.zone).toInstant().toEpochMilli())
                selected to (today to month)
            }
            val metrics = WoVoiceRepository.metrics(snapshot.aggregates)
            renderMetrics(metrics, usageRanges.first, usageRanges.second)
            recentContainer.removeAllViews()
            if (snapshot.recent.isEmpty()) {
                recentContainer.addView(emptyState("Your successful dictations will appear here.", compact = true))
            } else {
                snapshot.recent.forEach { record -> recentContainer.addView(recentPreview(record)) }
            }
        }
    }

    private fun updateReadiness() {
        val mic = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        val manager = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        val enabled = manager.enabledInputMethodList.any { it.packageName == packageName }
        val selected = Settings.Secure.getString(contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)
            ?.startsWith(packageName) == true
        val connected = store.isConfigured()
        readinessText.text = listOf(
            statusLine(mic, "Microphone ready", "Microphone permission needed"),
            statusLine(selected, "WoVoice selected", if (enabled) "Choose WoVoice as keyboard" else "Keyboard not enabled"),
            statusLine(connected, "Worker configured", "Worker connection needs setup"),
        ).joinToString("\n")
    }

    private fun renderMetrics(value: DashboardMetrics, today: DashboardMetrics, month: DashboardMetrics) {
        setMetric("dictations", value.dictations.toString(), "successful")
        setMetric("duration", formatDuration(value.audioDurationMs), "recorded speech")
        setMetric("words", value.words.toString(), "total words")
        setMetric("wpm", value.wpm.toString(), "words per minute")
        aiInsightsText.text = "Median processing   ${formatProcessing(value.medianProcessingMs)}\n" +
            "Polished results     ${value.polishedRate}%\n" +
            "Correction rate      ${value.correctionRate}%"
        val estimatesVisible = store.costEstimatesEnabled
        usageTotalText.text = if (estimatesVisible) formatCost(value.estimatedCostUsd) else "Hidden"
        usageBreakdownText.text = if (estimatesVisible) {
            "Today ${formatCost(today.estimatedCostUsd)}  •  This month ${formatCost(month.estimatedCostUsd)}\n" +
                "${formatNeurons(value.totalNeurons)} neurons in selected period\n" +
                "ASR ${formatNeurons(value.asrNeurons)}  •  Polish ${formatNeurons(value.polishNeurons)}"
        } else {
            "Enable cost estimates in Settings to show local usage."
        }
    }

    private fun buildHistoryScreen(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(15), dp(20), 0)
        }
        root.addView(screenHeader("History", "Successful dictations kept on this phone", "Clear") { confirmClearHistory() })
        historySearch = searchField("Search generated text")
        root.addView(historySearch, linear(match = true, height = dp(52)).apply { bottomMargin = dp(10) })
        historySearch.onTextChanged { refreshHistory() }

        val listFrame = FrameLayout(this)
        historyAdapter = HistoryAdapter(::showHistoryDetail, ::copyRecord)
        historyRecycler = RecyclerView(this).apply {
            layoutManager = LinearLayoutManager(this@SetupActivity)
            adapter = historyAdapter
            itemAnimator?.changeDuration = 170
            clipToPadding = false
            setPadding(0, 0, 0, dp(22))
        }
        historyEmpty = emptyState("No dictations yet.\nUse WoVoice in any text field and your successful results will appear here.")
        listFrame.addView(historyRecycler, frame(match = true))
        listFrame.addView(historyEmpty, frame(match = true))
        root.addView(listFrame, LinearLayout.LayoutParams(-1, 0, 1f))

        ItemTouchHelper(object : ItemTouchHelper.SimpleCallback(0, ItemTouchHelper.LEFT) {
            override fun onMove(recyclerView: RecyclerView, viewHolder: RecyclerView.ViewHolder, target: RecyclerView.ViewHolder) = false
            override fun getSwipeDirs(recyclerView: RecyclerView, viewHolder: RecyclerView.ViewHolder): Int =
                if (historyAdapter.recordAt(viewHolder.bindingAdapterPosition) == null) 0 else super.getSwipeDirs(recyclerView, viewHolder)
            override fun onSwiped(viewHolder: RecyclerView.ViewHolder, direction: Int) {
                historyAdapter.recordAt(viewHolder.bindingAdapterPosition)?.let(::deleteHistoryWithUndo)
            }
        }).attachToRecyclerView(historyRecycler)
        return root
    }

    private fun refreshHistory() {
        if (!::historyAdapter.isInitialized) return
        historyJob?.cancel()
        historyJob = scope.launch {
            val records = withContext(Dispatchers.IO) { repository.history(historySearch.text.toString()) }
            val rows = historyRows(records)
            historyAdapter.submitList(rows)
            historyEmpty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
            historyRecycler.visibility = if (rows.isEmpty()) View.GONE else View.VISIBLE
        }
    }

    private fun historyRows(records: List<DictationRecord>): List<HistoryRow> {
        val rows = mutableListOf<HistoryRow>()
        var lastLabel: String? = null
        records.forEach { record ->
            val label = historyGroup(record)
            if (label != lastLabel) {
                rows += HistoryRow.Header(label, "header-$label")
                lastLabel = label
            }
            rows += HistoryRow.Item(record)
        }
        return rows
    }

    private fun buildDictionaryScreen(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(15), dp(20), 0)
        }
        root.addView(screenHeader("Dictionary", "Names and terms WoVoice should recognize", "+ Add") { showTermDialog() })
        dictionaryTabs = segmented(listOf("Confirmed", "Suggestions"), 0) { index ->
            dictionaryConfirmed = index == 0
            styleSegmented(dictionaryTabs, index)
            refreshDictionary()
        }
        root.addView(dictionaryTabs, linear(match = true, height = dp(48)).apply { bottomMargin = dp(10) })
        dictionarySearch = searchField("Search dictionary")
        root.addView(dictionarySearch, linear(match = true, height = dp(52)).apply { bottomMargin = dp(10) })
        dictionarySearch.onTextChanged { refreshDictionary() }

        val frame = FrameLayout(this)
        dictionaryRecycler = RecyclerView(this).apply {
            layoutManager = LinearLayoutManager(this@SetupActivity)
            clipToPadding = false
            setPadding(0, 0, 0, dp(22))
        }
        dictionaryEmpty = emptyState("No terms here yet.")
        frame.addView(dictionaryRecycler, frame(match = true))
        frame.addView(dictionaryEmpty, frame(match = true))
        root.addView(frame, LinearLayout.LayoutParams(-1, 0, 1f))
        installDictionaryAdapter()
        return root
    }

    private fun installDictionaryAdapter() {
        dictionaryAdapter = DictionaryAdapter(
            confirmed = dictionaryConfirmed,
            onPrimary = { entry -> if (dictionaryConfirmed) showTermDialog(entry) else acceptSuggestion(entry) },
            onDelete = { entry -> deleteDictionaryEntry(entry) },
        )
        dictionaryRecycler.adapter = dictionaryAdapter
        dictionaryAdapterConfirmed = dictionaryConfirmed
    }

    private fun refreshDictionary() {
        if (!::dictionaryRecycler.isInitialized) return
        dictionaryJob?.cancel()
        if (!::dictionaryAdapter.isInitialized || dictionaryAdapterConfirmed != dictionaryConfirmed) installDictionaryAdapter()
        dictionaryJob = scope.launch {
            val values = withContext(Dispatchers.IO) {
                repository.dictionary(dictionaryConfirmed, dictionarySearch.text.toString())
            }
            dictionaryAdapter.submitList(values)
            dictionaryEmpty.text = if (dictionaryConfirmed) {
                "No confirmed terms yet.\nAdd important names or specialist words."
            } else {
                "No suggestions to review.\nWoVoice will suggest unusual words after a correction."
            }
            dictionaryEmpty.visibility = if (values.isEmpty()) View.VISIBLE else View.GONE
            dictionaryRecycler.visibility = if (values.isEmpty()) View.GONE else View.VISIBLE
        }
    }

    private fun buildSettingsScreen(): View {
        val body = pageColumn()
        body.addView(hero("Settings", "Setup, preferences, privacy, and data"))

        microphoneStatus = statusText()
        keyboardStatus = statusText()
        body.addView(settingsCard("SETUP", listOf(
            settingBlock("Microphone", microphoneStatus!!, "Allow") { permissionLauncher.launch(Manifest.permission.RECORD_AUDIO) },
            settingBlock("Keyboard access", keyboardStatus!!, "Enable") { startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS)) },
            settingAction("Choose active keyboard", "Open Android’s keyboard picker", "Choose") {
                (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showInputMethodPicker()
            },
        )))

        urlField = input("https://your-worker.workers.dev", InputType.TYPE_TEXT_VARIATION_URI).apply { setText(store.workerUrl) }
        tokenField = input(
            if (store.hasDeviceToken()) "Device token saved securely — leave blank to keep it" else "Device token",
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD,
        )
        connectionStatus = statusText()
        testButton = actionButton("Save and test connection") { saveAndTest() }
        body.addView(settingsCard("PRIVATE CLOUDFLARE WORKER", listOf(
            urlField!!,
            tokenField!!,
            TextView(this).apply {
                text = "The device token stays encrypted with Android Keystore. HTTPS is required."
                styleText(12.5f, MUTED)
                setPadding(dp(2), dp(6), dp(2), dp(4))
            },
            testButton!!,
            connectionStatus!!,
        )))

        body.addView(settingsCard("VOICE & LANGUAGE", listOf(
            fixedSetting("Recognition language", "English (India)"),
            fixedSetting("Grammar polish", "Light"),
            fixedSetting("Punctuation and numerals", "Automatic"),
            fixedSetting("Spoken commands", "New line and new paragraph"),
        )))

        body.addView(settingsCard("KEYBOARD", listOf(
            settingSwitch("Haptic feedback", "Feel a light response when tapping keys", store.hapticsEnabled) { store.hapticsEnabled = it },
            settingSwitch("Smooth animations", "Transitions and processing motion", store.animationsEnabled) { store.animationsEnabled = it },
            settingSwitch("Live waveform", "Show microphone activity while speaking", store.waveformEnabled) { store.waveformEnabled = it },
        )))

        body.addView(settingsCard("HISTORY & ANALYTICS", listOf(
            settingSwitch("Keep local history", "Store successful generated text until you delete it", store.historyEnabled) { store.historyEnabled = it },
            settingSwitch("Show cost estimates", "WoVoice-only estimates in USD", store.costEstimatesEnabled) { store.costEstimatesEnabled = it; refreshHome() },
            destructiveAction("Clear history", "Remove generated text but keep anonymous totals") { confirmClearHistory() },
            destructiveAction("Reset analytics", "Remove dictation and estimated usage totals") { confirmResetAnalytics() },
        )))

        body.addView(settingsCard("DICTIONARY & LEARNING", listOf(
            settingSwitch("Correction suggestions", "Review likely names and unique terms before adding them", store.learningSuggestionsEnabled) {
                store.learningSuggestionsEnabled = it
            },
            settingAction("Manage dictionary", "Confirmed terms and suggestions", "Open") {
                bottomNavigation.selectedItemId = TAB_DICTIONARY
            },
        )))

        body.addView(settingsCard("PRIVACY & DATA", listOf(
            TextView(this).apply {
                text = "History, analytics, and correction context stay in app-private storage. Audio and raw ASR text are never retained. Only approved glossary terms are sent with a recording."
                styleText(14f, MUTED)
                setLineSpacing(dp(3).toFloat(), 1.15f)
                setPadding(0, dp(4), 0, dp(10))
            },
            destructiveAction("Clear all local data", "Remove history, analytics, dictionary, connection, and token") { confirmClearAll() },
        )))

        body.addView(settingsCard("ABOUT", listOf(
            fixedSetting("WoVoice", "Version ${packageManager.getPackageInfo(packageName, 0).versionName}"),
            fixedSetting("Recognition", "Cloudflare Workers AI through your private Worker"),
            fixedSetting("Storage", "This phone only • no backup • no analytics SDK"),
        )))
        return scroll(body)
    }

    private fun saveAndTest() {
        saveConnectionFields()
        val url = store.workerUrl
        val token = store.deviceToken()
        if (!url.startsWith("https://") || token.isNullOrBlank()) {
            setConnectionStatus("Enter an HTTPS Worker URL and device token.", ERROR)
            return
        }
        testButton?.isEnabled = false
        setConnectionStatus("Testing secure connection…", MUTED)
        scope.launch {
            val result = withContext(Dispatchers.IO) { client.testConnection(url, token) }
            testButton?.isEnabled = true
            when (result) {
                is TranscriptionClient.Result.Success -> setConnectionStatus("✓ Connected. WoVoice is ready.", SUCCESS)
                is TranscriptionClient.Result.Error -> setConnectionStatus(result.message, ERROR)
            }
            refreshHome()
        }
    }

    private fun saveConnectionFields() {
        urlField?.let { store.workerUrl = it.text.toString() }
        tokenField?.text?.toString()?.trim()?.takeIf(String::isNotEmpty)?.let(store::saveDeviceToken)
        tokenField?.text?.clear()
        tokenField?.hint = if (store.hasDeviceToken()) "Device token saved securely — leave blank to keep it" else "Device token"
    }

    private fun updateSetupStatus() {
        val micGranted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        microphoneStatus?.text = if (micGranted) "✓ Allowed and ready" else "Permission required for speech input"
        microphoneStatus?.setTextColor(if (micGranted) SUCCESS else MUTED)
        val manager = getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        val enabled = manager.enabledInputMethodList.any { it.packageName == packageName }
        val selected = Settings.Secure.getString(contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD)?.startsWith(packageName) == true
        keyboardStatus?.text = when {
            selected -> "✓ WoVoice is selected"
            enabled -> "Enabled — choose WoVoice as active keyboard"
            else -> "WoVoice is not enabled yet"
        }
        keyboardStatus?.setTextColor(if (selected) SUCCESS else MUTED)
    }

    private fun showTermDialog(entry: DictionaryEntry? = null) {
        val field = input("Name or specialist term", InputType.TYPE_CLASS_TEXT).apply {
            setText(entry?.term.orEmpty())
            selectAll()
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(if (entry == null) "Add dictionary term" else "Edit dictionary term")
            .setView(LinearLayout(this).apply {
                setPadding(dp(22), dp(6), dp(22), 0)
                addView(field, linear(match = true, height = dp(54)))
            })
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Save") { _, _ ->
                scope.launch {
                    val saved = withContext(Dispatchers.IO) {
                        if (entry == null) repository.addManualTerm(field.text.toString())
                        else repository.renameTerm(entry, field.text.toString())
                    }
                    if (!saved) Snackbar.make(contentHost, "That term is invalid or already exists.", Snackbar.LENGTH_SHORT).show()
                    syncGlossaryCache()
                    refreshDictionary()
                }
            }
            .show()
    }

    private fun acceptSuggestion(entry: DictionaryEntry) {
        scope.launch {
            withContext(Dispatchers.IO) { repository.acceptSuggestion(entry) }
            syncGlossaryCache()
            refreshDictionary()
            Snackbar.make(contentHost, "Added “${entry.term}” to your dictionary.", Snackbar.LENGTH_SHORT).show()
        }
    }

    private fun deleteDictionaryEntry(entry: DictionaryEntry) {
        scope.launch {
            withContext(Dispatchers.IO) { repository.deleteDictionary(entry) }
            syncGlossaryCache()
            refreshDictionary()
        }
    }

    private suspend fun syncGlossaryCache() {
        val values = withContext(Dispatchers.IO) { repository.bestGlossary() }
        store.glossary = values
    }

    private fun showHistoryDetail(record: DictationRecord) {
        val detail = "${record.wordCount} words • ${formatDuration(record.audioDurationMs)} • ${record.asrModel}\n" +
            "Processed in ${formatProcessing(record.totalMs)}${if (record.polished) " • Polished" else ""}"
        MaterialAlertDialogBuilder(this)
            .setTitle(historyDateTime(record))
            .setMessage("${record.finalText}\n\n$detail")
            .setNegativeButton("Delete") { _, _ -> deleteHistoryWithUndo(record) }
            .setNeutralButton("Close", null)
            .setPositiveButton("Copy") { _, _ -> copyRecord(record) }
            .show()
    }

    private fun copyRecord(record: DictationRecord) {
        (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
            .setPrimaryClip(ClipData.newPlainText("WoVoice dictation", record.finalText))
        Snackbar.make(contentHost, "Copied to clipboard.", Snackbar.LENGTH_SHORT).show()
    }

    private fun deleteHistoryWithUndo(record: DictationRecord) {
        scope.launch {
            withContext(Dispatchers.IO) { repository.deleteHistory(record) }
            refreshHistory()
            refreshHome()
            Snackbar.make(contentHost, "Dictation deleted.", Snackbar.LENGTH_LONG)
                .setAction("Undo") {
                    scope.launch {
                        withContext(Dispatchers.IO) { repository.restoreHistory(record) }
                        refreshHistory()
                        refreshHome()
                    }
                }.show()
        }
    }

    private fun confirmClearHistory() = confirm(
        "Clear history?",
        "Generated text will be removed from this phone. Anonymous analytics totals will remain.",
        "Clear",
    ) {
        scope.launch {
            withContext(Dispatchers.IO) { repository.clearHistory() }
            refreshHistory(); refreshHome()
        }
    }

    private fun confirmResetAnalytics() = confirm(
        "Reset analytics?",
        "Dictation totals, timing, WPM, and estimated usage will be removed. History text will remain.",
        "Reset",
    ) {
        scope.launch {
            withContext(Dispatchers.IO) { repository.resetAnalytics() }
            refreshHome()
        }
    }

    private fun confirmClearAll() = confirm(
        "Clear all local data?",
        "This removes history, analytics, dictionary, Worker connection, and the encrypted token.",
        "Clear all",
    ) {
        scope.launch {
            withContext(Dispatchers.IO) {
                repository.clearHistory()
                repository.resetAnalytics()
                repository.clearDictionary()
                store.clearAll()
            }
            screens.clear()
            contentHost.removeAllViews()
            bottomNavigation.selectedItemId = TAB_HOME
            showTab(TAB_HOME, animate = false)
        }
    }

    private fun confirm(title: String, message: String, action: String, block: () -> Unit) {
        MaterialAlertDialogBuilder(this)
            .setTitle(title)
            .setMessage(message)
            .setNegativeButton("Cancel", null)
            .setPositiveButton(action) { _, _ -> block() }
            .show()
    }

    private fun metric(key: String, label: String): MaterialCardView {
        val value = TextView(this).apply {
            styleText(28f)
            typeface = Typeface.create("sans-serif", Typeface.BOLD)
            text = "—"
        }
        val subtitle = TextView(this).apply { styleText(12.5f, MUTED) }
        metricViews[key] = value
        metricViews["$key-subtitle"] = subtitle
        return MaterialCardView(this).apply {
            radius = dp(18).toFloat(); cardElevation = 0f; setCardBackgroundColor(CARD); strokeWidth = dp(1); setStrokeColor(BORDER)
            addView(LinearLayout(this@SetupActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(15), dp(14), dp(12), dp(13))
                addView(TextView(this@SetupActivity).apply {
                    text = label.uppercase(Locale.getDefault()); styleText(11.5f, MUTED)
                    typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                })
                addView(value, linear(match = true, height = dp(42)).apply { topMargin = dp(5) })
                addView(subtitle)
            })
        }
    }

    private fun metricRow(first: View, second: View) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        addView(first, LinearLayout.LayoutParams(0, dp(124), 1f).apply { rightMargin = dp(6) })
        addView(second, LinearLayout.LayoutParams(0, dp(124), 1f).apply { leftMargin = dp(6) })
        layoutParams = linear(match = true, height = dp(136))
    }

    private fun setMetric(key: String, value: String, subtitle: String) {
        metricViews[key]?.let { view ->
            if (store.animationsEnabled && view.text != value) {
                view.animate().cancel(); view.alpha = 0.2f; view.translationY = dp(4).toFloat()
                view.text = value
                view.animate().alpha(1f).translationY(0f).setDuration(180).start()
            } else view.text = value
        }
        metricViews["$key-subtitle"]?.text = subtitle
    }

    private fun hero(title: String, subtitle: String) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        addView(ImageView(this@SetupActivity).apply {
            setImageResource(R.mipmap.ic_launcher); scaleType = ImageView.ScaleType.FIT_CENTER
        }, linear(height = dp(54)).apply { width = dp(54) })
        addView(LinearLayout(this@SetupActivity).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(this@SetupActivity).apply {
                text = title; styleText(25f); typeface = Typeface.create("sans-serif", Typeface.BOLD)
            })
            addView(TextView(this@SetupActivity).apply { text = subtitle; styleText(13.5f, MUTED); maxLines = 2 })
        }, LinearLayout.LayoutParams(0, dp(72), 1f).apply { leftMargin = dp(13) })
    }

    private fun screenHeader(title: String, subtitle: String, action: String, onAction: () -> Unit) = LinearLayout(this).apply {
        gravity = Gravity.CENTER_VERTICAL
        addView(LinearLayout(this@SetupActivity).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(this@SetupActivity).apply {
                text = title; styleText(27f); typeface = Typeface.create("sans-serif", Typeface.BOLD)
            })
            addView(TextView(this@SetupActivity).apply { text = subtitle; styleText(13f, MUTED); maxLines = 2 })
        }, LinearLayout.LayoutParams(0, dp(76), 1f))
        addView(TextView(this@SetupActivity).apply {
            text = action; styleText(14f, ACCENT); gravity = Gravity.CENTER
            background = rounded(ACTION, dp(20).toFloat()); setOnClickListener { onAction() }
        }, linear(height = dp(44)).apply { width = dp(76) })
    }

    private fun sectionHeader(title: String, action: String? = null, onAction: (() -> Unit)? = null) = LinearLayout(this).apply {
        gravity = Gravity.CENTER_VERTICAL
        addView(TextView(this@SetupActivity).apply {
            text = title; styleText(19f); typeface = Typeface.create("sans-serif", Typeface.BOLD); gravity = Gravity.CENTER_VERTICAL
        }, LinearLayout.LayoutParams(0, dp(52), 1f))
        if (action != null) addView(TextView(this@SetupActivity).apply {
            text = action; styleText(14f, ACCENT); gravity = Gravity.CENTER; setOnClickListener { onAction?.invoke() }
        }, linear(height = dp(48)).apply { width = dp(76) })
    }

    private fun card(label: String, content: View) = MaterialCardView(this).apply {
        radius = dp(19).toFloat(); cardElevation = 0f; setCardBackgroundColor(CARD); strokeWidth = dp(1); setStrokeColor(BORDER)
        layoutParams = linear(match = true).apply { bottomMargin = dp(12) }
        addView(LinearLayout(this@SetupActivity).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(17), dp(15), dp(17), dp(16))
            addView(TextView(this@SetupActivity).apply {
                text = label; styleText(11.5f, MUTED); typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                setPadding(0, 0, 0, dp(9))
            })
            addView(content)
        })
    }

    private fun settingsCard(label: String, children: List<View>) = MaterialCardView(this).apply {
        radius = dp(19).toFloat(); cardElevation = 0f; setCardBackgroundColor(CARD); strokeWidth = dp(1); setStrokeColor(BORDER)
        layoutParams = linear(match = true).apply { topMargin = dp(12) }
        addView(LinearLayout(this@SetupActivity).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(16), dp(14), dp(16), dp(14))
            addView(TextView(this@SetupActivity).apply {
                text = label; styleText(11.5f, MUTED); typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                setPadding(0, 0, 0, dp(8))
            })
            children.forEachIndexed { index, child ->
                if (index > 0 && child.layoutParams == null) child.layoutParams = linear(match = true).apply { topMargin = dp(6) }
                addView(child)
            }
        })
    }

    private fun settingBlock(title: String, status: TextView, action: String, onAction: () -> Unit) = LinearLayout(this).apply {
        gravity = Gravity.CENTER_VERTICAL
        addView(LinearLayout(this@SetupActivity).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(this@SetupActivity).apply { text = title; styleText(15f) })
            addView(status)
        }, LinearLayout.LayoutParams(0, dp(62), 1f))
        addView(smallAction(action, onAction), linear(height = dp(40)).apply { width = dp(76) })
    }

    private fun settingAction(title: String, summary: String, action: String, onAction: () -> Unit) = LinearLayout(this).apply {
        gravity = Gravity.CENTER_VERTICAL
        addView(LinearLayout(this@SetupActivity).apply {
            orientation = LinearLayout.VERTICAL
            addView(TextView(this@SetupActivity).apply { text = title; styleText(15f) })
            addView(TextView(this@SetupActivity).apply { text = summary; styleText(12.5f, MUTED) })
        }, LinearLayout.LayoutParams(0, dp(62), 1f))
        addView(smallAction(action, onAction), linear(height = dp(40)).apply { width = dp(76) })
    }

    private fun fixedSetting(title: String, value: String) = LinearLayout(this).apply {
        gravity = Gravity.CENTER_VERTICAL
        addView(TextView(this@SetupActivity).apply { text = title; styleText(15f) }, LinearLayout.LayoutParams(0, dp(54), 1f).apply { gravity = Gravity.CENTER_VERTICAL })
        addView(TextView(this@SetupActivity).apply { text = value; styleText(13f, MUTED); gravity = Gravity.CENTER_VERTICAL or Gravity.END }, linear(height = dp(54)).apply { width = dp(160) })
    }

    private fun settingSwitch(title: String, summary: String, checked: Boolean, onChanged: (Boolean) -> Unit) = SwitchMaterial(this).apply {
        text = "$title\n$summary"
        textSize = 14.5f; setTextColor(Color.WHITE); isChecked = checked
        minHeight = dp(66); gravity = Gravity.CENTER_VERTICAL
        setOnCheckedChangeListener { _, value -> onChanged(value) }
    }

    private fun destructiveAction(title: String, summary: String, onAction: () -> Unit) = settingAction(title, summary, "Remove", onAction).apply {
        (getChildAt(1) as? TextView)?.setTextColor(ERROR)
    }

    private fun smallAction(label: String, action: () -> Unit) = TextView(this).apply {
        text = label; styleText(13.5f, ACCENT); gravity = Gravity.CENTER
        background = rounded(ACTION, dp(18).toFloat()); setOnClickListener { action() }
    }

    private fun segmented(labels: List<String>, selected: Int, onSelected: (Int) -> Unit) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL; setPadding(dp(3), dp(3), dp(3), dp(3)); background = rounded(SEGMENT, dp(16).toFloat())
        labels.forEachIndexed { index, label ->
            addView(TextView(this@SetupActivity).apply {
                text = label; gravity = Gravity.CENTER; styleText(if (labels.size > 3) 12.5f else 14f)
                setOnClickListener { onSelected(index) }
            }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        }
        post { styleSegmented(this, selected) }
    }

    private fun styleSegmented(container: LinearLayout, selected: Int) {
        repeat(container.childCount) { index ->
            (container.getChildAt(index) as TextView).apply {
                background = rounded(if (index == selected) SEGMENT_ACTIVE else Color.TRANSPARENT, dp(13).toFloat())
                setTextColor(if (index == selected) Color.WHITE else MUTED)
            }
        }
    }

    private fun recentPreview(record: DictationRecord) = MaterialCardView(this).apply {
        radius = dp(17).toFloat(); cardElevation = 0f; setCardBackgroundColor(CARD); strokeWidth = dp(1); setStrokeColor(BORDER)
        layoutParams = linear(match = true).apply { bottomMargin = dp(9) }
        isClickable = true; setOnClickListener { showHistoryDetail(record) }
        addView(LinearLayout(this@SetupActivity).apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(15), dp(13), dp(15), dp(13))
            addView(TextView(this@SetupActivity).apply { text = record.finalText; styleText(15f); maxLines = 3 })
            addView(TextView(this@SetupActivity).apply {
                text = "${historyDateTime(record)}  •  ${record.wordCount} words"; styleText(12f, MUTED); setPadding(0, dp(6), 0, 0)
            })
        })
    }

    private fun pageColumn() = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(dp(20), dp(15), dp(20), dp(34)); setBackgroundColor(BACKGROUND)
    }

    private fun scroll(content: View) = ScrollView(this).apply {
        isFillViewport = true; setBackgroundColor(BACKGROUND); overScrollMode = View.OVER_SCROLL_NEVER; addView(content)
    }

    private fun searchField(hintText: String) = input(hintText, InputType.TYPE_CLASS_TEXT).apply {
        setSingleLine(true); compoundDrawablePadding = dp(8)
    }

    private fun input(hintText: String, type: Int) = EditText(this).apply {
        hint = hintText; inputType = type; textSize = 15f; setTextColor(Color.WHITE); setHintTextColor(MUTED)
        setPadding(dp(14), dp(10), dp(14), dp(10)); background = rounded(INPUT, dp(14).toFloat()); maxLines = 6
    }

    private fun actionButton(label: String, action: () -> Unit) = Button(this).apply {
        text = label; isAllCaps = false; textSize = 14.5f; setTextColor(Color.WHITE)
        backgroundTintList = ColorStateList.valueOf(Color.rgb(79, 70, 123)); setOnClickListener { action() }
        layoutParams = linear(match = true, height = dp(50)).apply { topMargin = dp(7) }
    }

    private fun statusText() = TextView(this).apply { styleText(12.5f, MUTED); setPadding(0, dp(3), 0, dp(3)) }

    private fun emptyState(message: String, compact: Boolean = false) = TextView(this).apply {
        text = message; styleText(if (compact) 14f else 15f, MUTED); gravity = Gravity.CENTER; setLineSpacing(dp(3).toFloat(), 1.15f)
        setPadding(dp(24), if (compact) dp(24) else dp(70), dp(24), dp(24)); background = if (compact) rounded(CARD, dp(17).toFloat()) else null
    }

    private fun EditText.onTextChanged(action: () -> Unit) = addTextChangedListener(object : TextWatcher {
        override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
        override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = action()
        override fun afterTextChanged(s: Editable?) = Unit
    })

    private fun navigationColors() = ColorStateList(
        arrayOf(intArrayOf(android.R.attr.state_checked), intArrayOf()),
        intArrayOf(ACCENT, MUTED),
    )

    private fun setConnectionStatus(value: String, color: Int) {
        connectionStatus?.text = value; connectionStatus?.setTextColor(color)
    }

    private fun statusLine(ready: Boolean, yes: String, no: String) = if (ready) "✓  $yes" else "○  $no"
    private fun formatDuration(ms: Long): String = when {
        ms < 60_000 -> "${(ms / 1_000.0).roundToInt()} sec"
        else -> "${ms / 60_000}m ${(ms / 1_000) % 60}s"
    }
    private fun formatProcessing(ms: Long): String = if (ms <= 0) "—" else if (ms < 1_000) "${ms} ms" else String.format(Locale.US, "%.1f sec", ms / 1_000.0)
    private fun formatCost(value: Double): String = if (value <= 0.0) "$0.0000" else String.format(Locale.US, "$%.4f", value)
    private fun formatNeurons(value: Double): String = if (value >= 1_000) String.format(Locale.US, "%,.0f", value) else String.format(Locale.US, "%.1f", value)

    private fun historyGroup(record: DictationRecord): String {
        val zone = runCatching { ZoneId.of(record.zoneId) }.getOrDefault(ZoneId.systemDefault())
        val date = Instant.ofEpochMilli(record.createdAtMs).atZone(zone).toLocalDate()
        val today = LocalDate.now()
        return when (date) {
            today -> "Today"
            today.minusDays(1) -> "Yesterday"
            else -> date.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
        }
    }

    private fun historyDateTime(record: DictationRecord): String {
        val zone = runCatching { ZoneId.of(record.zoneId) }.getOrDefault(ZoneId.systemDefault())
        return Instant.ofEpochMilli(record.createdAtMs).atZone(zone)
            .format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT))
    }

    private fun linear(match: Boolean = false, height: Int = ViewGroup.LayoutParams.WRAP_CONTENT) =
        LinearLayout.LayoutParams(if (match) ViewGroup.LayoutParams.MATCH_PARENT else ViewGroup.LayoutParams.WRAP_CONTENT, height)

    private fun frame(match: Boolean = false) = FrameLayout.LayoutParams(
        if (match) ViewGroup.LayoutParams.MATCH_PARENT else ViewGroup.LayoutParams.WRAP_CONTENT,
        if (match) ViewGroup.LayoutParams.MATCH_PARENT else ViewGroup.LayoutParams.WRAP_CONTENT,
    )

    private companion object {
        const val TAB_HOME = 1_101
        const val TAB_HISTORY = 1_102
        const val TAB_DICTIONARY = 1_103
        const val TAB_SETTINGS = 1_104
        const val STATE_TAB = "dashboard_tab"
        const val STATE_PERIOD = "analytics_period"
        val BACKGROUND = Color.rgb(23, 22, 27)
        val NAVIGATION = Color.rgb(29, 28, 34)
        val CARD = Color.rgb(36, 35, 41)
        val INPUT = Color.rgb(47, 46, 54)
        val BORDER = Color.rgb(55, 53, 65)
        val ACTION = Color.rgb(50, 47, 63)
        val SEGMENT = Color.rgb(33, 32, 39)
        val SEGMENT_ACTIVE = Color.rgb(73, 66, 102)
        val ACCENT = Color.rgb(174, 163, 255)
        val MUTED = Color.rgb(177, 175, 187)
        val SUCCESS = Color.rgb(124, 220, 164)
        val ERROR = Color.rgb(255, 145, 153)
    }
}
