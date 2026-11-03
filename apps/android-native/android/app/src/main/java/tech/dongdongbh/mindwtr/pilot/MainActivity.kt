package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.runtime.getValue
import android.content.Intent
import android.content.IntentSender
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.window.SplashScreenView
import androidx.activity.compose.BackHandler
import androidx.activity.compose.ReportDrawnWhen
import androidx.activity.compose.setContent
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.semantics.text
import androidx.compose.ui.semantics.traversalIndex
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import tech.dongdongbh.mindwtr.pilot.core.CalendarPermissionPrompt
import tech.dongdongbh.mindwtr.pilot.core.MicrophonePermissionPrompt
import tech.dongdongbh.mindwtr.pilot.core.VoiceCapture
import tech.dongdongbh.mindwtr.pilot.core.GmailConsentPrompt


class MainActivity : FragmentActivity() {
    private val model: InboxViewModel by viewModels()

    internal val credential = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        model.lock.answered(if (it.resultCode == RESULT_OK) null else "cancelled")
    }

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    private val calendarPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { CalendarPermissionPrompt.answered() }
    private val askCalendar: (Array<String>) -> Unit = { calendarPermission.launch(it) }
    private val microphonePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { MicrophonePermissionPrompt.answered(it) }
    private val askMicrophone: () -> Unit = { microphonePermission.launch(android.Manifest.permission.RECORD_AUDIO) }

    private val gmailPicker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        GmailConsentPrompt.answered("picker", it.resultCode, it.data)
    }
    private val gmailConsent = registerForActivityResult(ActivityResultContracts.StartIntentSenderForResult()) {
        GmailConsentPrompt.answered("consent", it.resultCode, it.data)
    }
    private val pickGmail: (Intent) -> Unit = { gmailPicker.launch(it) }
    private val consentGmail: (IntentSender) -> Unit = { gmailConsent.launch(IntentSenderRequest.Builder(it).build()) }

    @OptIn(ExperimentalComposeUiApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {


        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        splash.setOnExitAnimationListener { provider ->
            lifecycleScope.launch {
                snapshotFlow { model.holdSplash() }.first { !it }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) (provider.view as SplashScreenView).remove() else provider.remove()
            }
        }
        CalendarPermissionPrompt.launcher = askCalendar
        MicrophonePermissionPrompt.launcher = askMicrophone
        GmailConsentPrompt.picker = pickGmail
        GmailConsentPrompt.consent = consentGmail


        lifecycle.addObserver(LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_DESTROY && CalendarPermissionPrompt.launcher === askCalendar) {
                CalendarPermissionPrompt.launcher = null
                if (isFinishing) CalendarPermissionPrompt.answered()
            }
            if (event == Lifecycle.Event.ON_DESTROY && MicrophonePermissionPrompt.launcher === askMicrophone) {
                MicrophonePermissionPrompt.launcher = null
                if (isFinishing) MicrophonePermissionPrompt.answered(false)
            }

            if (event == Lifecycle.Event.ON_STOP && !isChangingConfigurations) { VoiceCapture.recorder?.leave(); model.voice.left() }
            if (event == Lifecycle.Event.ON_DESTROY && GmailConsentPrompt.picker === pickGmail) {
                GmailConsentPrompt.picker = null
                GmailConsentPrompt.consent = null
            }
        })
        model.attach()


        fullyDrawnReporter.addOnReportDrawnListener(model::contentShown)

        if (savedInstanceState == null) model.entries.receive(intent)
        setContent {

            val banners = remember { FailureBannerSlot<FailureBannerContent>() }


            ReportDrawnWhen { model.firstContentReady() }


            MindwtrTheme(if (model.loading) null else ThemeChoice.current) { AppLockGate(model) { CompositionLocalProvider(LocalFailureBanners provides banners) { with(model) {
                val theme = LocalTheme.current
                val c = theme.colors
                LaunchedEffect(c.bg, theme.isDark) { window.applySystemBars(c.bg.toArgb(), theme.isDark) }

                LaunchedEffect(entries.head, entries.blocked) { entries.pump() }

                LaunchedEffect(loading) {
                    if (!loading && askNotifications()) notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                }
                LaunchedEffect(leaveApp) { if (leaveApp) { leftApp(); moveTaskToBack(true) } }
                val modal = captureModal.open
                val open = editor
                val flow = processing?.takeUnless { it.hidden }
                val searching = search
                val listed = menu.screen


                if (modal != null && writable) CaptureModalScreen(model, modal)
                else if (open != null && writable) Box(Modifier.fillMaxSize()) {
                    TaskEditorScreen(model, open)

                    ToastCard(model, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().imePadding().padding(bottom = 16.dp))
                }
                else if (flow != null && writable) ProcessInboxScreen(model, flow)
                else if (searching != null && writable) SearchScreen(model, searching)
                else if (listed != null && writable) MenuScreenHost(model, listed)
                else Column(

                    Modifier.fillMaxSize().background(c.cardBg).windowInsetsPadding(WindowInsets.systemBars.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                        .semantics { testTagsAsResourceId = true },
                ) {
                    if (loading) {

                        if (slowStart) CircularProgressIndicator(Modifier.padding(24.dp))
                    } else if (!writable) {

                        Text(error.orEmpty(), color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("boot-failure").padding(24.dp))
                    } else {


                        val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE

                        val quick = screen == Screen.Projects && menu.quickView != "projects"
                        if ((screen != Screen.Projects || openProjectId == null || quick) && !landscape) TopBar(model, t(if (screen == Screen.Projects) menu.quickLabel else screen.label))

                        error?.let { message ->
                            FailureBanner(message) {
                                if (failedAction == null) RetryButton({ refresh() }, !busy, "read-retry")
                                else OwedRetry(model)
                            }
                        }
                        Box(Modifier.weight(1f)) {
                            Column(Modifier.fillMaxSize()) {

                                Box(Modifier.weight(1f).fillMaxWidth().background(c.bg).clipToBounds()) {
                                    when (screen) {
                                        Screen.Inbox -> InboxList(model, Modifier.fillMaxSize())
                                        Screen.Focus -> FocusList(model, Modifier.fillMaxSize())
                                        Screen.Projects -> if (quick) QuickList(model, Modifier.fillMaxSize()) else ProjectsTab(model, Modifier.fillMaxSize())
                                    }

                                    if (menu.sheet) MoreSheet(model)
                                }
                                TabBar(model)
                            }

                            Box(Modifier.fillMaxSize().navigationBarsPadding()) {

                                if (capture == null) ToastCard(model, Modifier.align(Alignment.BottomCenter).padding(bottom = 78.dp))
                                capture?.let { CapturePopup(model, it) }
                                if (areaSheet) AreaSheet(model)

                                if (quick || screen == Screen.Inbox) MenuDialogs(model)
                                if (screen == Screen.Focus) FocusDialogs(model)
                                StatusMenu(model)
                            }
                        }
                    }
                }

                FailureBannerHost(banners)

                if (writable && screen == Screen.Focus && modal == null && open == null && flow == null && searching == null && listed == null) PomodoroPicker(model)

                if (writable) AttachmentOverlays(model)

                if (writable && openProjectId != null && projectDetails.projectId == openProjectId) ProjectDetailsDialogs(model)

                if (writable) NextActionPrompt(model)

                if (writable) areaManager?.let { AreaOrderSheet(model, it) }

                if (writable) CompletedAtFlow(model)

                if (writable) StartupPromptOverlays(model)
            } } } }
        }
    }


    override fun onResume() {
        super.onResume()
        model.appState("active")
    }


    override fun onPause() {
        super.onPause()
        if (!isChangingConfigurations) model.appState("background")
    }


    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        model.entries.receive(intent)
    }
}


