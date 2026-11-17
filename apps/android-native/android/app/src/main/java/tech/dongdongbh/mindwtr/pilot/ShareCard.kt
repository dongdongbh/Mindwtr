package tech.dongdongbh.mindwtr.pilot

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import androidx.core.graphics.PathParser
import org.json.JSONObject
import tech.dongdongbh.mindwtr.pilot.core.CoreHost
import java.io.File


private const val SHARE_CARD_PIXELS = 1080
private const val SHARE_CARD_FILE = "mindwtr-share-card.png"


fun CardImage.render(pixels: Int = SHARE_CARD_PIXELS): Bitmap {
    val bitmap = Bitmap.createBitmap(pixels, pixels, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    canvas.scale(pixels / size, pixels / size)
    for (op in ops) {
        canvas.save()
        op.clip?.let { clip -> canvas.clipPath(Path().apply { addRoundRect(RectF(0f, 0f, clip.width, clip.height), clip.radius, clip.radius, Path.Direction.CW) }) }
        canvas.translate(op.dx, op.dy)
        draw(canvas, op.shape)
        canvas.restore()
    }
    return bitmap
}


private fun fillPaint(color: Int) = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }

private fun strokePaint(color: Int, width: Float) = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color; style = Paint.Style.STROKE; strokeWidth = width }

private fun typeface(weight: Int): Typeface = if (Build.VERSION.SDK_INT >= 28) Typeface.create(Typeface.SANS_SERIF, weight, false)
    else if (weight >= 600) Typeface.DEFAULT_BOLD else Typeface.DEFAULT


private fun draw(canvas: Canvas, shape: CardShape) {
    when (shape) {
        is CardShape.Box -> {
            val bounds = RectF(shape.x, shape.y, shape.x + shape.width, shape.y + shape.height)
            val paint = when (val fill = shape.fill ?: return) {
                is CardFill.Solid -> fillPaint(fill.argb)
                is CardFill.Diagonal -> Paint(Paint.ANTI_ALIAS_FLAG).apply {
                    shader = LinearGradient(bounds.left, bounds.top, bounds.right, bounds.bottom, fill.stops.map { it.second }.toIntArray(),
                        fill.stops.map { it.first }.toFloatArray(), Shader.TileMode.CLAMP)
                }
            }
            canvas.drawRoundRect(bounds, shape.radius, shape.radius, paint)
        }
        is CardShape.Ring -> {
            shape.fill?.let { canvas.drawCircle(shape.cx, shape.cy, shape.r, fillPaint(it)) }
            shape.stroke?.let { canvas.drawCircle(shape.cx, shape.cy, shape.r, strokePaint(it, shape.strokeWidth)) }
        }
        is CardShape.Outline -> {
            val path = PathParser.createPathFromPathData(shape.d)
            shape.fill?.let { canvas.drawPath(path, fillPaint(it)) }
            shape.stroke?.let { canvas.drawPath(path, strokePaint(it, shape.strokeWidth)) }
        }
        is CardShape.Picture -> {
            val bytes = Base64.decode(shape.pngBase64, Base64.DEFAULT)
            val picture = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return
            canvas.drawBitmap(picture, null, RectF(shape.x, shape.y, shape.x + shape.width, shape.y + shape.height), Paint(Paint.FILTER_BITMAP_FLAG))
        }
        is CardShape.Line -> canvas.drawText(shape.text, shape.x, shape.y, fillPaint(shape.color).apply {
            textSize = shape.size
            typeface = typeface(shape.weight)
            textAlign = when (shape.anchor) { "end" -> Paint.Align.RIGHT; "middle" -> Paint.Align.CENTER; else -> Paint.Align.LEFT }
        })
    }
}


class ShareCardState {
    var card by mutableStateOf<JSONObject?>(null); internal set
    var preview by mutableStateOf<ImageBitmap?>(null); private set
    var style by mutableStateOf("reflection")
    var reflection by mutableStateOf("")
    var pending by mutableStateOf(false)
    var message by mutableStateOf<String?>(null)
    internal var bitmap: Bitmap? = null
    private var asked = 0

