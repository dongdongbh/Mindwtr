package tech.dongdongbh.mindwtr.pilot

import android.content.Intent
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import android.window.SplashScreenView
import androidx.activity.compose.BackHandler
import androidx.activity.compose.ReportDrawnWhen
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
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
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.snapshotFlow
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
import androidx.core.view.WindowCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import tech.dongdongbh.mindwtr.pilot.core.CalendarPermissionPrompt

/**
 * Isolated development UI, drawn as the React Native app draws it: its header, its bottom
 * tab bar with the center capture button, its theme tokens, and its task row. Task rules
 * and writes stay in the shared core; every label comes from core's getStrings. A
 * FragmentActivity, because AndroidX BiometricPrompt (the app lock's) needs one.
 */
class MainActivity : FragmentActivity() {
    private val model: InboxViewModel by viewModels()
    /** RN's app lock's credential fallback before Android 11: the device's credential screen answers here, on this Activity or the one after a rotation. */
    internal val credential = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        model.lock.answered(if (it.resultCode == RESULT_OK) null else "cancelled")
    }
    /** RN's notification permission prompt at start; the answer reaches core's reminder plan at the resume that follows it. */
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
    /** expo-calendar's prompt for the calendar pair (HostCalendars); its answer is read again as a status by the call that asked. */
    private val calendarPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { CalendarPermissionPrompt.answered() }
    private val askCalendar: (Array<String>) -> Unit = { calendarPermission.launch(it) }

    @OptIn(ExperimentalComposeUiApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        // RN's start screen (expo-splash-screen). The system hands its view over at the first frame; it stays over the screen,
        // which draws beneath it meanwhile (a held first frame would draw everything only once the rows came), until the first
        // screen is ready (InboxViewModel.holdSplash), then goes with no fade, as RN's (SplashScreen.setOptions({ fade: false })).
        // Android 12+'s view is removed directly, as expo-splash-screen does, so the theme's system bar appearance never replaces the screen's.
        val splash = installSplashScreen()
        super.onCreate(savedInstanceState)
        splash.setOnExitAnimationListener { provider ->
            lifecycleScope.launch {
                snapshotFlow { model.holdSplash() }.first { !it }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) (provider.view as SplashScreenView).remove() else provider.remove()
            }
        }
        CalendarPermissionPrompt.launcher = askCalendar
        // A recreated screen registers its own launcher (the prompt's answer reaches it); a finished one answers any prompt left
        // open. It touches only the prompt, never the core host.
        lifecycle.addObserver(LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_DESTROY && CalendarPermissionPrompt.launcher === askCalendar) {
                CalendarPermissionPrompt.launcher = null
                if (isFinishing) CalendarPermissionPrompt.answered()
            }
        })
        model.attach()
        // First content drawn (the root's ReportDrawnWhen, whatever the first screen; InboxList's too): the boot's leftover work,
        // the bytecode cache, may run now.
        fullyDrawnReporter.addOnReportDrawnListener(model::contentShown)
        // A link, share or assistant note that launched the app (a recreated screen already has it: EntryRouter keeps it).
        if (savedInstanceState == null) model.entries.receive(intent)
        setContent {
            // Time to first content (scripts/measure-startup-device.mjs): the first screen's data is drawn, whatever that screen is
            // (Focus on a fresh start, as RN's; a restored last screen).
            ReportDrawnWhen { model.firstContentReady() }
            // Core resolves RN's theme during the boot; until it ends, RN's default follows the system.
            // RN's app lock gate (AppLock.kt) replaces the screens while locked.
            MindwtrTheme(if (model.loading) null else ThemeChoice.current) { AppLockGate(model) { with(model) {
                val theme = LocalTheme.current
                val c = theme.colors
                SideEffect {
                    WindowCompat.getInsetsController(window, window.decorView).apply {
                        isAppearanceLightStatusBars = !theme.isDark
                        isAppearanceLightNavigationBars = !theme.isDark
                    }
                }
                // A waiting entry opens once the app is free (EntryRouter.pump); a system capture that ended puts the app behind the previous one.
                LaunchedEffect(entries.head, entries.blocked) { entries.pump() }
                // RN asks for the notification permission at start while a reminder feature is on (core's answer, once per process).
                LaunchedEffect(loading) {
                    if (!loading && askNotifications()) notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                }
                LaunchedEffect(leaveApp) { if (leaveApp) { leftApp(); moveTaskToBack(true) } }
                val modal = captureModal.open
                val open = editor
                val flow = processing?.takeUnless { it.hidden }
                val searching = search
                val listed = menu.screen
                // Full-screen flows over the tabs, as RN presents them: RN's capture screen (its modal route, over any screen), the
                // editor, then Process Inbox, then search, then a Menu destination (RN pushes it over the tabs).
                if (modal != null && writable) CaptureModalScreen(model, modal)
                else if (open != null && writable) TaskEditorScreen(model, open)
                else if (flow != null && writable) ProcessInboxScreen(model, flow)
                else if (searching != null && writable) SearchScreen(model, searching)
                else if (listed != null && writable) MenuScreenHost(model, listed)
                else Column(
                    Modifier.fillMaxSize().background(c.cardBg).systemBarsPadding().semantics { testTagsAsResourceId = true },
                ) {
                    if (loading) {
                        // The start screen covers the boot; only a start past its cap shows RN's spinner here.
                        if (slowStart) CircularProgressIndicator(Modifier.padding(24.dp))
                    } else if (!writable) {
                        // The boot failed: no command can run, and core's labels may never have loaded.
                        Text(error.orEmpty(), color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("boot-failure").padding(24.dp))
                    } else {
                        // An open project draws its own header, as RN's project screen does. In landscape the
                        // selected tab already names the screen, so the title bar gives its height to the rows.
                        val landscape = LocalConfiguration.current.orientation == Configuration.ORIENTATION_LANDSCAPE
                        // RN's quick-access tab titles its header with the view it holds (Review, Contexts, or Projects).
                        val quick = screen == Screen.Projects && menu.quickView != "projects"
                        if ((screen != Screen.Projects || openProjectId == null || quick) && !landscape) TopBar(model, t(if (screen == Screen.Projects) menu.quickLabel else screen.label))
                        // A failure stays in view above the list. A failed read offers Try again; a failed command only its exact retry.
                        error?.let { message ->
                            FailureBanner(message) {
                                if (failedAction == null) TextButton(onClick = { refresh() }, enabled = !busy, modifier = Modifier.testTag("read-retry")) { Text(t("common.retry")) }
                                else OwedRetry(model)
                            }
                        }
                        Box(Modifier.weight(1f)) {
                            Column(Modifier.fillMaxSize()) {
                                // Three lists in one Activity: tabs, no navigation library. The editor opens over the selected list.
                                Box(Modifier.weight(1f).fillMaxWidth().background(c.bg).clipToBounds()) {
                                    when (screen) {
                                        Screen.Inbox -> InboxList(model, Modifier.fillMaxSize())
                                        Screen.Focus -> FocusList(model, Modifier.fillMaxSize())
                                        Screen.Projects -> if (quick) QuickList(model, Modifier.fillMaxSize()) else ProjectsTab(model, Modifier.fillMaxSize())
                                    }
                                    // RN's More sheet sits over the list, above the tab bar, which stays usable.
                                    if (menu.sheet) MoreSheet(model)
                                }
                                TabBar(model)
                            }
                            // The capture popup shows its own toasts above its keyboard, as RN's sheet does.
                            if (capture == null) ToastCard(model, Modifier.align(Alignment.BottomCenter).padding(bottom = 78.dp))
                            capture?.let { CapturePopup(model, it) }
                            if (areaSheet) AreaSheet(model)
                            // The Inbox's and the quick-access tab's sheets and dialogs (MenuModel), and Focus's (FocusModel), over the tabs.
                            if (quick || screen == Screen.Inbox) MenuDialogs(model)
                            if (screen == Screen.Focus) FocusDialogs(model)
                            StatusMenu(model)
                        }
                    }
                }
                // The attachments' alert, link sheet, image preview and audio player (the editor's and the project card's), over the screen.
                if (writable) AttachmentOverlays(model)
                // The open project's pickers, section manager and help, over the whole screen as RN's modals.
                if (writable && openProjectId != null && projectDetails.projectId == openProjectId) ProjectDetailsDialogs(model)
                // RN's startup prompts (the welcome sheet, the announcement window), over everything, as RN's root modals.
                if (writable) StartupPromptOverlays(model)
            } } }
        }
    }

    /** RN's AppState: "active" while resumed; core's sync triggers run on resume and on leaving. */
    override fun onResume() {
        super.onResume()
        model.appState("active")
    }

    /** RN's AppState "background" on pause; a rotation is no leave (RN's activity handles it without pausing). */
    override fun onPause() {
        super.onPause()
        if (!isChangingConfigurations) model.appState("background")
    }

    /** RN's MainActivity is singleTask: a link, share or note sent while the app runs arrives here. */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        model.entries.receive(intent)
    }
}

