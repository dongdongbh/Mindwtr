package tech.dongdongbh.mindwtr.pilot

import org.w3c.dom.Element
import org.w3c.dom.Node
import java.io.ByteArrayInputStream
import javax.xml.parsers.DocumentBuilderFactory


sealed interface CardFill {
    data class Solid(val argb: Int) : CardFill

    data class Diagonal(val stops: List<Pair<Float, Int>>) : CardFill
}


sealed interface CardShape {
    data class Box(val x: Float, val y: Float, val width: Float, val height: Float, val radius: Float, val fill: CardFill?) : CardShape

    data class Ring(val cx: Float, val cy: Float, val r: Float, val fill: Int?, val stroke: Int?, val strokeWidth: Float) : CardShape

    data class Outline(val d: String, val fill: Int?, val stroke: Int?, val strokeWidth: Float) : CardShape

    data class Picture(val x: Float, val y: Float, val width: Float, val height: Float, val pngBase64: String) : CardShape

    data class Line(val x: Float, val y: Float, val size: Float, val weight: Int, val color: Int, val anchor: String, val text: String) : CardShape
}


data class CardClip(val width: Float, val height: Float, val radius: Float)


data class CardOp(val dx: Float, val dy: Float, val clip: CardClip?, val shape: CardShape)


data class CardImage(val size: Float, val ops: List<CardOp>)


object ShareCardSvg {
    private const val BLACK = 0xFF000000.toInt()

    fun parse(svg: String): CardImage {
        val root = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(ByteArrayInputStream(svg.toByteArray())).documentElement
        val gradients = root.all("linearGradient").associate { gradient ->
            gradient.getAttribute("id") to CardFill.Diagonal(gradient.all("stop").map { it.number("offset") to color(it.getAttribute("stop-color"))!! })
        }
        val clips = root.all("clipPath").associate { clip ->
            val rect = clip.all("rect").first()
            clip.getAttribute("id") to CardClip(rect.number("width"), rect.number("height"), rect.number("rx"))
        }
        val ops = mutableListOf<CardOp>()
        fun walk(element: Element, dx: Float, dy: Float, clip: CardClip?) {
            for (child in element.childElements()) {
                when (child.tagName) {
                    "g" -> {
                        val (tx, ty) = translate(child.getAttribute("transform"))
                        walk(child, dx + tx, dy + ty, reference(child.getAttribute("clip-path"))?.let(clips::get) ?: clip)
                    }
                    "rect" -> ops += CardOp(dx, dy, clip, CardShape.Box(child.number("x"), child.number("y"), child.number("width"), child.number("height"),
                        child.number("rx"), reference(child.getAttribute("fill"))?.let(gradients::get) ?: paint(child, "fill", BLACK)?.let { CardFill.Solid(it) }))
                    "circle" -> ops += CardOp(dx, dy, clip, CardShape.Ring(child.number("cx"), child.number("cy"), child.number("r"),
                        paint(child, "fill", BLACK), paint(child, "stroke", null), child.number("stroke-width", 1f)))
                    "path" -> ops += CardOp(dx, dy, clip, CardShape.Outline(child.getAttribute("d"), paint(child, "fill", BLACK), paint(child, "stroke", null),
                        child.number("stroke-width", 1f)))
                    "image" -> ops += CardOp(dx, dy, clip, CardShape.Picture(child.number("x"), child.number("y"), child.number("width"), child.number("height"),
                        child.getAttribute("xlink:href").substringAfter("base64,")))
                    "text" -> ops += CardOp(dx, dy, clip, CardShape.Line(child.number("x"), child.number("y"), child.number("font-size", 16f),
                        child.getAttribute("font-weight").toIntOrNull() ?: 400, paint(child, "fill", BLACK)!!, child.getAttribute("text-anchor").ifEmpty { "start" },
                        child.textContent))
                }
            }
        }
        walk(root, 0f, 0f, null)
        return CardImage(root.number("width"), ops)
    }

    private fun Element.childElements(): List<Element> = List(childNodes.length) { childNodes.item(it) }.filter { it.nodeType == Node.ELEMENT_NODE }.map { it as Element }

    private fun Element.all(tag: String): List<Element> = getElementsByTagName(tag).let { list -> List(list.length) { list.item(it) as Element } }

    private fun Element.number(name: String, fallback: Float = 0f): Float = getAttribute(name).toFloatOrNull() ?: fallback

    private fun reference(value: String): String? = Regex("""^url\(#([^)]+)\)$""").find(value)?.groupValues?.get(1)

    private fun translate(value: String): Pair<Float, Float> = Regex("""translate\(\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*\)""").find(value)
        ?.let { it.groupValues[1].toFloat() to it.groupValues[2].toFloat() } ?: (0f to 0f)

    private fun paint(element: Element, name: String, fallback: Int?): Int? =
        if (!element.hasAttribute(name)) fallback else color(element.getAttribute(name))

    private fun color(value: String): Int? = Regex("^#([0-9a-fA-F]{6})$").find(value)?.let { (0xFF000000 or it.groupValues[1].toLong(16)).toInt() }
}
