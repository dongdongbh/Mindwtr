package tech.dongdongbh.mindwtr.pilot.core

import android.icu.text.DateFormat
import android.icu.text.NumberingSystem
import android.icu.text.SimpleDateFormat
import android.icu.util.Calendar
import android.icu.util.TimeZone
import android.icu.util.ULocale
import org.json.JSONArray
import org.json.JSONObject
import java.text.CharacterIterator
import java.util.Date


class IcuDateTimeFormat {
    private class Format(val format: DateFormat, val resolved: JSONObject)


    private val formats = HashMap<String, Format>()


    fun reply(spec: String, op: String, time: Double): String {
        val format = formats.getOrPut(spec) { create(JSONObject(spec)) }
        return when (op) {
            "resolvedOptions" -> format.resolved.toString()
            "format" -> format.format.format(Date(time.toLong()))
            "formatToParts" -> parts(format.format, time).toString()
            else -> throw IllegalArgumentException("Unknown DateTimeFormat call $op")
        }
    }


    private fun create(spec: JSONObject): Format {
        val locales = spec.getJSONArray("locales").let { list -> List(list.length()) { list.getString(it) } }
        val options = spec.getJSONObject("options")

        if (listOf("weekday", "year", "month", "day", "hour", "minute", "second", "dateStyle", "timeStyle").none(options::has)) {
            for (name in listOf("year", "month", "day")) options.put(name, "numeric")
        }
        val option = { name: String, values: List<String>? ->
            if (!options.has(name)) null else options.getString(name).also {
                if (values != null && it !in values) throw IllegalArgumentException("String option expected but not found")
            }
        }
        option("localeMatcher", listOf("lookup", "best fit"))
        val calendar = option("calendar", null)?.also { require(isTypeItem(it)) { "Invalid calendar option !" } }
        val numberingSystem = option("numberingSystem", null)?.also { require(isTypeItem(it)) { "Invalid numbering system !" } }
        val hour12 = if (options.has("hour12")) options.getBoolean("hour12") else null
        val hourCycle = option("hourCycle", listOf("h11", "h12", "h23", "h24"))


        val (matched, extensions) = match(locales)
        var locale = matched
        val requested = mapOf("ca" to calendar, "nu" to numberingSystem, "hc" to hourCycle.takeIf { hour12 == null })
        val given = mapOf("ca" to (calendar != null), "nu" to (numberingSystem != null), "hc" to (hour12 != null || hourCycle != null))
        val resolved = HashMap<String, String?>()
        val added = HashSet<String>()
        for (key in listOf("ca", "nu", "hc")) {
            var value: String? = extensions[key]?.let { added += key; it.ifEmpty { "true" } }
            if (given.getValue(key) && requested[key] != value) {
                added -= key
                value = requested[key]
            }
            value = value?.let { alias(key, it) }
            resolved[key] = value?.takeIf { validKeyword(key, it, locale) }
        }
        for (key in added) {
            val value = alias(key, extensions.getValue(key))
            if (validKeyword(key, value, locale)) locale = ULocale.Builder().setLocale(locale).setUnicodeLocaleKeyword(key, value).build()
        }
        val calendarName = resolved["ca"] ?: alias("ca", DateFormat.getDateInstance(DateFormat.SHORT, locale).calendar.type)
        val numbering = resolved["nu"] ?: NumberingSystem.getInstance(locale).name
        val timeZone = if (!options.has("timeZone")) Calendar.getInstance(locale).timeZone.id else options.getString("timeZone").let { zone ->
            java.util.TimeZone.getAvailableIDs().firstOrNull { it.lowercase() == zone.lowercase() }
                ?: throw IllegalArgumentException("Invalid timezone name!")
        }
        option("formatMatcher", listOf("basic", "best fit"))
        val narrow = listOf("long", "short", "narrow")
        val digits = listOf("numeric", "2-digit")
        val styles = listOf("full", "long", "medium", "short")
        val weekday = option("weekday", narrow)
        val era = option("era", narrow)
        val year = option("year", digits)
        val month = option("month", digits + narrow)
        val day = option("day", digits)
        val hour = option("hour", digits)
        val minute = option("minute", digits)
        val second = option("second", digits)
        val timeZoneName = option("timeZoneName", listOf("long", "longOffset", "longGeneric", "short", "shortOffset", "shortGeneric"))
        val dateStyle = option("dateStyle", styles)
        val timeStyle = option("timeStyle", styles)
        val cycle = if (hour == null && timeStyle == null) null else {
            val default = defaultHourCycle(locale)
            when (hour12) {
                null -> resolved["hc"] ?: default
                true -> if (default == "h11" || default == "h23") "h11" else "h12"
                false -> if (default == "h11" || default == "h23") "h23" else "h24"
            }
        }

        val resolvedOptions = JSONObject().put("locale", locale.toLanguageTag()).put("numberingSystem", numbering)
            .put("calendar", calendarName).put("timeZone", timeZone)
        if (cycle != null) resolvedOptions.put("hourCycle", cycle).put("hour12", cycle == "h11" || cycle == "h12")
        for ((name, value) in listOf("weekday" to weekday, "era" to era, "year" to year, "month" to month, "day" to day, "hour" to hour,
            "minute" to minute, "second" to second, "timeZoneName" to timeZoneName, "dateStyle" to dateStyle, "timeStyle" to timeStyle)) {
            if (value != null) resolvedOptions.put(name, value)
        }


        val twelve = cycle == "h11" || cycle == "h12"
        val skeleton = if (dateStyle != null || timeStyle != null) {
            val pattern = StringBuilder(stylePattern(locale, dateStyle, timeStyle))
            if (twelve) replaceChars(pattern, "HKk", 'h') else if (cycle != null) replaceChars(pattern, "hHK", 'k')
            if (hour12 != null) replaceChars(pattern, if (hour12) "HKk" else "hHK", if (hour12) 'h' else 'k')
            pattern.toString()
        } else {
            val symbol = { value: String?, symbols: Map<String, String> -> value?.let(symbols::getValue).orEmpty() }
            val names = mapOf("long" to 4, "short" to 3, "narrow" to 5)
            symbol(weekday, names.mapValues { "E".repeat(it.value) }) +
                symbol(era, mapOf("long" to "GGGG", "short" to "GGG", "narrow" to "G5")) +
                symbol(year, mapOf("numeric" to "yyyy", "2-digit" to "yy")) +
                symbol(month, mapOf("numeric" to "M", "2-digit" to "MM") + names.mapValues { "M".repeat(it.value) }) +
                symbol(day, mapOf("numeric" to "d", "2-digit" to "dd")) +
                symbol(hour, if (twelve) mapOf("numeric" to "h", "2-digit" to "hh") else mapOf("numeric" to "k", "2-digit" to "kk")) +
                symbol(minute, mapOf("numeric" to "m", "2-digit" to "mm")) +
                symbol(second, mapOf("numeric" to "s", "2-digit" to "ss")) +
                symbol(timeZoneName, mapOf("long" to "zzzz", "longOffset" to "OOOO", "longGeneric" to "vvvv", "short" to "z",
                    "shortOffset" to "O", "shortGeneric" to "v"))
        }

        val calendarInstance = resolved["ca"]?.let { Calendar.getInstance(ULocale.Builder().setLocale(locale).setUnicodeLocaleKeyword("ca", it).build()) }
        resolved["nu"]?.let { name ->
            requireNotNull(runCatching { NumberingSystem.getInstanceByName(name) }.getOrNull()) { "Invalid numbering system: $name" }
            locale = ULocale.Builder().setLocale(locale).setUnicodeLocaleKeyword("nu", name).build()
        }
        val format = if (calendarInstance != null) DateFormat.getPatternInstance(calendarInstance, skeleton, locale)
            else DateFormat.getPatternInstance(skeleton, locale)
        format.timeZone = TimeZone.getTimeZone(timeZone)
        return Format(format, resolvedOptions)
    }


