package tech.dongdongbh.mindwtr.pilot

import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import org.json.JSONObject
import kotlin.math.roundToInt


@Immutable
data class ThemeColors(
    val bg: Color, val cardBg: Color, val taskItemBg: Color, val text: Color, val secondaryText: Color, val icon: Color,
    val border: Color, val tint: Color, val onTint: Color, val tabIconDefault: Color, val tabIconSelected: Color,
    val inputBg: Color, val danger: Color, val success: Color, val warning: Color, val filterBg: Color,
)


private fun rgb(hex: String): Color {
    require(hex.length == 7 && hex[0] == '#') { "Unsupported color $hex" }
    return Color(0xFF000000 or hex.substring(1).toLong(16))
}

private fun rgba(red: Int, green: Int, blue: Int, alpha: Float) = Color(red, green, blue, (alpha * 255).roundToInt())


private fun palette(vararg hex: String): ThemeColors = hex.map(::rgb).let { c ->
    ThemeColors(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11], c[12], c[13], c[14], c[15])
}

private val LIGHT = palette("#F6F7FB", "#FFFFFF", "#F1F5F9", "#0F172A", "#4B5563", "#4B5563", "#E2E8F0", "#2563EB",
    "#FFFFFF", "#4B5563", "#2563EB", "#EEF2F7", "#EF4444", "#10B981", "#F59E0B", "#EEF2F7")
private val DARK = palette("#151718", "#1F2937", "#1F2937", "#ECEDEE", "#9CA3AF", "#9BA1A6", "#374151", "#60A5FA",
    "#0F172A", "#9BA1A6", "#60A5FA", "#374151", "#EF4444", "#10B981", "#F59E0B", "#374151")

private val M3_LIGHT = palette("#F9FAFF", "#EEF1F7", "#E5E9F0", "#1A1C1E", "#43474F", "#43474F", "#73777F", "#1B6EF3",
    "#FFFFFF", "#43474F", "#1B6EF3", "#DFE3EB", "#BA1A1A", "#0F7B3D", "#8C5A00", "#DFE3EB")
private val M3_DARK = palette("#111318", "#1B1E24", "#22252B", "#E3E2E6", "#C3C6CF", "#C3C6CF", "#8D9199", "#AAC7FF",
    "#003063", "#C3C6CF", "#AAC7FF", "#43474E", "#FFB4AB", "#7CDC94", "#F2C16E", "#43474E")

private val PRESETS = mapOf(
    "eink" to palette("#FFFFFF", "#FFFFFF", "#FFFFFF", "#000000", "#000000", "#000000", "#000000", "#000000",
        "#FFFFFF", "#000000", "#000000", "#FFFFFF", "#000000", "#000000", "#000000", "#FFFFFF"),
    "nord" to palette("#2E3440", "#3B4252", "#3B4252", "#ECEFF4", "#D8DEE9", "#D8DEE9", "#4C566A", "#88C0D0",
        "#2E3440", "#D8DEE9", "#88C0D0", "#434C5E", "#BF616A", "#A3BE8C", "#EBCB8B", "#434C5E"),
    "catppuccin-macchiato" to palette("#24273A", "#363A4F", "#363A4F", "#CAD3F5", "#A5ADCB", "#A5ADCB", "#5B6078", "#C6A0F6",
        "#24273A", "#A5ADCB", "#C6A0F6", "#494D64", "#ED8796", "#A6DA95", "#EED49F", "#494D64"),
    "dracula" to palette("#282A36", "#343746", "#343746", "#F8F8F2", "#ADB5CB", "#ADB5CB", "#44475A", "#BD93F9",
        "#282A36", "#ADB5CB", "#BD93F9", "#424450", "#FF5555", "#50FA7B", "#FFB86C", "#424450"),
    "gruvbox-light" to palette("#F2E5BC", "#FBF1C7", "#FBF1C7", "#3C3836", "#665C54", "#7C6F64", "#D5C4A1", "#076678",
        "#FBF1C7", "#7C6F64", "#076678", "#EBDBB2", "#9D0006", "#79740E", "#AD3903", "#EBDBB2"),
    "gruvbox-dark" to palette("#282828", "#32302F", "#32302F", "#EBDBB2", "#BDAE93", "#A89984", "#504945", "#9EB9AE",
        "#282828", "#A89984", "#9EB9AE", "#3C3836", "#FB4934", "#B8BB26", "#FABD2F", "#3C3836"),
    "sepia" to palette("#F4ECD8", "#FAF3E3", "#FAF3E3", "#3B2F2F", "#7A5C3E", "#7A5C3E", "#E2D3B5", "#956735",
        "#FFF6E7", "#7A5C3E", "#956735", "#F0E3C8", "#B44B3B", "#5F7D4A", "#B5813C", "#EFE2C7"),
    "oled" to palette("#000000", "#000000", "#000000", "#E5E7EB", "#9CA3AF", "#9CA3AF", "#1F2937", "#4F9DFF",
        "#000000", "#6B7280", "#4F9DFF", "#0B0B0B", "#F87171", "#34D399", "#FBBF24", "#0B0B0B"),
)


