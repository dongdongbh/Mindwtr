package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject
import kotlin.math.roundToInt

/*
 * The only colors in this app. The React Native app's theme tokens, ported
 * value for value from apps/mobile: hooks/use-theme-tokens.ts (the generic
 * mapping), constants/theme.ts, constants/theme-presets.ts and
 * constants/material3/m3-color.ts. Core picks the theme and sends its own hues
 * (status and priority) in its reply; Kotlin holds only the mobile palettes.
 */

/** RN's ThemeColors, with the same names. */
@Immutable
data class ThemeColors(
    val bg: Color, val cardBg: Color, val taskItemBg: Color, val text: Color, val secondaryText: Color, val icon: Color,
    val border: Color, val tint: Color, val onTint: Color, val tabIconDefault: Color, val tabIconSelected: Color,
    val inputBg: Color, val danger: Color, val success: Color, val warning: Color, val filterBg: Color,
)

/** Only `#RRGGBB`: an 8-digit value would be read as AARRGGBB here but RRGGBBAA in RN. */
private fun rgb(hex: String): Color {
    require(hex.length == 7 && hex[0] == '#') { "Unsupported color $hex" }
    return Color(0xFF000000 or hex.substring(1).toLong(16))
}

private fun rgba(red: Int, green: Int, blue: Int, alpha: Float) = Color(red, green, blue, (alpha * 255).roundToInt())

/** In ThemeColors order: bg, cardBg, taskItemBg, text, secondaryText, icon, border, tint, onTint, tabIconDefault, tabIconSelected, inputBg, danger, success, warning, filterBg. */
private fun palette(vararg hex: String): ThemeColors = hex.map(::rgb).let { c ->
    ThemeColors(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11], c[12], c[13], c[14], c[15])
}

private val LIGHT = palette("#F6F7FB", "#FFFFFF", "#F1F5F9", "#0F172A", "#4B5563", "#4B5563", "#E2E8F0", "#2563EB",
    "#FFFFFF", "#4B5563", "#2563EB", "#EEF2F7", "#EF4444", "#10B981", "#F59E0B", "#EEF2F7")
private val DARK = palette("#151718", "#1F2937", "#1F2937", "#ECEDEE", "#9CA3AF", "#9BA1A6", "#374151", "#60A5FA",
    "#0F172A", "#9BA1A6", "#60A5FA", "#374151", "#EF4444", "#10B981", "#F59E0B", "#374151")
// Material 3: bg = background, cardBg = surfaceContainer, taskItemBg = surfaceContainerHigh, border = outline, inputBg = surfaceVariant.
private val M3_LIGHT = palette("#F9FAFF", "#EEF1F7", "#E5E9F0", "#1A1C1E", "#43474F", "#43474F", "#73777F", "#1B6EF3",
    "#FFFFFF", "#43474F", "#1B6EF3", "#DFE3EB", "#BA1A1A", "#0F7B3D", "#8C5A00", "#DFE3EB")
private val M3_DARK = palette("#111318", "#1B1E24", "#22252B", "#E3E2E6", "#C3C6CF", "#C3C6CF", "#8D9199", "#AAC7FF",
    "#003063", "#C3C6CF", "#AAC7FF", "#43474E", "#FFB4AB", "#7CDC94", "#F2C16E", "#43474E")
/** RN's THEME_PRESETS, keyed by core's statusPreset. */
private val PRESETS = mapOf(
    "eink" to palette("#FFFFFF", "#FFFFFF", "#FFFFFF", "#000000", "#000000", "#000000", "#000000", "#000000",
        "#FFFFFF", "#000000", "#000000", "#FFFFFF", "#000000", "#000000", "#000000", "#FFFFFF"),
    "nord" to palette("#2E3440", "#3B4252", "#3B4252", "#ECEFF4", "#D8DEE9", "#D8DEE9", "#4C566A", "#88C0D0",
        "#2E3440", "#D8DEE9", "#88C0D0", "#434C5E", "#BF616A", "#A3BE8C", "#EBCB8B", "#434C5E"),
    "catppuccin-macchiato" to palette("#24273A", "#363A4F", "#363A4F", "#CAD3F5", "#A5ADCB", "#A5ADCB", "#5B6078", "#C6A0F6",
        "#24273A", "#A5ADCB", "#C6A0F6", "#494D64", "#ED8796", "#A6DA95", "#EED49F", "#494D64"),
    "dracula" to palette("#282A36", "#343746", "#343746", "#F8F8F2", "#ADB5CB", "#ADB5CB", "#44475A", "#BD93F9",
        "#282A36", "#ADB5CB", "#BD93F9", "#424450", "#FF5555", "#50FA7B", "#FFB86C", "#424450"),
    "sepia" to palette("#F4ECD8", "#FAF3E3", "#FAF3E3", "#3B2F2F", "#7A5C3E", "#7A5C3E", "#E2D3B5", "#956735",
        "#FFF6E7", "#7A5C3E", "#956735", "#F0E3C8", "#B44B3B", "#5F7D4A", "#B5813C", "#EFE2C7"),
    "oled" to palette("#000000", "#000000", "#000000", "#E5E7EB", "#9CA3AF", "#9CA3AF", "#1F2937", "#4F9DFF",
        "#000000", "#6B7280", "#4F9DFF", "#0B0B0B", "#F87171", "#34D399", "#FBBF24", "#0B0B0B"),
)