    private fun match(locales: List<String>): Pair<ULocale, Map<String, String>> {
        for (tag in locales) {
            val requested = ULocale.Builder().setLanguageTag(tag).build()
            val fallback = BooleanArray(1)
            val found = ULocale.acceptLanguage(arrayOf(ULocale.Builder().setLocale(requested).clearExtensions().build()),
                ULocale.getAvailableLocales(), fallback)
            if (found != null && !fallback[0]) {

                val extensions = HashMap<String, String>()
                requested.keywords?.forEach { key -> extensions[ULocale.toUnicodeLocaleKey(key) ?: key] = requested.getKeywordValue(key) }
                return found to extensions
            }
        }
        return ULocale.getDefault(ULocale.Category.FORMAT) to emptyMap()
    }


    private fun alias(key: String, value: String) = when {
        key == "ca" && value == "gregorian" -> "gregory"
        key == "nu" && value == "traditional" -> "traditio"
        else -> value
    }


    private fun validKeyword(key: String, value: String, locale: ULocale): Boolean {
        val values = when (key) {
            "ca" -> Calendar.getKeywordValuesForLocale("ca", locale, false)
            "nu" -> NumberingSystem.getAvailableNames()
            else -> emptyArray()
        }
        return values.isEmpty() || value in values
    }