fun Modifier.hairline(color: Color, top: Boolean) = drawBehind {

    drawRect(color, Offset(0f, if (top) 0f else size.height - 1f), Size(size.width, 1f))
}


fun Modifier.bottomBorder(color: Color) = drawBehind {
    val width = 1.dp.toPx()
    drawRect(color, Offset(0f, size.height - width), Size(size.width, width))
}


@Composable
private fun TopBar(model: InboxViewModel, title: String) {
    val c = LocalTheme.current.colors
    Box(Modifier.fillMaxWidth().height(64.dp).background(c.cardBg).hairline(c.border, top = false), contentAlignment = Alignment.Center) {
        Text(title, style = rnText(17, 700), color = c.text, maxLines = 1, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 72.dp).semantics { heading() })
        AreaTrigger(model, Modifier.align(Alignment.CenterStart).padding(start = 16.dp))
        val label = t("search.title")
        Box(Modifier.align(Alignment.CenterEnd).padding(end = 16.dp).size(44.dp)
            .clickable(enabled = model.failedAction == null, role = Role.Button) { model.openSearch() }
            .semantics { contentDescription = label }, contentAlignment = Alignment.Center) {
            Icon(Lucide.Search, null, tint = c.text, modifier = Modifier.size(22.dp))
        }
    }
}