/** Core's theme reply (host-entry.ts `theme`): the preset, Material 3 or not, a fixed scheme or the system's, and core's hues. */
object ThemeChoice {
    class Reply(val mode: String, val preset: String, val material: Boolean, val scheme: String?,
                val statusLight: Map<String, StatusColors>, val statusDark: Map<String, StatusColors>, val priority: Map<String, Color>)

    /**
     * Set at boot, before any list shows, and again after Settings › General changes the theme (so the app redraws). Null until
     * then, or when the read failed: RN's default look.
     */
    var current by mutableStateOf<Reply?>(null)
        private set

    private fun palette(json: JSONObject): Map<String, StatusColors> = json.keys().asSequence().associateWith { status ->
        json.getJSONObject(status).let { StatusColors(coreColor(it.getString("bg")), coreColor(it.getString("text")), coreColor(it.getString("border"))) }
    }

    fun load(json: JSONObject) {
        val status = json.getJSONObject("status")
        val priority = json.getJSONObject("priority")
        current = Reply(
            json.getString("mode"), json.getString("preset"), json.getBoolean("material"), if (json.isNull("scheme")) null else json.getString("scheme"),
            palette(status.getJSONObject("light")), palette(status.getJSONObject("dark")),
            priority.keys().asSequence().associateWith { rgb(priority.getString(it)) },
        )
    }
}

/** One core status color set (StatusColorSet): the badge background, its text, and its border. */
@Immutable
data class StatusColors(val bg: Color, val text: Color, val border: Color)

/**
 * A color core sends as data (an area's color, a status badge): `#RGB`, `#RRGGBB`, or
 * `#RRGGBBAA` read in RN's order (alpha last). Anything else is null, so the caller
 * falls back to a theme color, as RN's `part.dotColor || tc.tint` does.
 */
fun coreColorOrNull(hex: String?): Color? {
    val digits = hex?.takeIf { it.startsWith("#") }?.substring(1) ?: return null
    if (digits.any { it.digitToIntOrNull(16) == null }) return null
    return when (digits.length) {
        3 -> Color(0xFF000000 or digits.map { "$it$it" }.joinToString("").toLong(16))
        6 -> Color(0xFF000000 or digits.toLong(16))
        8 -> Color((digits.substring(6).toLong(16) shl 24) or digits.substring(0, 6).toLong(16))
        else -> null
    }
}

private fun coreColor(hex: String): Color = requireNotNull(coreColorOrNull(hex)) { "Unsupported color $hex" }

/** SwitchCompat's thumb image, #FAFAFA, as a factor. */
private const val THUMB_IMAGE = 250f / 255f

/** RN's Switch props at one call site: its trackColor, and its thumbColor when it sets one (null: AppCompat's own thumb). */
@Immutable
class RnSwitchProps(val trackOff: Color, val trackOn: Color, val thumbOff: Color? = null, val thumbOn: Color? = null)