    private fun isTypeItem(value: String) = value.length in 3..8 && value.all { it in 'a'..'z' || it in 'A'..'Z' || it in '0'..'9' }


    private fun defaultHourCycle(locale: ULocale): String {
        val pattern = (DateFormat.getTimeInstance(DateFormat.FULL, locale) as? SimpleDateFormat)?.toPattern() ?: return "h24"
        val letters = pattern.split('\'').filterIndexed { index, _ -> index % 2 == 0 }.joinToString("")
        return when {
            'h' in letters -> "h12"
            'K' in letters -> "h11"
            'H' in letters -> "h23"
            else -> "h24"
        }
    }

    private fun stylePattern(locale: ULocale, dateStyle: String?, timeStyle: String?): String {
        val style = { name: String -> when (name) { "full" -> DateFormat.FULL; "long" -> DateFormat.LONG; "medium" -> DateFormat.MEDIUM; else -> DateFormat.SHORT } }
        val format = when {
            dateStyle == null -> DateFormat.getTimeInstance(style(timeStyle!!), locale)
            timeStyle == null -> DateFormat.getDateInstance(style(dateStyle), locale)
            else -> DateFormat.getDateTimeInstance(style(dateStyle), style(timeStyle), locale)
        }
        return (format as SimpleDateFormat).toLocalizedPattern()
    }

    private fun replaceChars(pattern: StringBuilder, from: String, to: Char) {
        for (index in pattern.indices) if (pattern[index] in from) pattern.setCharAt(index, to)
    }


    private fun parts(format: DateFormat, time: Double): JSONArray {
        val out = JSONArray()
        val iterator = format.formatToCharacterIterator(time)
        val text = StringBuilder()
        var ch = iterator.first()
        while (ch != CharacterIterator.DONE) {
            text.append(ch)
            if (iterator.index + 1 == iterator.runLimit) {
                val value = text.toString()
                val field = iterator.attributes.keys.firstOrNull()
                out.put(JSONObject().put("type", if (field == null) "literal" else fieldType(field, value)).put("value", value))
                text.setLength(0)
            }
            ch = iterator.next()
        }
        return out
    }

    private fun fieldType(field: Any, value: String): String = when (field) {
        DateFormat.Field.DAY_OF_WEEK -> "weekday"
        DateFormat.Field.ERA -> "era"
        DateFormat.Field.YEAR -> if (runCatching { java.lang.Double.parseDouble(value) }.isSuccess) "year" else "yearName"
        DateFormat.Field.MONTH -> "month"
        DateFormat.Field.DAY_OF_MONTH -> "day"
        DateFormat.Field.HOUR0, DateFormat.Field.HOUR1, DateFormat.Field.HOUR_OF_DAY0, DateFormat.Field.HOUR_OF_DAY1 -> "hour"
        DateFormat.Field.MINUTE -> "minute"
        DateFormat.Field.SECOND -> "second"
        DateFormat.Field.TIME_ZONE -> "timeZoneName"
        DateFormat.Field.AM_PM -> "dayPeriod"
        else -> if (field.toString() == "android.icu.text.DateFormat\$Field(related year)") "relatedYear" else "literal"
    }
}