class FailureBannerSlot<T> {
    private val entries = mutableStateListOf<T>()
    val shown: T? get() = entries.lastOrNull()

    fun put(entry: T): () -> Unit {
        entries.add(entry)
        return { entries.removeAll { it === entry } }
    }
}


class FailureBannerContent(message: String, action: @Composable RowScope.() -> Unit) {
    var message by mutableStateOf(message)
    var action by mutableStateOf(action)
}

val LocalFailureBanners = staticCompositionLocalOf<FailureBannerSlot<FailureBannerContent>?> { null }


@Composable
fun FailureBanner(message: String, action: @Composable RowScope.() -> Unit) {
    val slot = LocalFailureBanners.current ?: return FailureBannerCard(message, action)
    val content = remember { FailureBannerContent(message, action) }
    SideEffect { content.message = message; content.action = action }
    DisposableEffect(slot, content) { val remove = slot.put(content); onDispose(remove) }
}


@Composable
fun FailureBannerHost(slot: FailureBannerSlot<FailureBannerContent>) {
    val shown = slot.shown ?: return
    Box(Modifier.fillMaxWidth().zIndex(100f).windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top))
        .semantics { testTagsAsResourceId = true; isTraversalGroup = true; traversalIndex = -1f }) {
        FailureBannerCard(shown.message, shown.action)
    }
}

@Composable
private fun FailureBannerCard(message: String, action: @Composable RowScope.() -> Unit) {
    val c = LocalTheme.current.colors

    val shape = RoundedCornerShape(12.dp)
    Row(
        Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 8.dp)
            .shadow(8.dp, shape).clip(shape).background(c.cardBg).rnBorder(1.dp, c.danger, shape)
            .padding(horizontal = 12.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Lucide.TriangleAlert, null, tint = c.danger, modifier = Modifier.size(20.dp))
        Text(message, style = rnText(14, 400, 19), color = c.text,
            modifier = Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Assertive })
        action()
    }
}


@Composable
fun RetryButton(onClick: () -> Unit, enabled: Boolean, tag: String? = null) {
    val theme = LocalTheme.current
    val c = theme.colors
    val shape = RoundedCornerShape(8.dp)
    val press = remember { MutableInteractionSource() }
    val pressed by press.collectIsPressedAsState()
    Box(Modifier.fade(if (!enabled) 0.65f else if (pressed) 0.82f else 1f).heightIn(min = 40.dp).clip(shape).background(c.tint)
        .clickable(press, null, enabled = enabled, role = Role.Button, onClick = onClick)
        .then(if (tag != null) Modifier.testTag(tag) else Modifier).padding(horizontal = 12.dp), contentAlignment = Alignment.Center) {
        Text(t("common.retry"), style = rnText(14, 600), color = theme.onAction)
    }
}


@Composable
fun OwedRetry(model: InboxViewModel) {
    if (model.failedAction != null) RetryButton(model::retryOwed, !model.busy, "owed-retry")
}


@Composable
private fun TabBar(model: InboxViewModel) {
    val c = LocalTheme.current.colors
    val quick = model.menu.quickView

    val navigation = with(LocalDensity.current) { WindowInsets.navigationBars.getBottom(this).toDp() }
    val inset = if (navigation >= 20.dp) navigation - 12.dp else 0.dp
    Row(Modifier.fillMaxWidth().height(66.dp + inset).background(c.cardBg).hairline(c.border, top = true).padding(bottom = inset),
        verticalAlignment = Alignment.CenterVertically) {
        TabItem(model, Screen.Focus, Lucide.Target)
        TabItem(model, Screen.Inbox, Lucide.Inbox)
        CaptureButton(model)
        TabItem(model, Screen.Projects, when (quick) { "review" -> Lucide.ClipboardCheck; "contexts" -> Lucide.Circle; "calendar" -> Lucide.Calendar; else -> Lucide.Folder }, model.menu.quickLabel)
        MenuTab(model)
    }
}