/** Everything a screen draws with: RN's tokens for one theme and scheme, plus RN's few fixed colors. */
@Immutable
class MindwtrTheme(val colors: ThemeColors, val isDark: Boolean, val isMaterial: Boolean, private val statuses: Map<String, StatusColors>, private val priorities: Map<String, Color>) {
    /** Core's status colors for a task status (RN's useStatusColors); the plain theme colors if core sent none. */
    fun status(value: String): StatusColors = statuses[value] ?: StatusColors(colors.filterBg, colors.secondaryText, colors.border)
    /** Core's TASK_PRIORITY_COLORS hue for a priority value, or none. */
    fun priority(value: String?): Color? = value?.let(priorities::get)
    /** RN's task row radius (M3 shape.large on Material 3) and capture button radius. */
    val rowRadius = if (isMaterial) 16.dp else 14.dp
    val captureRadius = if (isMaterial) 16.dp else 10.dp
    /** RN's FOCUS_STAR_COLOR, and the amber of its "no next action" warning. */
    val star = rgb("#F59E0B")
    val attention = rgb("#F59E0B")
    /** RN's row meta colors: a context, a tag, and the amber of a project deadline or a date issue. */
    val context = rgb("#3B82F6")
    val tag = rgb("#7C3AED")
    val metaAmber = rgb("#F59E0B")
    /** RN's project status hues (buildProjectStatusPalette): Waiting and Someday; Active is the tint, Closed the secondary text. */
    val projectWaiting = rgb("#F59E0B")
    val projectSomeday = rgb("#A855F7")
    /** RN's swipe action label and icon. */
    val onAction = rgb("#FFFFFF")
    /** RN's sheet backdrop, rgba(0,0,0,0.35). */
    val scrim = rgba(0, 0, 0, 0.35f)
    /** RN's status menu backdrop, rgba(0,0,0,0.5). */
    val menuScrim = rgba(0, 0, 0, 0.5f)
    /** RN's task editor picker backdrop (task-edit-modal.styles overlay), rgba(0,0,0,0.45). */
    val pickerScrim = rgba(0, 0, 0, 0.45f)
    /** RN's token suggestion divider, rgba(148,163,184,0.2). */
    val divider = rgba(148, 163, 184, 0.2f)
    /**
     * RN's filled call-to-action (useFilledButtonColors): Material 3's primaryContainer and onPrimaryContainer
     * (m3-color.ts), else the tint with onTint. Process Inbox's File it and Create project use it.
     */
    val filledBg = if (!isMaterial) colors.tint else if (isDark) rgb("#00458B") else rgb("#D7E2FF")
    val filledText = if (!isMaterial) colors.onTint else if (isDark) rgb("#D7E2FF") else rgb("#001B3E")
    /** RN's Process Inbox button wash, `${tc.tint}29`: the tint at 0x29 alpha. */
    val processWash = colors.tint.copy(alpha = 0x29 / 255f)
    /** RN's capture popup: the focus chip when on (`${FOCUS_STAR_COLOR}22`), a warning preview chip (`${tc.danger}1A`), and the Add another track (`${tc.tint}55`). */
    val starWash = star.copy(alpha = 0x22 / 255f)
    val dangerWash = colors.danger.copy(alpha = 0x1A / 255f)
    val tintTrack = colors.tint.copy(alpha = 0x55 / 255f)
    /*
     * RN's Switch on Android (ReactSwitch over AppCompat 1.7.0's SwitchCompat) at each call site, by the props RN sets there. RN
     * multiplies SwitchCompat's opaque track image by trackColor, so the track is that color, solid (its own alpha kept); a call
     * site without thumbColor gets AppCompat's thumb (switchThumb).
     */
    /** setting-row.tsx's SettingToggleRow default (LEGACY_SWITCH_TRACK_COLOR): GTD's switches and Data's Debug logging. */
    val settingsSwitch = RnSwitchProps(rgb("#767577"), rgb("#3B82F6"))
    /** General's switches (general-settings-screen.tsx): trackColor { false: secondaryText, true: tint }. */
    val generalSwitch = RnSwitchProps(colors.secondaryText, colors.tint)
    /** The capture popup's Add another: trackColor { false: border, true: `${tint}55` }, thumbColor tint on and border off. */
    val captureSwitch = RnSwitchProps(colors.border, tintTrack, colors.border, colors.tint)
    /** Reference's filter sheet (task-list.tsx): trackColor { false: border, true: tint }. */
    val referenceSwitch = RnSwitchProps(colors.border, colors.tint)
    /**
     * AppCompat 1.7.0's own switch thumb, by the system's night mode (RN never sets the app's), not RN's theme:
     * switch_thumb_disabled_material when disabled, colorAccent on, colorSwitchThumbNormal off.
     */
    fun switchThumb(on: Boolean, enabled: Boolean, systemDark: Boolean): Color = when {
        !enabled -> if (systemDark) rgb("#616161") else rgb("#BDBDBD")
        on -> if (systemDark) rgb("#80CBC4") else rgb("#008577")
        else -> if (systemDark) rgb("#BDBDBD") else rgb("#F1F1F1")
    }
    /**
     * A switch thumb as drawn: SwitchCompat's thumb image is #FAFAFA, and RN's thumbColor or AppCompat's tint multiplies it, so
     * every thumb is its color times 250/255 (RN's #F1F1F1 thumb reads #ECECEC on screen).
     */
    fun switchThumbShade(color: Color): Color =
        Color(red = color.red * THUMB_IMAGE, green = color.green * THUMB_IMAGE, blue = color.blue * THUMB_IMAGE, alpha = color.alpha)
    /** RN's highlight of a project's available next action. */
    val availableBg = if (isDark) rgba(59, 130, 246, 0.08f) else rgba(59, 130, 246, 0.05f)
    val availableBorder = if (isDark) rgba(59, 130, 246, 0.34f) else rgba(59, 130, 246, 0.24f)
    /** RN's More sheet backdrop, rgba(0,0,0,0.36), and its list overflow menu's, rgba(0,0,0,0.28). */
    val sheetScrim = rgba(0, 0, 0, 0.36f)
    val overflowScrim = rgba(0, 0, 0, 0.28f)
    /** The overflow menu's selected icon wash, `${tc.tint}20`. */
    val tintWash = colors.tint.copy(alpha = 0x20 / 255f)
    /** RN's fixed stat colors: Waiting's values, Someday's values, and every stat label (also an archived task's indicator). */
    val waitingStat = rgb("#F59E0B")
    val somedayStat = rgb("#8B5CF6")
    val gray = rgb("#6B7280")
    /** RN's Archive swipe actions (Restore, Delete) and the Someday section dialog's Save button. */
    val restoreAction = rgb("#3B82F6")
    val deleteAction = rgb("#EF4444")
    /** RN's Trash swipe Restore (#22c55e). */
    val trashRestore = rgb("#22C55E")
    /** RN's Contexts chip count badge on an unselected chip. */
    val chipBadge = if (isDark) rgba(255, 255, 255, 0.12f) else rgba(0, 0, 0, 0.08f)
    /** The Weekly Review's progress bar and an expanded project's rule (#3B82F6), and its step rail washes (`${tint}1A`, `${success}1A`, `${success}66`). */
    val reviewProgress = rgb("#3B82F6")
    val railCurrent = colors.tint.copy(alpha = 0x1A / 255f)
    val railDone = colors.success.copy(alpha = 0x1A / 255f)
    val railDoneBorder = colors.success.copy(alpha = 0x66 / 255f)
    /** The Weekly Review's Add task prompt backdrop, rgba(0,0,0,0.5). */
    val promptScrim = rgba(0, 0, 0, 0.5f)
    /** RN's review status dot and summary tones (core's ReviewTone). */
    fun tone(value: String?): Color? = when (value) { "success" -> colors.success; "warning" -> colors.warning; "danger" -> colors.danger; else -> null }
    /** RN's calendar washes, `toRgba(color, isDark ? dark : light)`. */
    fun wash(color: Color, light: Float, dark: Float): Color = color.copy(alpha = if (isDark) dark else light)
    /** RN's calendar now line (#EF4444), a task block's title (#FFFFFF; its time at 90%), and the composer's backdrop, rgba(0,0,0,0.55). */
    /** RN's Settings: the Manage editor's and Add buttons (manageEditorButtonPrimary), the color swatches' borders, the pickers' overlay, Auto-archive's check. */
    val manageButton = rgb("#2563EB")
    val swatchBorder = rgba(15, 23, 42, 0.15f)
    val swatchSelected = rgb("#0F172A")
    val settingsScrim = rgba(0, 0, 0, 0.4f)
    /** RN's About link text and its spinner (settings.styles.ts linkText), RN's fixed blue. */
    val settingsLink = rgb("#3B82F6")
    /** RN's feedback modal backdrop (feedbackModalBackdrop), rgba(0,0,0,0.42). */
    val feedbackScrim = rgba(0, 0, 0, 0.42f)
    /** Data's analytics switch (sync-settings-sections.tsx): trackColor { false: #767577, true: #71717A }, thumbColor #F4F4F5. */
    val analyticsSwitch = RnSwitchProps(rgb("#767577"), rgb("#71717A"), rgb("#F4F4F5"), rgb("#F4F4F5"))
    /** The feedback modal's diagnostics switch: trackColor { false: border, true: `${tint}66` }, thumbColor tint on, secondaryText off. */
    val feedbackSwitch = RnSwitchProps(colors.border, colors.tint.copy(alpha = 0x66 / 255f), colors.secondaryText, colors.tint)
    val settingsCheck = rgb("#3B82F6")
    /** RN's capture screen Save (capture-modal.tsx styles.save): the same blue in every theme. */
    val captureSave = rgb("#3B82F6")
    val nowLine = rgb("#EF4444")
    val blockText = rgb("#FFFFFF")
    val composerScrim = rgba(0, 0, 0, 0.55f)
    /** RN's themed alert backdrop (components/themed-alert.tsx), rgba(0,0,0,0.58). */
    val alertScrim = rgba(0, 0, 0, 0.58f)
    /** Core's calendar tone (CalendarTone) as RN paints it; `source` is an event's calendar color; `none` is null. */
    fun calendarTone(value: String?, source: Color? = null): Color? = when (value) {
        "tint" -> colors.tint; "danger" -> colors.danger; "secondary" -> colors.secondaryText; "text" -> colors.text; "input" -> colors.inputBg
        "source" -> source ?: colors.secondaryText; else -> null
    }
    /** Core's Board column tone (BoardColumnTone), one of RN's theme colors by name. */
    fun columnTone(value: String): Color = when (value) {
        "tint" -> colors.tint; "warning" -> colors.warning; "secondaryText" -> colors.secondaryText; "success" -> colors.success; else -> colors.text
    }
}