    internal fun read(model: InboxViewModel) {
        val input = JSONObject().put("style", style).put("reflection", reflection).apply { card?.let { put("reviewDate", it.getString("reviewDate")) } }
        val mine = ++asked
        model.background(emptyList(), { runtime ->
            val reply = runtime.menuRead("shareCard", input.toString())
            reply to ShareCardSvg.parse(reply.getString("svg")).render()
        }) { (reply, rendered), _ ->
            if (mine != asked) return@background
            card = reply
            bitmap = rendered
            preview = rendered.asImageBitmap()
        }
    }

    val shown: Boolean get() = card?.let { it.getString("style") == style && it.getString("reflection") == reflection } == true

    fun readWanted(busy: Boolean, failed: Boolean): Boolean = !busy && !failed && !shown

    fun limit(text: String): String {
        val most = card?.optInt("limit") ?: return text
        return if (text.codePointCount(0, text.length) <= most) text else text.substring(0, text.offsetByCodePoints(0, most))
    }

    fun share(activity: Activity) {
        val image = bitmap ?: return
        val labels = card?.getJSONObject("labels") ?: return
        if (pending || !shown) return
        pending = true
        message = null
        val main = Handler(Looper.getMainLooper())
        Thread({
            val written = runCatching {
                File(activity.cacheDir, "exports").apply { mkdirs() }.resolve(SHARE_CARD_FILE).also { file -> file.outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) } }
            }
            main.post {
                pending = false
                written.onFailure { Log.w(CoreHost.TAG, "Share card image not written ${failureForLog(it)}"); message = labels.getString("error") }.onSuccess { file ->
                    try {
                        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.diagnostics", file)
                        val send = Intent(Intent.ACTION_SEND).setType("image/png").putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        send.clipData = ClipData.newRawUri(null, uri)
                        activity.startActivity(Intent.createChooser(send, labels.getString("title")))
                    } catch (failure: ActivityNotFoundException) {
                        message = labels.getString("unavailable")
                    }
                }
            }
        }, "mindwtr-share-card").start()
    }
}