@Composable
private fun RowScope.TabItem(model: InboxViewModel, tab: Screen, icon: ImageVector, label: String = tab.label) = with(model) {
    val c = LocalTheme.current.colors
    val active = screen == tab
    val color = if (active) c.tabIconSelected else c.tabIconDefault
    Column(
        Modifier.weight(1f).fillMaxHeight().rnTabPress(active) { menu.closeSheet(); show(tab) },
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, null, tint = color, modifier = Modifier.size(if (active) 26.dp else 24.dp).fade(if (active) 1f else RN_TAB_ICON_IDLE))
        Text(t(label), style = rnText(10, if (active) 700 else 600, 12), color = color, maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
    }
}


@Composable
internal fun Modifier.rnTabPress(selected: Boolean, onClick: () -> Unit): Modifier {
    val press = remember { MutableInteractionSource() }
    val pressed by press.collectIsPressedAsState()
    return offset(y = (-2).dp).fade(if (pressed) 0.2f else 1f).selectable(selected, press, null, role = Role.Tab, onClick = onClick)
}


internal const val RN_TAB_ICON_IDLE = 0.64f


@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun RowScope.CaptureButton(model: InboxViewModel) {
    val theme = LocalTheme.current
    val shape = RoundedCornerShape(theme.captureRadius)

    val label = t(if (model.voice.defaultAudio) "quickAdd.audioCaptureLabel" else "nav.addTask")
    Box(

        Modifier.weight(1f).fillMaxHeight().combinedClickable(role = Role.Button,
            onLongClick = { model.menu.closeSheet(); model.openCapture(AutoRecord.OPPOSITE) }) { model.menu.closeSheet(); model.openCapture(AutoRecord.DEFAULT) }
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.offset(y = (-6).dp).size(48.dp, 38.dp).shadow(3.dp, shape).clip(shape).background(theme.colors.tint),
            contentAlignment = Alignment.Center) {
            Icon(Lucide.Plus, null, tint = theme.colors.onTint, modifier = Modifier.size(28.dp))
        }
    }
}


@Composable
fun PillButton(label: String, filled: Boolean = false, onClick: () -> Unit, enabled: Boolean, description: String? = null) {
    val c = LocalTheme.current.colors
    Box(
        Modifier.fade(if (enabled) 1f else 0.5f).widthIn(min = if (filled) 104.dp else 0.dp).heightIn(min = if (filled) 48.dp else 40.dp).clip(CircleShape)
            .then(if (filled) Modifier.background(c.tint) else Modifier.rnBorder(1.dp, c.text, CircleShape))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .then(if (description != null) Modifier.semantics { contentDescription = description } else Modifier)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = rnText(if (filled) 15 else 13, 700), color = if (filled) c.onTint else c.text)
    }
}


@Composable
fun EmptyState(message: String, hint: String?, action: String? = null, onAction: () -> Unit = {}) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(c.cardBg).rnBorder(1.dp, c.border, shape)
            .padding(horizontal = 20.dp, vertical = 36.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(message, style = rnText(15, 600), color = c.text, textAlign = TextAlign.Center,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        hint?.let { Text(it, style = rnText(13, 400), color = c.secondaryText, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp)) }
        action?.let { Box(Modifier.padding(top = 16.dp)) { PillButton(it, onClick = onAction, enabled = true) } }
    }
}


@Composable
fun SectionTitle(title: String, count: Int?, modifier: Modifier = Modifier, note: String? = null, trailing: @Composable () -> Unit = {}) {
    val c = LocalTheme.current.colors
    val spoken = listOfNotNull(title, note, count?.toString()).joinToString(" · ")
    Row(modifier.clearAndSetSemantics { text = AnnotatedString(spoken); heading() }, verticalAlignment = Alignment.CenterVertically) {
        Text(title.uppercase(), style = rnText(12, 700, letterSpacing = 1f), color = c.secondaryText, maxLines = 2,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))

        note?.let { Text(it, style = rnText(11, 600), color = c.secondaryText, modifier = Modifier.padding(start = 8.dp)) }
        count?.let { Text("($it)", style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.padding(start = 10.dp)) }
        Spacer(Modifier.weight(1f))
        trailing()
    }
}