/**
 * A disabled control's fade. Always a layer, even at full opacity: Modifier.alpha(1f) drops its layer, and on the
 * test phone (runs 31-32) dropping it when Save became enabled left the pills' background and border undrawn.
 */
fun Modifier.fade(alpha: Float): Modifier = graphicsLayer { this.alpha = alpha }

/** Icons.kt draws each glyph once in this color; Icon replaces it with its tint. */
internal val ICON_MASK = rgb("#000000")

/** RN's resolveThemeTokens: a preset wins, then Material 3, then plain light or dark. */
fun mindwtrTheme(reply: ThemeChoice.Reply?, systemDark: Boolean): MindwtrTheme {
    val dark = reply?.scheme?.let { it == "dark" } ?: systemDark
    val material = reply?.material == true
    val preset = if (reply?.mode == "system-oled" && dark) "oled" else reply?.preset
    val colors = PRESETS[preset] ?: when {
        material -> if (dark) M3_DARK else M3_LIGHT
        else -> if (dark) DARK else LIGHT
    }
    val statuses = reply?.let { if (dark) it.statusDark else it.statusLight }.orEmpty()
    return MindwtrTheme(colors, dark, material, statuses, reply?.priority.orEmpty())
}

val LocalTheme = staticCompositionLocalOf { mindwtrTheme(null, false) }

