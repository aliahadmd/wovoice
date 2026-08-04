package com.aliahad.wovoice.settings

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.KeyguardManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
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
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.recyclerview.widget.ItemTouchHelper
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.aliahad.wovoice.R
import com.aliahad.wovoice.account.AccountResult
import com.aliahad.wovoice.account.DeviceSession
import com.aliahad.wovoice.account.SessionManager
import com.aliahad.wovoice.dashboard.DictionaryAdapter
import com.aliahad.wovoice.dashboard.HistoryAdapter
import com.aliahad.wovoice.dashboard.HistoryRow
import com.aliahad.wovoice.data.AnalyticsPeriod
import com.aliahad.wovoice.data.DashboardMetrics
import com.aliahad.wovoice.data.DictationRecord
import com.aliahad.wovoice.data.DictionaryEntry
import com.aliahad.wovoice.data.WoVoiceRepository
import com.aliahad.wovoice.sync.SyncCoordinator
import com.aliahad.wovoice.sync.SyncResult
import com.aliahad.wovoice.sync.VaultSetupResult
import com.aliahad.wovoice.ui.dp
import com.aliahad.wovoice.ui.rounded
import com.aliahad.wovoice.ui.styleText
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.navigation.NavigationBarView
import com.google.android.material.card.MaterialCardView
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.snackbar.Snackbar
import com.google.android.material.switchmaterial.SwitchMaterial
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeEncoder
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
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
    private lateinit var store: SettingsStore
    private lateinit var account: SessionManager
    private lateinit var sync: SyncCoordinator
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
    private var accountStatus: TextView? = null
    private var accountQuota: TextView? = null
    private var accountButton: Button? = null
    private var pendingRecoveryKey: String? = null

    private val permissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        updateSetupStatus()
        refreshHome()
    }

    private val cameraPermissionLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) { allowed ->
        if (allowed) launchRecoveryScanner()
        else Snackbar.make(contentHost, "Camera permission is needed only to scan a recovery QR code.", Snackbar.LENGTH_LONG).show()
    }

    private val recoveryScanner = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let(::importScannedRecovery)
    }

    private val deviceCredentialLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val key = pendingRecoveryKey
        pendingRecoveryKey = null
        if (result.resultCode == Activity.RESULT_OK && key != null) showRecoveryKeyDialog(key)
        else Snackbar.make(contentHost, "Recovery key remains hidden.", Snackbar.LENGTH_SHORT).show()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = SettingsStore(this)
        account = SessionManager.get(this)
        sync = SyncCoordinator.get(this)
        repository = WoVoiceRepository(this)
        activeTab = savedInstanceState?.getInt(STATE_TAB, TAB_HOME) ?: TAB_HOME
        analyticsPeriod = AnalyticsPeriod.entries.getOrElse(savedInstanceState?.getInt(STATE_PERIOD) ?: 0) {
            AnalyticsPeriod.TODAY
        }
        configureWindow()
        setContentView(buildShell())
        bottomNavigation.selectedItemId = activeTab
        showTab(activeTab, animate = false)
        handleAuthCallback(intent)
        scope.launch(Dispatchers.IO) {
            repository.importGlossary(store.glossary)
            syncGlossaryCache()
        }
    }

    override fun onResume() {
        super.onResume()
        updateSetupStatus()
        if (account.signedIn) refreshAccount()
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
        scope.cancel()
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleAuthCallback(intent)
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
        val online = hasValidatedNetwork()
        val connected = account.signedIn
        readinessText.text = listOf(
            statusLine(mic, "Microphone ready", "Microphone permission needed"),
            statusLine(selected, "WoVoice selected", if (enabled) "Choose WoVoice as keyboard" else "Keyboard not enabled"),
            statusLine(online, "Network available", "Network unavailable — manual keyboard still works"),
            statusLine(connected, "Account verified", "Sign in for voice input"),
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

        accountStatus = statusText()
        accountQuota = statusText()
        accountButton = actionButton(if (account.signedIn) "Manage signed-in devices" else "Sign in or create account") {
            if (account.signedIn) showSessions() else startAccountLogin()
        }
        body.addView(settingsCard("ACCOUNT", listOf(
            accountStatus!!,
            accountQuota!!,
            accountButton!!,
            TextView(this).apply {
                text = "Passwordless sign-in opens wovoice.aliahad.com. Your rotating session credential is protected by Android Keystore."
                styleText(12.5f, MUTED)
                setPadding(dp(2), dp(6), dp(2), dp(4))
            },
            settingAction("Recovery and encrypted sync", "History, dictionary, and analytics are encrypted before upload", "Manage") {
                showRecoveryControls()
            },
            settingAction("Sign out", "Manual keyboard remains available offline", "Sign out") { confirmSignOut() },
            destructiveAction("Delete WoVoice account", "Fresh email verification permanently removes cloud account data") {
                confirmAccountDeletion()
            },
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
                text = "Audio, raw ASR, correction context, and source-app identity are never retained. Synced history, approved dictionary entries, and analytics are end-to-end encrypted before leaving this phone."
                styleText(14f, MUTED)
                setLineSpacing(dp(3).toFloat(), 1.15f)
                setPadding(0, dp(4), 0, dp(10))
            },
            destructiveAction("Clear all local data", "Remove history, analytics, dictionary, connection, and token") { confirmClearAll() },
        )))

        body.addView(settingsCard("ABOUT", listOf(
            fixedSetting("WoVoice", "Version ${packageManager.getPackageInfo(packageName, 0).versionName}"),
            fixedSetting("Service", "wovoice.aliahad.com • Cloudflare Workers AI"),
            fixedSetting("Storage", "Encrypted sync • no backup • no analytics SDK"),
        )))
        return scroll(body)
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
        accountStatus?.text = if (account.signedIn) "✓ ${account.email ?: "Verified WoVoice account"}" else "Sign in to enable cloud speech"
        accountStatus?.setTextColor(if (account.signedIn) SUCCESS else MUTED)
        accountButton?.text = if (account.signedIn) "Manage signed-in devices" else "Sign in or create account"
        accountQuota?.text = account.currentQuota?.let {
            "${it.remainingAudioSeconds.roundToInt()} of ${it.limitAudioSeconds.roundToInt()} voice seconds remaining today"
        } ?: if (account.signedIn) "Checking today’s free quota…" else "10 minutes of voice input per UTC day"
    }

    private fun startAccountLogin(intent: String = SessionManager.AUTH_LOGIN) {
        val request = account.prepareLogin(intent)
        val uri = Uri.parse("${store.workerUrl}/auth").buildUpon()
            .appendQueryParameter("code_challenge", request.challenge)
            .appendQueryParameter("state", request.state)
            .appendQueryParameter("intent", intent)
            .build()
        CustomTabsIntent.Builder()
            .setShowTitle(true)
            .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
            .build()
            .launchUrl(this, uri)
    }

    private fun handleAuthCallback(value: Intent?) {
        val uri = value?.data ?: return
        val expectedHost = Uri.parse(store.workerUrl).host
        if (uri.scheme != "https" || uri.host != expectedHost || uri.path != "/app/callback") return
        value.data = null
        val code = uri.getQueryParameter("code").orEmpty()
        val reauthToken = uri.getQueryParameter("reauth_token").orEmpty()
        val state = uri.getQueryParameter("state").orEmpty()
        if ((code.isBlank() && reauthToken.isBlank()) || state.isBlank() || !account.pendingLoginMatches(state)) {
            Snackbar.make(contentHost, "The sign-in response could not be verified. Please try again.", Snackbar.LENGTH_LONG).show()
            return
        }
        accountStatus?.text = "Completing secure sign-in…"
        accountButton?.isEnabled = false
        val previousAccountId = store.lastAccountId
        scope.launch {
            if (reauthToken.isNotBlank()) {
                completeAccountDeletion(reauthToken, state, previousAccountId)
                return@launch
            }
            val result = withContext(Dispatchers.IO) { account.completeLogin(code, state) }
            accountButton?.isEnabled = true
            when (result) {
                is AccountResult.Success -> {
                    Snackbar.make(contentHost, "Signed in as ${result.value.email}", Snackbar.LENGTH_LONG).show()
                    handleLocalDataAfterLogin(result.value.id, previousAccountId)
                    refreshAccount()
                    refreshHome()
                }
                is AccountResult.Error -> {
                    accountStatus?.text = result.message
                    accountStatus?.setTextColor(ERROR)
                    Snackbar.make(contentHost, result.message, Snackbar.LENGTH_LONG).show()
                }
            }
        }
    }

    private suspend fun completeAccountDeletion(reauthToken: String, state: String, accountId: String?) {
        when (val result = withContext(Dispatchers.IO) { account.completeAccountDeletion(reauthToken, state) }) {
            is AccountResult.Success -> {
                if (accountId != null) withContext(Dispatchers.IO) { repository.deleteAccountLocalData(accountId) }
                Snackbar.make(contentHost, "WoVoice account and its local partition were deleted.", Snackbar.LENGTH_LONG).show()
                updateSetupStatus(); refreshHome(); refreshHistory(); refreshDictionary()
            }
            is AccountResult.Error -> Snackbar.make(contentHost, result.message, Snackbar.LENGTH_LONG).show()
        }
    }

    private fun handleLocalDataAfterLogin(accountId: String, previousAccountId: String?) {
        if (!previousAccountId.isNullOrBlank() && previousAccountId != accountId) {
            MaterialAlertDialogBuilder(this)
                .setTitle("Keep previous account data?")
                .setMessage("Local records from the previous account are isolated and will never sync to this account. Keep them for a later sign-in, or delete them from this phone now.")
                .setNegativeButton("Keep") { _, _ -> promptLegacyData(accountId) }
                .setPositiveButton("Delete") { _, _ ->
                    scope.launch {
                        withContext(Dispatchers.IO) { repository.deleteAccountLocalData(previousAccountId) }
                        promptLegacyData(accountId)
                    }
                }
                .show()
        } else promptLegacyData(accountId)
    }

    private fun promptLegacyData(accountId: String) {
        scope.launch {
            val count = withContext(Dispatchers.IO) { repository.unassignedCount() }
            if (count <= 0) return@launch
            MaterialAlertDialogBuilder(this@SetupActivity)
                .setTitle("Use existing local data?")
                .setMessage("WoVoice found $count local history, analytics, or dictionary items from before accounts were added. Assign them to this verified account for encrypted sync, delete them, or decide later.")
                .setNeutralButton("Later", null)
                .setNegativeButton("Delete") { _, _ ->
                    scope.launch { withContext(Dispatchers.IO) { repository.deleteUnassigned() } }
                }
                .setPositiveButton("Assign") { _, _ ->
                    scope.launch {
                        withContext(Dispatchers.IO) { repository.assignUnassignedTo(accountId) }
                        refreshHome(); refreshHistory(); refreshDictionary()
                    }
                }
                .show()
        }
    }

    private fun refreshAccount() {
        if (!account.signedIn) {
            updateSetupStatus()
            return
        }
        scope.launch {
            when (val result = withContext(Dispatchers.IO) { account.loadProfile() }) {
                is AccountResult.Success -> {
                    updateSetupStatus()
                    runEncryptedSync(showResult = false)
                }
                is AccountResult.Error -> {
                    updateSetupStatus()
                    if (result.code == "AUTH_REQUIRED") {
                        Snackbar.make(contentHost, "Your session ended. Sign in again to use voice input.", Snackbar.LENGTH_LONG).show()
                    } else {
                        accountQuota?.text = result.message
                        accountQuota?.setTextColor(ERROR)
                    }
                }
            }
            refreshHome()
        }
    }

    private fun showSessions() {
        scope.launch {
            when (val result = withContext(Dispatchers.IO) { account.listSessions() }) {
                is AccountResult.Success -> showSessionList(result.value)
                is AccountResult.Error -> Snackbar.make(contentHost, result.message, Snackbar.LENGTH_LONG).show()
            }
        }
    }

    private fun showSessionList(values: List<DeviceSession>) {
        if (values.isEmpty()) {
            Snackbar.make(contentHost, "No active devices were found.", Snackbar.LENGTH_SHORT).show()
            return
        }
        val labels = values.map { session ->
            buildString {
                append(session.deviceName)
                if (session.current) append("  •  This device")
            }
        }.toTypedArray()
        MaterialAlertDialogBuilder(this)
            .setTitle("Signed-in devices")
            .setItems(labels) { _, index -> confirmRevokeSession(values[index]) }
            .setNegativeButton("Close", null)
            .show()
    }

    private fun confirmRevokeSession(session: DeviceSession) = confirm(
        if (session.current) "Sign out this device?" else "Revoke ${session.deviceName}?",
        if (session.current) {
            "Voice input will stop until you sign in again. Local encrypted data is not deleted."
        } else {
            "That device will have to sign in again. Its local encrypted data is not remotely erased."
        },
        if (session.current) "Sign out" else "Revoke",
    ) {
        scope.launch {
            when (val result = withContext(Dispatchers.IO) { account.revokeSession(session.id) }) {
                is AccountResult.Success -> {
                    if (session.current) account.clearLocalSession()
                    updateSetupStatus(); refreshHome()
                    Snackbar.make(contentHost, "Device session revoked.", Snackbar.LENGTH_SHORT).show()
                }
                is AccountResult.Error -> Snackbar.make(contentHost, result.message, Snackbar.LENGTH_LONG).show()
            }
        }
    }

    private fun confirmSignOut() {
        if (!account.signedIn) {
            startAccountLogin()
            return
        }
        confirm(
            "Sign out of WoVoice?",
            "Voice input and encrypted sync will pause. Your local data will remain on this phone.",
            "Sign out",
        ) {
            scope.launch {
                withContext(Dispatchers.IO) { account.logout() }
                updateSetupStatus(); refreshHome()
            }
        }
    }

    private fun confirmAccountDeletion() {
        if (!account.signedIn) {
            Snackbar.make(contentHost, "Sign in before deleting an account.", Snackbar.LENGTH_LONG).show()
            return
        }
        MaterialAlertDialogBuilder(this)
            .setTitle("Permanently delete account?")
            .setMessage("WoVoice will require a fresh email code. Deletion removes all sessions, quota identity, and encrypted cloud records. This phone’s partition will also be removed. This cannot be undone.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Verify and delete") { _, _ -> startAccountLogin(SessionManager.AUTH_DELETE) }
            .show()
    }

    private fun showRecoveryControls() {
        if (!account.signedIn) {
            Snackbar.make(contentHost, "Sign in before setting up encrypted sync.", Snackbar.LENGTH_LONG).show()
            return
        }
        val configured = sync.recoveryKey() != null
        MaterialAlertDialogBuilder(this)
            .setTitle("Encrypted sync recovery")
            .setMessage(
                if (configured) {
                    "This device can unlock your encrypted vault. Reveal the recovery key after confirming your screen lock, or import a key from another device."
                } else {
                    "WoVoice will create a recovery key for your encrypted history, dictionary, and analytics. Cloudflare cannot read these records. Keep it safe: losing every signed-in device and this key makes synchronized data unrecoverable."
                },
            )
            .setNegativeButton("Close", null)
            .setNeutralButton("Import key") { _, _ -> showRecoveryImportOptions() }
            .setPositiveButton(if (configured) "Reveal key" else "Set up") { _, _ -> setupRecoveryVault() }
            .show()
    }

    private fun setupRecoveryVault() {
        scope.launch {
            when (val result = withContext(Dispatchers.IO) { sync.ensureVault() }) {
                VaultSetupResult.Ready -> sync.recoveryKey()?.let(::requestRecoveryReveal)
                    ?: showRecoveryImportOptions()
                is VaultSetupResult.Created -> requestRecoveryReveal(result.recoveryKey)
                VaultSetupResult.NeedsRecovery -> showRecoveryImportOptions()
                is VaultSetupResult.Error -> Snackbar.make(contentHost, result.message, Snackbar.LENGTH_LONG).show()
            }
        }
    }

    private fun requestRecoveryReveal(key: String) {
        val keyguard = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        if (!keyguard.isDeviceSecure) {
            MaterialAlertDialogBuilder(this)
                .setTitle("Screen lock required")
                .setMessage("Set a PIN, pattern, or password before revealing the WoVoice recovery key.")
                .setNegativeButton("Not now", null)
                .setPositiveButton("Open security settings") { _, _ -> startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS)) }
                .show()
            return
        }
        val intent = keyguard.createConfirmDeviceCredentialIntent(
            "Reveal WoVoice recovery key",
            "Confirm your screen lock to display this sensitive key.",
        ) ?: return
        pendingRecoveryKey = key
        deviceCredentialLauncher.launch(intent)
    }

    private fun showRecoveryKeyDialog(key: String) {
        val qrText = "wovoice-recovery://v1?key=${Uri.encode(key)}"
        val qr = runCatching {
            BarcodeEncoder().encodeBitmap(qrText, BarcodeFormat.QR_CODE, dp(240), dp(240))
        }.getOrNull()
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(18), dp(4), dp(18), 0)
            if (qr != null) addView(ImageView(this@SetupActivity).apply {
                setImageBitmap(qr)
                contentDescription = "WoVoice recovery QR code"
                setPadding(dp(6), dp(6), dp(6), dp(6))
                setBackgroundColor(Color.WHITE)
            }, linear(height = dp(252)).apply { width = dp(252) })
            addView(TextView(this@SetupActivity).apply {
                text = key
                styleText(13f)
                setTextIsSelectable(true)
                gravity = Gravity.CENTER
                setPadding(0, dp(14), 0, 0)
            })
        }
        MaterialAlertDialogBuilder(this)
            .setTitle("Save your recovery key")
            .setMessage("Store this key privately. WoVoice and Cloudflare cannot restore encrypted data without it.")
            .setView(content)
            .setNegativeButton("Copy") { _, _ ->
                (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                    .setPrimaryClip(ClipData.newPlainText("WoVoice recovery key", key))
            }
            .setPositiveButton("I saved it") { _, _ ->
                store.vaultRecoveryAcknowledged = true
                runEncryptedSync(showResult = true)
            }
            .show()
    }

    private fun showRecoveryImportOptions() {
        MaterialAlertDialogBuilder(this)
            .setTitle("Import recovery key")
            .setMessage("Scan the QR code from another signed-in device, or enter the checksummed key manually.")
            .setNegativeButton("Cancel", null)
            .setNeutralButton("Enter manually") { _, _ -> showManualRecoveryEntry() }
            .setPositiveButton("Scan QR") { _, _ -> requestRecoveryScan() }
            .show()
    }

    private fun showManualRecoveryEntry() {
        val field = input("WV1-…", InputType.TYPE_CLASS_TEXT).apply {
            isSingleLine = false
            minLines = 2
        }
        MaterialAlertDialogBuilder(this)
            .setTitle("Enter recovery key")
            .setView(LinearLayout(this).apply {
                setPadding(dp(20), dp(6), dp(20), 0)
                addView(field, linear(match = true))
            })
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Import") { _, _ -> importRecovery(field.text.toString()) }
            .show()
    }

    private fun requestRecoveryScan() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            launchRecoveryScanner()
        } else cameraPermissionLauncher.launch(Manifest.permission.CAMERA)
    }

    private fun launchRecoveryScanner() {
        recoveryScanner.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt("Scan a WoVoice recovery QR code")
                .setBeepEnabled(false)
                .setOrientationLocked(false),
        )
    }

    private fun importScannedRecovery(value: String) {
        val key = runCatching { Uri.parse(value) }
            .getOrNull()
            ?.takeIf { it.scheme == "wovoice-recovery" && it.host == "v1" }
            ?.getQueryParameter("key")
            ?: value.takeIf { it.trim().startsWith("WV1", ignoreCase = true) }
        if (key == null) {
            Snackbar.make(contentHost, "That QR code is not a WoVoice recovery key.", Snackbar.LENGTH_LONG).show()
        } else importRecovery(key)
    }

    private fun importRecovery(key: String) {
        scope.launch {
            when (val result = withContext(Dispatchers.IO) { sync.importRecoveryKey(key) }) {
                VaultSetupResult.Ready -> {
                    store.vaultRecoveryAcknowledged = true
                    Snackbar.make(contentHost, "Encrypted vault recovered on this device.", Snackbar.LENGTH_LONG).show()
                    runEncryptedSync(showResult = false)
                }
                is VaultSetupResult.Error -> Snackbar.make(contentHost, result.message, Snackbar.LENGTH_LONG).show()
                else -> Snackbar.make(contentHost, "The encrypted vault could not be recovered.", Snackbar.LENGTH_LONG).show()
            }
        }
    }

    private fun runEncryptedSync(showResult: Boolean) {
        if (!store.vaultRecoveryAcknowledged || !account.signedIn) return
        scope.launch {
            when (val result = withContext(Dispatchers.IO) { sync.syncNow() }) {
                is SyncResult.Success -> if (showResult) {
                    Snackbar.make(
                        contentHost,
                        "Encrypted sync complete: ${result.uploaded} uploaded, ${result.downloaded} downloaded.",
                        Snackbar.LENGTH_LONG,
                    ).show()
                }
                SyncResult.NeedsRecovery -> if (showResult) showRecoveryImportOptions()
                is SyncResult.Error -> if (showResult) Snackbar.make(contentHost, result.message, Snackbar.LENGTH_LONG).show()
            }
            refreshHome(); refreshHistory(); refreshDictionary()
        }
    }

    private fun hasValidatedNetwork(): Boolean {
        val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val network = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
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
                repository.clearEveryAccountLocalData()
                store.clearAll()
            }
            account.clearLocalSession()
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