/** A 1 px rule, as RN's StyleSheet.hairlineWidth, along the top or bottom edge. */
fun Modifier.hairline(color: Color, top: Boolean) = drawBehind {
    val y = if (top) 0f else size.height - 1f
    drawLine(color, Offset(0f, y), Offset(size.width, y), strokeWidth = 1f)
}

/**
 * RN's tab header: card background, a hairline below, the title centered at 17/700, RN's
 * area switcher at the left, and RN's search button (22, in a 44 box) at the right.
 */
@Composable
private fun TopBar(model: InboxViewModel, title: String) {
    val c = LocalTheme.current.colors
    Box(Modifier.fillMaxWidth().height(56.dp).background(c.cardBg).hairline(c.border, top = false), contentAlignment = Alignment.Center) {
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

/**
 * The failure, pinned above the list. It is drawn above the list (zIndex), so a
 * partly scrolled-out row can never cover it in the accessibility tree; TalkBack
 * hears it at once (live region) and reaches it first (traversal index).
 */
@Composable
fun FailureBanner(message: String, action: @Composable RowScope.() -> Unit) {
    val c = LocalTheme.current.colors
    Row(
        Modifier.fillMaxWidth().zIndex(1f).background(c.cardBg).hairline(c.border, top = false)
            .semantics { isTraversalGroup = true; traversalIndex = -1f }
            .padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp).heightIn(min = 44.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Lucide.TriangleAlert, null, tint = c.danger, modifier = Modifier.size(16.dp))
        Text(message, style = rnText(13, 600), color = c.danger,
            modifier = Modifier.weight(1f).padding(start = 8.dp).semantics { liveRegion = LiveRegionMode.Assertive })
        action()
    }
}

/**
 * Try again for an owed command's exact request (InboxViewModel.retryOwed), in every screen's failure banner:
 * a command started where its control is gone (the status menu on Focus, a closed sheet) stays retryable.
 */
@Composable
fun OwedRetry(model: InboxViewModel) {
    if (model.failedAction != null) TextButton(onClick = model::retryOwed, enabled = !model.busy, modifier = Modifier.testTag("owed-retry")) { Text(t("common.retry")) }
}

/**
 * RN's bottom tab bar: Focus, Inbox, the capture button, the quick-access view
 * (core's quickAccessView: Review, Contexts, the Calendar, or Projects), then Menu, which opens RN's More sheet. Every control keeps the
 * place an RN user's thumb expects; a tab or the capture button closes the sheet, as in RN.
 */
@Composable
private fun TabBar(model: InboxViewModel) {
    val c = LocalTheme.current.colors
    val quick = model.menu.quickView
    Row(Modifier.fillMaxWidth().height(66.dp).background(c.cardBg).hairline(c.border, top = true), verticalAlignment = Alignment.CenterVertically) {
        TabItem(model, Screen.Focus, Lucide.Target)
        TabItem(model, Screen.Inbox, Lucide.Inbox)
        CaptureButton(model)
        TabItem(model, Screen.Projects, when (quick) { "review" -> Lucide.ClipboardCheck; "contexts" -> Lucide.Circle; "calendar" -> Lucide.Calendar; else -> Lucide.Folder }, model.menu.quickLabel)
        MenuTab(model)
    }
}

/** RN's tab: icon 26 when active (24 and 80% opacity when not), label 10 below, tint when active. */
@Composable
private fun RowScope.TabItem(model: InboxViewModel, tab: Screen, icon: ImageVector, label: String = tab.label) = with(model) {
    val c = LocalTheme.current.colors
    val active = screen == tab
    val color = if (active) c.tabIconSelected else c.tabIconDefault
    Column(
        Modifier.weight(1f).fillMaxHeight().selectable(selected = active, role = Role.Tab, onClick = { menu.closeSheet(); show(tab) }),
        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center,
    ) {
        Icon(icon, null, tint = color, modifier = Modifier.size(if (active) 26.dp else 24.dp).fade(if (active) 1f else 0.8f))
        Text(t(label), style = rnText(10, if (active) 700 else 600, 12), color = color, maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
    }
}

/** RN's center capture button: a 48x38 tint tile, lifted above the tab labels. It opens the quick capture sheet. */
@Composable
private fun RowScope.CaptureButton(model: InboxViewModel) {
    val theme = LocalTheme.current
    val shape = RoundedCornerShape(theme.captureRadius)
    val label = t("nav.addTask")
    Box(
        Modifier.weight(1f).fillMaxHeight().clickable(role = Role.Button) { model.menu.closeSheet(); model.openCapture() }
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.offset(y = (-6).dp).size(48.dp, 38.dp).shadow(3.dp, shape).clip(shape).background(theme.colors.tint),
            contentAlignment = Alignment.Center) {
            Icon(Lucide.Plus, null, tint = theme.colors.onTint, modifier = Modifier.size(28.dp))
        }
    }
}

/**
 * RN's pill button: filled with the tint (RN's Save) or outlined (RN's empty-state
 * action, and this app's More). [description] replaces the spoken label when set.
 */
@Composable
fun PillButton(label: String, filled: Boolean = false, onClick: () -> Unit, enabled: Boolean, description: String? = null) {
    val c = LocalTheme.current.colors
    Box(
        Modifier.fade(if (enabled) 1f else 0.5f).widthIn(min = if (filled) 104.dp else 0.dp).heightIn(min = if (filled) 48.dp else 40.dp).clip(CircleShape)
            .then(if (filled) Modifier.background(c.tint) else Modifier.border(1.dp, c.text, CircleShape))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .then(if (description != null) Modifier.semantics { contentDescription = description } else Modifier)
            .padding(horizontal = 16.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, style = rnText(if (filled) 15 else 13, 700), color = if (filled) c.onTint else c.text)
    }
}

/** RN's ListEmptyState: a bordered card with the message, the hint, and one action. */
@Composable
fun EmptyState(message: String, hint: String?, action: String? = null, onAction: () -> Unit = {}) {
    val c = LocalTheme.current.colors
    val shape = RoundedCornerShape(12.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(c.cardBg).border(1.dp, c.border, shape)
            .padding(horizontal = 20.dp, vertical = 36.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(message, style = rnText(15, 600), color = c.text, textAlign = TextAlign.Center,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
        hint?.let { Text(it, style = rnText(13, 400), color = c.secondaryText, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp)) }
        action?.let { Box(Modifier.padding(top = 16.dp)) { PillButton(it, onClick = onAction, enabled = true) } }
    }
}

/**
 * A section title as RN draws it: 12/700 capitals in the secondary text color, then
 * the count. TalkBack and the device checks read core's own title and count.
 */
@Composable
fun SectionTitle(title: String, count: Int?, modifier: Modifier = Modifier, trailing: @Composable () -> Unit = {}) {
    val c = LocalTheme.current.colors
    val spoken = if (count == null) title else "$title · $count"
    Row(modifier.clearAndSetSemantics { text = AnnotatedString(spoken); heading() }, verticalAlignment = Alignment.CenterVertically) {
        Text(title.uppercase(), style = rnText(12, 700, letterSpacing = 1f), color = c.secondaryText, maxLines = 2,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        count?.let { Text("($it)", style = rnText(12, 600), color = c.secondaryText, modifier = Modifier.padding(start = 10.dp)) }
        Spacer(Modifier.weight(1f))
        trailing()
    }
}