/**
 * RN's tokens for every screen, and as Material colors for the Material parts
 * (text fields, menus, the system-style date picker) so they match too.
 */
@Composable
fun MindwtrTheme(reply: ThemeChoice.Reply?, content: @Composable () -> Unit) {
    val theme = mindwtrTheme(reply, isSystemInDarkTheme())
    val c = theme.colors
    val base = if (theme.isDark) darkColorScheme() else lightColorScheme()
    val scheme = base.copy(
        primary = c.tint, onPrimary = c.onTint, primaryContainer = c.filterBg, onPrimaryContainer = c.text,
        secondaryContainer = c.filterBg, onSecondaryContainer = c.text,
        background = c.bg, onBackground = c.text, surface = c.cardBg, onSurface = c.text,
        surfaceVariant = c.inputBg, onSurfaceVariant = c.secondaryText, outline = c.border, outlineVariant = c.border,
        error = c.danger, surfaceContainerLowest = c.cardBg, surfaceContainerLow = c.cardBg, surfaceContainer = c.cardBg,
        surfaceContainerHigh = c.cardBg, surfaceContainerHighest = c.inputBg,
    )
    CompositionLocalProvider(LocalTheme provides theme) { MaterialTheme(colorScheme = scheme, content = content) }
}

/** RN's type: the platform sans (Fonts.sans is 'normal' on Android), at RN's size, weight, and line height. */
fun rnText(size: Int, weight: Int, lineHeight: Int? = null, letterSpacing: Float = 0f) = TextStyle(
    fontFamily = FontFamily.Default, fontSize = size.sp, fontWeight = FontWeight(weight),
    lineHeight = lineHeight?.sp ?: TextUnit.Unspecified, letterSpacing = letterSpacing.sp,
)
