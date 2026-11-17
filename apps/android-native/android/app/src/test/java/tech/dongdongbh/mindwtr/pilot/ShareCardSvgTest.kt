package tech.dongdongbh.mindwtr.pilot

import org.junit.Assert.assertEquals
import org.junit.Test


class ShareCardSvgTest {
    private val svg = """<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1080" height="1080" viewBox="0 0 1080 1080">""" +
        """<title id="t">Weekly review</title><defs><linearGradient id="reflection-glow" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e0eafa"/>""" +
        """<stop offset="1" stop-color="#edf5f4"/></linearGradient><clipPath id="card-clip"><rect width="1080" height="1080" rx="48"/></clipPath></defs>""" +
        """<g clip-path="url(#card-clip)"><rect width="1080" height="1080" fill="#f7fbfc"/><rect x="56" y="338" width="968" height="430" rx="28" fill="url(#reflection-glow)"/>""" +
        """<circle cx="1030" cy="166" r="440" fill="none" stroke="#235482" stroke-width="70"/><path d="M88 770H992" stroke="#d2e2e3" stroke-width="2"/>""" +
        """<image x="88" y="72" width="72" height="72" xlink:href="data:image/png;base64,iVBORw0KGgo="/>""" +
        """<text x="972" y="445" font-family="Inter, &quot;Segoe UI&quot;, sans-serif" font-size="64" font-weight="500" fill="#14365f" direction="rtl" text-anchor="end">שלום &amp; more</text>""" +
        """<text x="88" y="952" font-size="24" font-weight="400" fill="#4c6a72">mindwtr.app</text>""" +
        """<g transform="translate(836 804)"><title>Get Mindwtr</title><rect width="148" height="148" rx="4" fill="#ffffff"/><path d="M0,0h4v4h-4z" fill="#14365f"/></g>""" +
        """<text x="910" y="984" font-size="18" fill="#4c6a72" text-anchor="middle">Get Mindwtr</text></g></svg>"""

    private val clip = CardClip(1080f, 1080f, 48f)

    @Test
    fun readsEveryShapeCoreDrawsInOrderWithItsClipAndOffset() {
        val card = ShareCardSvg.parse(svg)
        assertEquals(1080f, card.size)
        assertEquals(listOf(
            CardOp(0f, 0f, clip, CardShape.Box(0f, 0f, 1080f, 1080f, 0f, CardFill.Solid(0xFFF7FBFC.toInt()))),
            CardOp(0f, 0f, clip, CardShape.Box(56f, 338f, 968f, 430f, 28f, CardFill.Diagonal(listOf(0f to 0xFFE0EAFA.toInt(), 1f to 0xFFEDF5F4.toInt())))),
            CardOp(0f, 0f, clip, CardShape.Ring(1030f, 166f, 440f, null, 0xFF235482.toInt(), 70f)),
            CardOp(0f, 0f, clip, CardShape.Outline("M88 770H992", 0xFF000000.toInt(), 0xFFD2E2E3.toInt(), 2f)),
            CardOp(0f, 0f, clip, CardShape.Picture(88f, 72f, 72f, 72f, "iVBORw0KGgo=")),
            CardOp(0f, 0f, clip, CardShape.Line(972f, 445f, 64f, 500, 0xFF14365F.toInt(), "end", "שלום & more")),
            CardOp(0f, 0f, clip, CardShape.Line(88f, 952f, 24f, 400, 0xFF4C6A72.toInt(), "start", "mindwtr.app")),
            CardOp(836f, 804f, clip, CardShape.Box(0f, 0f, 148f, 148f, 4f, CardFill.Solid(0xFFFFFFFF.toInt()))),
            CardOp(836f, 804f, clip, CardShape.Outline("M0,0h4v4h-4z", 0xFF14365F.toInt(), null, 1f)),
            CardOp(0f, 0f, clip, CardShape.Line(910f, 984f, 18f, 400, 0xFF4C6A72.toInt(), "middle", "Get Mindwtr")),
        ), card.ops)
    }
}