@Composable
fun ShareCardSheet(model: InboxViewModel, state: ShareCardState, close: () -> Unit) {
    val theme = LocalTheme.current
    val c = theme.colors
    val hairline = (1f / LocalDensity.current.density).dp
    val screenHeight = LocalConfiguration.current.screenHeightDp.dp
    LaunchedEffect(state.style, state.reflection, model.busy, model.failedAction) {
        if (state.readWanted(model.busy, model.failedAction != null)) state.read(model)
    }
    BackHandler { if (!state.pending) close() }
    val card = state.card
    val labels = card?.getJSONObject("labels")
    val activity = LocalActivity.current
    Column(Modifier.fillMaxSize().background(c.bg).imePadding().testTag("share-card")) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).rnBorderBottom(c.border).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(labels?.getString("title").orEmpty(), style = rnText(20, 700), color = c.text, modifier = Modifier.weight(1f).semantics { heading() })
            val closeLabel = labels?.getString("close") ?: t("common.close")
            Box(Modifier.offset(x = 8.dp).size(44.dp).fade(if (state.pending) 0.48f else 1f).clickable(enabled = !state.pending, role = Role.Button, onClick = close)
                .semantics { contentDescription = closeLabel }.testTag("share-card-close"), contentAlignment = Alignment.Center) {
                Icon(Lucide.X, null, tint = c.text, modifier = Modifier.size(22.dp))
            }
        }
        BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val previewSize = maxOf(180.dp, minOf((maxWidth - 40.dp) * 0.87f, screenHeight * 0.4f, 400.dp))
            Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 20.dp, bottom = 28.dp),
                horizontalAlignment = Alignment.CenterHorizontally) {
                val shape = RoundedCornerShape(14.dp)
                Box(Modifier.size(previewSize).clip(shape).rnBorder(hairline, c.border, shape)
                    .clearAndSetSemantics { contentDescription = labels?.getString("preview").orEmpty(); testTag = "share-card-preview" }) {
                    state.preview?.let { Image(it, null, Modifier.fillMaxSize()) }
                }
                if (card != null && labels != null) {
                    val field = Modifier.fillMaxWidth().widthIn(max = 520.dp)
                    Text(labels.getString("privacy"), style = rnText(14, 400, 20), color = c.secondaryText, modifier = field.padding(top = 14.dp, bottom = 20.dp))
                    Column(field.padding(bottom = 20.dp)) {
                        Text(labels.getString("styleLabel"), style = rnText(15, 600, 21), color = c.text, modifier = Modifier.padding(bottom = 8.dp))
                        val outer = RoundedCornerShape(12.dp)
                        Row(Modifier.fillMaxWidth().heightIn(min = 50.dp).rnBorder(hairline, c.border, outer).padding(3.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                            for (option in card.menuObjects("styles")) {
                                val id = option.getString("id")
                                val selected = state.style == id
                                Box(Modifier.weight(1f).fade(if (state.pending) 0.48f else 1f).heightIn(min = 44.dp).clip(RoundedCornerShape(9.dp)).background(if (selected) c.tint else c.cardBg)
                                    .selectable(selected, enabled = !state.pending, role = Role.RadioButton) { state.style = id }
                                    .padding(horizontal = 8.dp).testTag("share-card-style-$id"), contentAlignment = Alignment.Center) {
                                    Text(option.getString("label"), style = rnText(14, 600, 18), color = if (selected) c.onTint else c.text, textAlign = TextAlign.Center)
                                }
                            }
                        }
                    }
                    Column(field) {
                        val count = state.reflection.codePointCount(0, state.reflection.length)
                        val most = card.getInt("limit")
                        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text(labels.getString("reflectionLabel"), style = rnText(15, 600, 21), color = c.text, modifier = Modifier.weight(1f))
                            Text("$count/$most", style = rnText(12, 400, 18), color = c.secondaryText, modifier = Modifier.clearAndSetSemantics { contentDescription = "$count / $most" })
                        }
                        val inputShape = RoundedCornerShape(14.dp)
                        val placeholder = labels.getString("reflectionPlaceholder")
                        BasicTextField(state.reflection, { state.reflection = state.limit(it) }, enabled = !state.pending, textStyle = rnText(16, 400, 22).copy(color = c.text),
                            cursorBrush = SolidColor(c.tint),
                            modifier = Modifier.padding(top = 8.dp).fade(if (state.pending) 0.48f else 1f).fillMaxWidth().heightIn(min = 104.dp).clip(inputShape).background(c.cardBg)
                                .rnBorder(hairline, c.border, inputShape).padding(horizontal = 14.dp, vertical = 12.dp)
                                .semantics { contentDescription = labels.getString("reflectionLabel") }.testTag("share-card-reflection"),
                            decorationBox = { inner -> Box { if (state.reflection.isEmpty()) Text(placeholder, style = rnText(16, 400, 22), color = c.secondaryText); inner() } })
                        if (state.reflection.isBlank()) Text(labels.getString("defaultHint"), style = rnText(13, 400, 18), color = c.secondaryText, modifier = Modifier.padding(top = 8.dp))
                    }
                    state.message?.let { message ->
                        Text(message, style = rnText(14, 400, 20), color = c.danger, modifier = field.padding(top = 14.dp)
                            .semantics { liveRegion = LiveRegionMode.Assertive }.testTag("share-card-message"))
                    }
                }
            }
        }
        Box(Modifier.fillMaxWidth().rnBorderTop(c.border).padding(horizontal = 20.dp, vertical = 12.dp)) {
            val enabled = !state.pending && state.shown && activity != null
            val label = labels?.getString(if (state.pending) "generating" else "share").orEmpty()
            Row(Modifier.fade(if (enabled) 1f else 0.48f).fillMaxWidth().heightIn(min = 48.dp).clip(RoundedCornerShape(12.dp)).background(theme.filledBg)
                .clickable(enabled = enabled, role = Role.Button) { activity?.let(state::share) }
                .semantics { contentDescription = labels?.getString("share").orEmpty(); role = Role.Button; if (!enabled) disabled() }
                .padding(horizontal = 20.dp).testTag("share-card-export"), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp, Alignment.CenterHorizontally)) {
                if (state.pending) CircularProgressIndicator(Modifier.size(20.dp), color = theme.filledText, strokeWidth = 2.dp)
                Text(label, style = rnText(16, 700), color = theme.filledText)
            }
        }
    }
}