object ThemeChoice {
    class Reply(val mode: String, val preset: String, val material: Boolean, val scheme: String?,
                val statusLight: Map<String, StatusColors>, val statusDark: Map<String, StatusColors>, val priority: Map<String, Color>)


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


@Immutable
data class StatusColors(val bg: Color, val text: Color, val border: Color)


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


private const val THUMB_IMAGE = 250f / 255f


@Immutable
class RnSwitchProps(val trackOff: Color, val trackOn: Color, val thumbOff: Color? = null, val thumbOn: Color? = null)


@Immutable
class MindwtrTheme(val colors: ThemeColors, val isDark: Boolean, val isMaterial: Boolean, private val statuses: Map<String, StatusColors>, private val priorities: Map<String, Color>,
                   private val isEink: Boolean = false) {

    fun identityColorOrNull(hex: String?): Color? = coreColorOrNull(hex)?.let(::einkSafe)

    fun einkSafe(color: Color): Color = if (isEink) Color.Black else color

    fun status(value: String): StatusColors = statuses[value] ?: StatusColors(colors.filterBg, colors.secondaryText, colors.border)

    fun priority(value: String?): Color? = value?.let(priorities::get)

    val rowRadius = if (isMaterial) 16.dp else 14.dp
    val captureRadius = if (isMaterial) 16.dp else 10.dp

    val star = einkSafe(rgb("#F59E0B"))
    val attention = rgb("#F59E0B")

    val context = rgb("#3B82F6")
    val tag = rgb("#7C3AED")
    val metaAmber = rgb("#F59E0B")

    val projectWaiting = rgb("#F59E0B")
    val projectSomeday = rgb("#A855F7")

    val onAction = rgb("#FFFFFF")

    val scrim = rgba(0, 0, 0, 0.35f)

    val menuScrim = rgba(0, 0, 0, 0.5f)

    val pickerScrim = rgba(0, 0, 0, 0.45f)

    val divider = rgba(148, 163, 184, 0.2f)


    val filledBg = if (!isMaterial) colors.tint else if (isDark) rgb("#00458B") else rgb("#D7E2FF")
    val filledText = if (!isMaterial) colors.onTint else if (isDark) rgb("#D7E2FF") else rgb("#001B3E")

    val processWash = colors.tint.copy(alpha = 0x29 / 255f)

    val starWash = star.copy(alpha = 0x22 / 255f)
    val dangerWash = colors.danger.copy(alpha = 0x1A / 255f)
    val tintTrack = colors.tint.copy(alpha = 0x55 / 255f)


    val settingsSwitch = RnSwitchProps(rgb("#767577"), rgb("#3B82F6"))

    val generalSwitch = RnSwitchProps(colors.secondaryText, colors.tint)

    val captureSwitch = RnSwitchProps(colors.border, tintTrack, colors.border, colors.tint)

    val referenceSwitch = RnSwitchProps(colors.border, colors.tint)


    fun switchThumb(on: Boolean, enabled: Boolean, systemDark: Boolean): Color = when {
        !enabled -> if (systemDark) rgb("#616161") else rgb("#BDBDBD")
        on -> if (systemDark) rgb("#80CBC4") else rgb("#008577")
        else -> if (systemDark) rgb("#BDBDBD") else rgb("#F1F1F1")
    }


    fun switchThumbShade(color: Color): Color =
        Color(red = color.red * THUMB_IMAGE, green = color.green * THUMB_IMAGE, blue = color.blue * THUMB_IMAGE, alpha = color.alpha)

    val availableBg = if (isDark) rgba(59, 130, 246, 0.08f) else rgba(59, 130, 246, 0.05f)
    val availableBorder = if (isDark) rgba(59, 130, 246, 0.34f) else rgba(59, 130, 246, 0.24f)

    val sheetScrim = rgba(0, 0, 0, 0.36f)
    val overflowScrim = rgba(0, 0, 0, 0.28f)

    val tintWash = colors.tint.copy(alpha = 0x20 / 255f)

    val waitingStat = rgb("#F59E0B")
    val somedayStat = rgb("#8B5CF6")
    val gray = rgb("#6B7280")

    val restoreAction = rgb("#3B82F6")
    val deleteAction = rgb("#EF4444")

    val trashRestore = rgb("#22C55E")

    val chipBadge = if (isDark) rgba(255, 255, 255, 0.12f) else rgba(0, 0, 0, 0.08f)

    val reviewProgress = rgb("#3B82F6")
    val railCurrent = colors.tint.copy(alpha = 0x1A / 255f)
    val railDone = colors.success.copy(alpha = 0x1A / 255f)
    val railDoneBorder = colors.success.copy(alpha = 0x66 / 255f)

    val promptScrim = rgba(0, 0, 0, 0.5f)

    fun tone(value: String?): Color? = when (value) { "success" -> colors.success; "warning" -> colors.warning; "danger" -> colors.danger; else -> null }

    fun wash(color: Color, light: Float, dark: Float): Color = color.copy(alpha = if (isDark) dark else light)


    val manageButton = rgb("#2563EB")
    val swatchBorder = rgba(15, 23, 42, 0.15f)
    val swatchSelected = rgb("#0F172A")
    val settingsScrim = rgba(0, 0, 0, 0.4f)

    val settingsLink = rgb("#3B82F6")

    val exportAction = rgb("#3B82F6")

    val feedbackScrim = rgba(0, 0, 0, 0.42f)

    val analyticsSwitch = RnSwitchProps(rgb("#767577"), rgb("#71717A"), rgb("#F4F4F5"), rgb("#F4F4F5"))

    val feedbackSwitch = RnSwitchProps(colors.border, colors.tint.copy(alpha = 0x66 / 255f), colors.secondaryText, colors.tint)
    val settingsCheck = rgb("#3B82F6")

    val captureSave = rgb("#3B82F6")
    val nowLine = rgb("#EF4444")
    val blockText = rgb("#FFFFFF")
    val composerScrim = rgba(0, 0, 0, 0.55f)

    val alertScrim = rgba(0, 0, 0, 0.58f)

    val announcementScrim = rgba(0, 0, 0, 0.42f)

    val onboardingScrim = rgba(2, 6, 23, 0.68f)

    fun calendarTone(value: String?, source: Color? = null): Color? = when (value) {
        "tint" -> colors.tint; "danger" -> colors.danger; "secondary" -> colors.secondaryText; "text" -> colors.text; "input" -> colors.inputBg
        "source" -> source ?: colors.secondaryText; else -> null
    }

    fun columnTone(value: String): Color = when (value) {
        "tint" -> colors.tint; "warning" -> colors.warning; "secondaryText" -> colors.secondaryText; "success" -> colors.success; else -> colors.text
    }
}


fun Modifier.fade(alpha: Float): Modifier = graphicsLayer { this.alpha = alpha }


internal val ICON_MASK = rgb("#000000")


fun mindwtrTheme(reply: ThemeChoice.Reply?, systemDark: Boolean): MindwtrTheme {
    val dark = reply?.scheme?.let { it == "dark" } ?: systemDark
    val material = reply?.material == true
    val preset = if (reply?.mode == "system-oled" && dark) "oled" else reply?.preset
    val colors = PRESETS[preset] ?: when {
        material -> if (dark) M3_DARK else M3_LIGHT
        else -> if (dark) DARK else LIGHT
    }
    val statuses = reply?.let { if (dark) it.statusDark else it.statusLight }.orEmpty()
    return MindwtrTheme(colors, dark, material, statuses, reply?.priority.orEmpty(), preset == "eink")
}

val LocalTheme = staticCompositionLocalOf { mindwtrTheme(null, false) }


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


fun Modifier.rnBorder(width: Dp, color: Color, shape: Shape): Modifier = border(width, color, shape).padding(width)

fun selectedOptionBorder(selected: Boolean): Dp = if (selected) 2.dp else 1.dp


fun Modifier.rnBorderBottom(color: Color): Modifier = drawBehind {
    drawRect(color, Offset(0f, size.height - 1.dp.toPx()), Size(size.width, 1.dp.toPx()))
}.padding(bottom = 1.dp)


fun Modifier.rnBorderTop(color: Color): Modifier = drawBehind {
    drawRect(color, Offset.Zero, Size(size.width, 1.dp.toPx()))
}.padding(top = 1.dp)


const val COMPACT_TEXT_MAX_SCALE = 1.2f


fun compactFontFactor(fontScale: Float, maxScale: Float = COMPACT_TEXT_MAX_SCALE): Float = if (fontScale <= maxScale) 1f else maxScale / fontScale


@Composable
fun TextStyle.compact(): TextStyle = compact(LocalDensity.current)

fun TextStyle.compact(density: Density): TextStyle {
    val factor = compactFontFactor(density.fontScale)
    val size = if (factor == 1f) fontSize else fontSize * factor
    val line = if (lineHeight.isSp) with(density) { (lineHeight.toDp().value / size.toDp().value).em } else lineHeight

    return copy(fontSize = size, lineHeight = line, lineHeightStyle = LineHeightStyle(LineHeightStyle.Alignment.Center, LineHeightStyle.Trim.None))
}


fun rnText(size: Int, weight: Int, lineHeight: Int? = null, letterSpacing: Float = 0f) = TextStyle(
    fontFamily = FontFamily.Default, fontSize = size.sp, fontWeight = FontWeight(weight),
    lineHeight = lineHeight?.sp ?: TextUnit.Unspecified, letterSpacing = letterSpacing.sp,

    lineHeightStyle = if (lineHeight == null) null else LineHeightStyle(LineHeightStyle.Alignment.Proportional, LineHeightStyle.Trim.None),
    platformStyle = if (lineHeight == null) PlatformTextStyle(includeFontPadding = true) else null,
)
