package tech.dongdongbh.mindwtr.pilot

import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/*
 * The lucide icons the React Native app uses (lucide-react-native 0.556.0), built
 * from lucide's own 24x24 path data: stroke 2 unless RN sets another, round caps
 * and joins, no fill. Only the icons this app shows are here.
 *
 * Lucide is ISC licensed:
 * Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2023 as part of
 * Feather (MIT). All other copyright (c) for Lucide are held by Lucide Contributors 2025.
 * Permission to use, copy, modify, and/or distribute this software for any purpose
 * with or without fee is hereby granted, provided that the above copyright notice
 * and this permission notice appear in all copies. THE SOFTWARE IS PROVIDED "AS IS"
 * AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE
 * LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
 * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF
 * CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH
 * THE USE OR PERFORMANCE OF THIS SOFTWARE.
 */

/** Lucide's `<circle>` as a path. */
internal fun circle(cx: Int, cy: Int, r: Int) = "M${cx - r} ${cy}a$r $r 0 1 0 ${2 * r} 0a$r $r 0 1 0 ${-2 * r} 0"

internal fun lucide(name: String, vararg paths: String, stroke: Float = 2f, filled: Boolean = false): ImageVector =
    ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
        for (path in paths) {
            addPath(
                addPathNodes(path), fill = if (filled) SolidColor(ICON_MASK) else null, stroke = SolidColor(ICON_MASK),
                strokeLineWidth = stroke, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round,
            )
        }
    }.build()

private const val STAR = "M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 " +
    ".294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 " +
    "0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 " +
    "2.122 0 0 0 1.597-1.16z"

object Lucide {
    val Target = lucide("Target", circle(12, 12, 10), circle(12, 12, 6), circle(12, 12, 2))
    val Inbox = lucide("Inbox", "M22 12L16 12L14 15L10 15L8 12L2 12",
        "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z")
    val Folder = lucide("Folder",
        "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z")
    /** The capture popup's Import .txt. */
    val FileText = lucide("FileText",
        "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z",
        "M14 2v5a1 1 0 0 0 1 1h5", "M10 9H8", "M16 13H8", "M16 17H8")
    /** RN's capture button draws Plus at stroke 3. */
    val Plus = lucide("Plus", "M5 12h14", "M12 5v14", stroke = 3f)
    val Check = lucide("Check", "M20 6 9 17l-5-5")
    val Circle = lucide("Circle", circle(12, 12, 10))
    val Star = lucide("Star", STAR)
    val StarFilled = lucide("StarFilled", STAR, filled = true)
    val TriangleAlert = lucide("TriangleAlert", "m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3",
        "M12 9v4", "M12 17h.01", stroke = 2.5f)
    val ChevronLeft = lucide("ChevronLeft", "m15 18-6-6 6-6")
    val ChevronDown = lucide("ChevronDown", "m6 9 6 6 6-6", stroke = 2.2f)
    val ChevronRight = lucide("ChevronRight", "m9 18 6-6-6-6", stroke = 2.2f)
    val X = lucide("X", "M18 6 6 18", "m6 6 12 12")
    val RotateCcw = lucide("RotateCcw", "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5")
    val ArrowRight = lucide("ArrowRight", "M5 12h14", "m12 5 7 7-7 7")
    val CircleDot = lucide("CircleDot", circle(12, 12, 10), circle(12, 12, 1))
    val UserRound = lucide("UserRound", circle(12, 8, 5), "M20 21a8 8 0 0 0-16 0")
    val Repeat = lucide("Repeat", "m17 2 4 4-4 4", "M3 11v-1a4 4 0 0 1 4-4h14", "m7 22-4-4 4-4", "M21 13v1a4 4 0 0 1-4 4H3")
    val History = lucide("History", "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5", "M12 7v5l4 2")
    val ListChecks = lucide("ListChecks", "M13 5h8", "M13 12h8", "M13 19h8", "m3 17 2 2 4-4", "m3 7 2 2 4-4")
    val Paperclip = lucide("Paperclip", "m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551")
    val ChevronsUp = lucide("ChevronsUp", "m17 11-5-5-5 5", "m17 18-5-5-5 5")
    val ChevronsDown = lucide("ChevronsDown", "m7 6 5 5 5-5", "m7 13 5 5 5-5")
    // The task editor's field headings and controls (TaskEditFormTab and its field components).
    val Type = lucide("Type", "M12 4v16", "M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2", "M9 20h6")
    val ListTodo = lucide("ListTodo", "M13 5h8", "M13 12h8", "M13 19h8", "m3 17 2 2 4-4",
        "M4 4h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z")
    val Layers = lucide("Layers", "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z",
        "M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12",
        "M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17")
    val AtSign = lucide("AtSign", circle(12, 12, 4), "M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8")
    val Tag = lucide("Tag", "M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z",
        "M7 7.5a.5 .5 0 1 0 1 0a.5 .5 0 1 0-1 0")
    private const val CALENDAR = "M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
    val Calendar = lucide("Calendar", "M8 2v4", "M16 2v4", CALENDAR, "M3 10h18")
    val CalendarDays = lucide("CalendarDays", "M8 2v4", "M16 2v4", CALENDAR, "M3 10h18", "M8 14h.01", "M12 14h.01", "M16 14h.01",
        "M8 18h.01", "M12 18h.01", "M16 18h.01")
    val CalendarX = lucide("CalendarX", "M8 2v4", "M16 2v4", CALENDAR, "M3 10h18", "m14 14-4 4", "m10 14 4 4")
    val CalendarClock = lucide("CalendarClock", "M16 14v2.2l1.6 1", "M16 2v4", "M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5",
        "M3 10h5", "M8 2v4", circle(16, 16, 6))
    val Clock = lucide("Clock", "M12 6v6l4 2", circle(12, 12, 10))
    val Flag = lucide("Flag", "M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528")
    private const val BATTERY = "M4 6h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"
    val BatteryCharging = lucide("BatteryCharging", "m11 7-3 5h4l-3 5", "M14.856 6H16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.935", "M22 14v-4",
        "M5.14 18H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2.936")
    val BatteryLow = lucide("BatteryLow", "M22 14v-4", "M6 14v-4", BATTERY)
    val BatteryMedium = lucide("BatteryMedium", "M10 14v-4", "M22 14v-4", "M6 14v-4", BATTERY)
    val BatteryFull = lucide("BatteryFull", "M10 10v4", "M14 10v4", "M22 14v-4", "M6 10v4", BATTERY)
    val CircleSlash = lucide("CircleSlash", circle(12, 12, 10), "M9 15 15 9")
    val Hourglass = lucide("Hourglass", "M5 22h14", "M5 2h14", "M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22",
        "M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2")
    val User = lucide("User", "M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2", circle(12, 7, 4))
    val AlignLeft = lucide("AlignLeft", "M21 5H3", "M15 12H3", "M17 19H3")
    val Navigation = lucide("Navigation", "M3 11 22 2 13 21 11 13z")
    /** RN's field help button draws Ionicons help-circle-outline; lucide's CircleQuestionMark is the same glyph. */
    val CircleHelp = lucide("CircleHelp", circle(12, 12, 10), "M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3", "M12 17h.01")
    // RN's TASK_STATUS_ICONS (lib/task-status-icons.ts): Inbox, ArrowRight, Check and these.
    val CirclePause = lucide("CirclePause", circle(12, 12, 10), "M10 15V9", "M14 15V9")
    val CircleArrowUp = lucide("CircleArrowUp", circle(12, 12, 10), "m16 12-4-4-4 4", "M12 16V8")
    val Book = lucide("Book", "M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20")
    // Global search (app/global-search.tsx) and Process Inbox (inbox-processing/ and inbox.tsx).
    val Search = lucide("Search", "m21 21-4.34-4.34", circle(11, 11, 8))
    val SlidersHorizontal = lucide("SlidersHorizontal", "M10 5H3", "M12 19H3", "M14 3v4", "M16 17v4", "M21 12h-9", "M21 19h-5",
        "M21 5h-7", "M8 10v4", "M8 12H3")
    /** RN's CheckCircle (lucide CircleCheckBig). */
    val CheckCircle = lucide("CheckCircle", "M21.801 10A10 10 0 1 1 17 3.335", "m9 11 3 3L22 4")
    /** RN's CheckCircle2 (lucide CircleCheck). */
    val CheckCircle2 = lucide("CheckCircle2", circle(12, 12, 10), "m9 12 2 2 4-4")
    /** RN's XCircle (lucide CircleX). */
    val XCircle = lucide("XCircle", circle(12, 12, 10), "m15 9-6 6", "m9 9 6 6")
    val Pencil = lucide("Pencil", "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z", "m15 5 4 4")
    val Trash2 = lucide("Trash2", "M10 11v6", "M14 11v6", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M3 6h18", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2")
    val LayoutList = lucide("LayoutList", "M4 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z",
        "M4 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z", "M14 4h7", "M14 9h7", "M14 15h7", "M14 20h7")
    val ChevronUp = lucide("ChevronUp", "m18 15-6-6-6 6")
    /** RN's SettingsGuideLink icon (lucide external-link, stroke 2.2). */
    val ExternalLink = lucide("ExternalLink", "M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6", stroke = 2.2f)
    /** RN's START_LATER_ICON. */
    val Clock3 = lucide("Clock3", "M12 6v6h4", circle(12, 12, 10))
    /** RN's add-project button draws Plus at stroke 2.4. */
    val PlusMedium = lucide("PlusMedium", "M5 12h14", "M12 5v14", stroke = 2.4f)
    // The Menu tab's screens (views/waiting-view.tsx, views/someday-view.tsx, list-overflow-menu.tsx, archived.tsx).
    /** RN's empty-state glyphs are drawn at stroke 1.5. */
    val CirclePauseThin = lucide("CirclePauseThin", circle(12, 12, 10), "M10 15V9", "M14 15V9", stroke = 1.5f)
    val LightbulbThin = lucide("LightbulbThin",
        "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5", "M9 18h6", "M10 22h4", stroke = 1.5f)
    private const val ARCHIVE_BOX = "M3 3h18a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"
    val ArchiveThin = lucide("ArchiveThin", ARCHIVE_BOX, "M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8", "M10 12h4", stroke = 1.5f)
    /** RN's MoreHorizontal (lucide Ellipsis). */
    val MoreHorizontal = lucide("MoreHorizontal", circle(12, 12, 1), circle(19, 12, 1), circle(5, 12, 1))
    val ArrowUpDown = lucide("ArrowUpDown", "m21 16-4 4-4-4", "M17 20V4", "m3 8 4-4 4 4", "M7 4v16")
    val Eye = lucide("Eye", "M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0", circle(12, 12, 3))
    /** RN's Plus at lucide's own stroke 2 (the Someday menu's New section). */
    val PlusPlain = lucide("PlusPlain", "M5 12h14", "M12 5v14")
    /** Lucide's Menu: RN's Menu tab. */
    val Menu = lucide("Menu", "M4 5h16", "M4 12h16", "M4 19h16")
    // The Review, Contexts and Trash screens and the Weekly and Daily Review (review.tsx, review-modal.tsx, daily-review-modal.tsx).
    val ClipboardCheck = lucide("ClipboardCheck", "M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z",
        "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2", "m9 14 2 2 4-4")
    val FolderOpen = lucide("FolderOpen", "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2")
    private const val LIGHTBULB = "M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"
    val Lightbulb = lucide("Lightbulb", LIGHTBULB, "M9 18h6", "M10 22h4")
    // The feedback modal's categories (feedback-settings-modal.tsx): Bug, Lightbulb and MessageSquare.
    val Bug = lucide("Bug", "M12 20v-9", "M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z", "M14.12 3.88 16 2", "M21 21a4 4 0 0 0-3.81-4",
        "M21 5a4 4 0 0 1-3.55 3.97", "M22 13h-4", "M3 21a4 4 0 0 1 3.81-4", "M3 5a4 4 0 0 0 3.55 3.97", "M6 13H2", "m8 2 1.88 1.88",
        "M9 7.13V6a3 3 0 1 1 6 0v1.13")
    val MessageSquare = lucide("MessageSquare",
        "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z")
    val PartyPopper = lucide("PartyPopper", "M5.8 11.3 2 22l10.7-3.79", "M4 3h.01", "M22 8h.01", "M15 2h.01", "M22 20h.01",
        "m22 2-2.24.75a2.9 2.9 0 0 0-1.96 3.12c.1.86-.57 1.63-1.45 1.63h-.38c-.86 0-1.6.6-1.76 1.44L14 10",
        "m22 13-.82-.33c-.86-.34-1.82.2-1.98 1.11c-.11.7-.72 1.22-1.43 1.22H17", "m11 2 .33.82c.34.86-.2 1.82-1.11 1.98C9.52 4.9 9 5.52 9 6.23V7",
        "M11 13c1.93 1.93 2.83 4.17 2 5-.83.83-3.07-.07-5-2-1.93-1.93-2.83-4.17-2-5 .83-.83 3.07.07 5 2Z", stroke = 1.5f)
    /** RN draws the review's Play filled, at stroke 2.5. */
    val PlayFilled = lucide("PlayFilled", "M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z", stroke = 2.5f, filled = true)
    val Share2 = lucide("Share2", circle(18, 5, 3), circle(6, 12, 3), circle(18, 19, 3), "M8.59 13.51 15.42 17.49", "M15.41 6.51 8.59 10.49")
    private const val SPARKLE = "M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z"
    val Sparkles = lucide("Sparkles", SPARKLE, "M20 2v4", "M22 4h-4", circle(4, 20, 2))
    val SparklesThin = lucide("SparklesThin", SPARKLE, "M20 2v4", "M22 4h-4", circle(4, 20, 2), stroke = 1.5f)
    val Brain = lucide("Brain", "M12 18V5", "M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4", "M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5",
        "M17.997 5.125a4 4 0 0 1 2.526 5.77", "M18 18a4 4 0 0 0 2-7.464", "M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517",
        "M6 18a4 4 0 0 1-2-7.464", "M6.003 5.125a4 4 0 0 0-2.526 5.77")
    /** RN's empty-state glyphs at stroke 1.5: Contexts' Tag and CheckCircle2, the reviews' CheckCircle2 and Star. */
    val TagThin = lucide("TagThin", "M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z",
        "M7 7.5a.5 .5 0 1 0 1 0a.5 .5 0 1 0-1 0", stroke = 1.5f)
    val CheckCircle2Thin = lucide("CheckCircle2Thin", circle(12, 12, 10), "m9 12 2 2 4-4", stroke = 1.5f)
    val StarThin = lucide("StarThin", STAR, stroke = 1.5f)
    /** RN's selection check (stroke 3). */
    val CheckBold = lucide("CheckBold", "M20 6 9 17l-5-5", stroke = 3f)
    /** The Board's Filters button (lucide's Filter, drawn as Funnel in 0.556). */
    val Filter = lucide("Filter", "M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z")
    /** Focus's View options, its filter sheet's Save, and the Today's Focus reorder handle. */
    val Settings2 = lucide("Settings2", "M14 17H5", "M19 7h-9", circle(17, 17, 3), circle(7, 7, 3))
    val BookmarkPlus = lucide("BookmarkPlus", "m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z", "M12 7L12 13", "M15 10L9 10")
    val GripVertical = lucide("GripVertical", circle(9, 12, 1), circle(9, 5, 1), circle(9, 19, 1), circle(15, 12, 1), circle(15, 5, 1), circle(15, 19, 1))
}

/*
 * The Ionicons the React Native app draws on Android through IconSymbol (components/ui/icon-symbol.tsx, @expo/vector-icons
 * 15.0.3): the More sheet's tiles and utilities, and the stack header's back chevron. Each path is the glyph's outline
 * from the icon font RN renders (Ionicons.ttf), on its 512 grid; the glyphs are filled.
 *
 * Ionicons is MIT licensed: Copyright (c) 2015-present Ionic (http://ionic.io/). Permission is hereby granted, free of
 * charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions: The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
 */
internal fun ionicon(name: String, path: String): ImageVector =
    ImageVector.Builder(name, 24.dp, 24.dp, 512f, 512f).apply { addPath(addPathNodes(path), fill = SolidColor(ICON_MASK)) }.build()

object Ionicons {
    // The attachments field's buttons (TaskEditContentField: document-attach-outline, image-outline, link-outline).
    val DocumentAttachOutline = ionicon("DocumentAttachOutline",
        "M148 17Q151 16 163 17Q181 17 194 26Q207 34 213 44L215 48H249Q279 48 285.5 49Q292 50 300 56Q306 59 379.5 132.5" +
        "Q453 206 456 212Q460 217 462 223L464 229V336Q464 442 462 448Q454 476 428 489Q418 495 404 495.5Q390 496 293 496" +
        "L179 495L172 493Q161 489 151 481Q137 469 130 450L128 444V382V320H126Q96 314 80 300Q61 283 53 259Q48 245 48 192" +
        "Q48 143 49 140Q52 128 64 128Q73 128 78 137Q80 140 80 190Q81 232 81.5 240Q82 248 88 258Q96 275 111 282" +
        "Q123 288 137 288Q178 288 190 244Q192 239 192 158Q192 77 190 72Q184 51 165 49Q142 45 133 65Q129 72 128.5 83.5" +
        "Q128 95 128 157V236L131 238Q135 241 140 239Q143 237 143.5 227Q144 217 144 154Q144 76 146 73Q150 64 160 64" +
        "Q170 64 174 73Q176 76 176 158Q176 223 175.5 233.5Q175 244 171 251Q167 259 158 265Q145 275 128 271" +
        "Q117 269 108 260Q101 253 98 244Q96 239 96 158Q96 77 98 70Q107 25 148 17ZM272 140V80H248H224V151" +
        "Q224 214 223.5 230.5Q223 247 219 260Q210 288 186 304Q175 312 165 315L160 317L161 379V441L163 445" +
        "Q170 460 186 463Q191 464 295.5 464Q400 464 406 463Q416 461 422 454Q429 448 431 440Q432 436 432 338V240H372" +
        "Q323 240 314 239Q305 238 297 234Q284 228 278 215Q274 207 273 198Q272 189 272 140ZM364 208Q364 208 364 208H409" +
        "L356 155L304 103V150Q304 197 306 199Q309 206 316 207Q319 208 364 208Z")
    val ImageOutline = ionicon("ImageOutline",
        "M259 64Q399 64 416 64.5Q433 65 443 70Q471 83 479 113Q480 119 480 256Q480 393 479 399Q470 431 440 443" +
        "Q431 447 411.5 447.5Q392 448 256 448Q120 448 100.5 447.5Q81 447 72 443Q42 431 33 399Q32 393 32 256" +
        "Q32 119 33 113Q41 83 69 70Q76 67 81 66Q86 65 87.5 64.5Q89 64 259 64ZM428 98 423 96H256H89L84 98Q68 105 65 122" +
        "Q64 128 64 222V316L113 272Q163 229 168 226Q190 214 212 225Q220 229 266 275L312 321L327 307Q344 289 355 286" +
        "Q360 284 369.5 284Q379 284 386 286Q395 289 424 314L448 333V231Q448 128 447 122Q444 105 428 98ZM325 129" +
        "Q349 124 367 139.5Q385 155 384 179Q383 196 371 208Q360 221 342.5 223.5Q325 226 311 217Q295 207 290 190" +
        "Q286 177 290 163Q298 135 325 129ZM343 162Q341 160 336 160.5Q331 161 329 162Q322 165 320.5 172.5" +
        "Q319 180 324 186Q332 195 342 191Q347 188 350 183Q354 176 351 170Q348 164 343 162ZM198 254Q189 249 179 257" +
        "Q177 259 120 309L64 359V373Q64 387 65 392Q69 407 85 414L90 416H154L217 417L253 380L290 344L245 300" +
        "Q201 255 198 254ZM378 318Q378 318 378 318Q375 316 370.5 316Q366 316 364 317Q362 317 313 366Q264 415 264 416" +
        "Q264 416 343 416Q343 416 422 416L427 414Q448 406 448 381Q448 381 448 375L415 348Q381 320 378 318Z")
    val LinkOutline = ionicon("LinkOutline",
        "M125 144Q132 143 172 142.5Q212 142 215 144Q226 148 226 160Q226 167 220 173Q217 177 211 177.5Q205 178 171 178" +
        "Q136 179 129 180Q122 181 111 186Q88 196 76.5 217Q65 238 67 264Q68 285 81.5 302.5Q95 320 115 328" +
        "Q129 334 175 334L215 335L218 337Q231 346 224 360Q220 367 213 369Q208 371 170 370.5Q132 370 124 368" +
        "Q106 365 91 357Q61 341 44 310.5Q27 280 31 246Q34 207 60 179Q86 151 125 144ZM297 144Q299 143 338.5 142.5" +
        "Q378 142 385 143Q442 152 469 203Q489 241 479 283Q470 316 446 339Q422 362 388 368Q380 370 342 370.5" +
        "Q304 371 299 369Q288 366 286.5 355Q285 344 294 337L297 335L337 334Q377 334 384 332Q411 326 428.5 305" +
        "Q446 284 446 256Q446 207 401 186Q390 181 383 180Q376 179 341 178Q307 178 301 177.5Q295 177 292 173" +
        "Q286 167 286 160Q286 148 297 144ZM158 239Q158 239 158 239Q160 238 257.5 238Q355 238 358 240" +
        "Q367 244 368.5 253.5Q370 263 362 269Q359 272 356 273Q353 274 255 274Q255 274 157 273L153 271Q140 261 148 248" +
        "Q152 240 158 239Z")
    val PauseCircle = ionicon("PauseCircle",
        "M242 49Q312 44 370 82Q387 94 403 110Q453 159 463 232Q464 239 464 256Q464 273 463 280Q453 353 403 403" +
        "Q353 453 280 463Q273 464 256 464Q239 464 232 463Q159 453 109 403Q59 353 50 281Q40 206 82 142" +
        "Q110 101 151.5 76.5Q193 52 242 49ZM216 179Q210 175 206 176Q205 176 203 177Q197 178 194 186Q192 189 192 256" +
        "Q192 323 194 326Q198 335 207 336Q216 337 221 329L224 325V256V187L222 184Q219 180 216 179ZM311 178" +
        "Q311 178 311 178Q306 175 299.5 177Q293 179 290 184Q290 184 288 188V256V325L291 329Q296 337 305 336" +
        "Q314 335 318 326Q320 323 320 256Q320 189 319 186Q316 180 311 178Z")
    val ArrowUpCircle = ionicon("ArrowUpCircle",
        "M242 49Q263 47 283 50Q324 55 360.5 76Q397 97 421 130Q477 203 461 292Q452 341 421 382Q405 405 382 421" +
        "Q338 454 284 462Q273 464 256 464Q239 464 228 462Q174 454 130 421Q107 405 91 382Q58 338 50 284Q46 256 50 228" +
        "Q57 181 82.5 141.5Q108 102 149 78Q192 52 242 49ZM263 156Q263 156 263 156Q255 152 248 156Q246 158 205.5 197.5" +
        "Q165 237 163 241Q160 245 160.5 251.5Q161 258 165 261Q170 265 176 265Q181 265 186 261.5Q191 258 212 236" +
        "Q212 236 240 209V277V346L242 350Q247 358 256 358Q265 358 269 350Q269 350 272 346V277V209L300 236" +
        "Q321 258 326 261.5Q331 265 336 265Q342 265 347 261Q351 258 351.5 251.5Q352 245 349 241Q347 237 306 197" +
        "Q265 157 263 156Z")
    val Clipboard = ionicon("Clipboard",
        "M191 18Q196 16 256 16Q304 16 313 16.5Q322 17 330 21Q342 27 348 40Q351 46 352.5 47Q354 48 366 48Q385 49 397 55" +
        "Q420 67 429 93L431 99L432 269Q432 412 431.5 430.5Q431 449 425 460Q416 480 396 489Q385 494 371 495" +
        "Q357 496 256 496Q155 496 141 495Q127 494 116 489Q96 480 87 460Q81 449 80.5 430.5Q80 412 80 269L81 99L83 93" +
        "Q92 67 115 55Q127 49 146 48Q158 48 159.5 47Q161 46 164 40Q172 23 191 18ZM329 83Q329 83 329 83L326 81L257 80" +
        "Q188 80 186 82Q180 84 178 89Q177 91 177 96Q177 101 178 103Q181 109 186 111Q189 112 256 112Q323 112 326 111" +
        "Q331 109 334 103Q335 101 335 96Q335 88 329 83Z")
    val Book = ionicon("Book",
        "M42 49Q48 48 71 49Q145 52 188 68Q205 74 220.5 84.5Q236 95 239 100Q240 103 240 274.5Q240 446 239 447" +
        "Q236 449 229 443Q193 413 125 404Q102 401 67 400Q41 400 36 398Q24 393 19 380L17 375V223V71L19 66Q26 51 42 49Z" +
        "M447 48Q447 48 447 48Q455 48 460 48Q483 47 493 66Q493 66 495 71V224V377L493 382Q487 393 476 398" +
        "Q471 400 446 400Q412 401 387 404Q316 413 283 443Q277 449 274 447Q272 446 272 274.5Q272 103 273 100" +
        "Q276 95 290.5 85Q305 75 321 69Q368 50 447 48Z")
    val EllipseOutline = ionicon("EllipseOutline",
        "M241 49Q271 47 301 53Q336 60 366 80Q448 131 462 228Q464 238 464 256Q464 274 462 284Q451 357 399 406" +
        "Q352 452 284 462Q274 464 256 464Q238 464 228 462Q182 455 146 433Q65 381 50 284Q48 274 48 256Q48 238 50 228" +
        "Q55 194 70 164Q94 115 140 83.5Q186 52 241 49ZM284 82Q284 82 284 82Q278 81 261.5 80.5Q245 80 240 81" +
        "Q175 89 132 132Q92 172 82 229Q81 238 81 256Q81 274 82 283Q85 303 92 319Q114 376 166 407Q218 438 279 430" +
        "Q337 423 378.5 382.5Q420 342 430 283Q431 274 431 256Q431 238 430 229Q421 174 383 134Q343 92 284 82Z")
    val CalendarOutline = ionicon("CalendarOutline",
        "M120 35Q125 31 131.5 32.5Q138 34 142 40Q144 43 144 54V64H256H368V54Q368 43 370 40Q375 32 384 32Q393 32 398 40" +
        "Q400 43 400 53V64H414Q432 65 443 70Q470 83 478 113Q480 118 480.5 265.5Q481 413 480 422Q477 445 462 461" +
        "Q446 477 423 480Q415 480 256 480Q97 480 89 480Q67 477 51 462Q35 445 32 422Q31 413 31.5 265.5Q32 118 34 113" +
        "Q42 83 69 70Q80 65 98 64H112V53Q112 39 120 35ZM427 98Q422 96 256 96H89L84 98Q75 102 69 111Q64 119 64 136V144" +
        "H256H448V135Q448 126 447 121Q443 104 427 98ZM448 300V176H256H64V300V424L67 429Q72 440 83 445L88 448H256H424" +
        "L429 445Q440 440 445 429L448 424ZM289 209Q291 208 297.5 208.5Q304 209 307 211Q320 218 320 232" +
        "Q320 244 310 251.5Q300 259 288 255Q279 252 275 243Q270 234 274 224Q278 213 289 209ZM384 210Q393 212 397.5 221" +
        "Q402 230 399 238Q394 254 378 256Q363 257 355.5 244.5Q348 232 355 220Q359 214 367 210Q375 206 384 210ZM126 290" +
        "Q136 286 147 291Q158 296 159.5 308.5Q161 321 152 329Q146 336 136 336Q121 336 114 322Q110 312 114 303" +
        "Q118 294 126 290ZM206 290Q210 288 217 289Q232 289 238 302Q242 310 239 320Q236 329 227 333.5Q218 338 210 335" +
        "Q194 330 192.5 314Q191 298 206 290ZM288 290Q291 289 296 288Q306 288 314 296Q323 306 319 318.5Q315 331 302 335" +
        "Q291 338 281.5 331Q272 324 272 312Q272 296 288 290ZM365 291Q382 283 394 296Q400 303 400 312Q400 322 393 329" +
        "Q386 336 376 336Q366 336 360 329Q351 321 352.5 308.5Q354 296 365 291ZM131 369Q142 366 151 373.5" +
        "Q160 381 160 392Q160 407 146.5 413.5Q133 420 121 410Q109 400 113 386Q117 371 131 369ZM210 369" +
        "Q218 367 227 371.5Q236 376 239 384Q242 394 238 402Q234 410 227 413Q219 417 210 415Q198 412 194 400" +
        "Q190 390 194.5 381Q199 372 210 369ZM290 369Q290 369 290 369Q301 366 310 372.5Q319 379 320 390Q321 410 302 415" +
        "Q291 418 282 411.5Q273 405 272 394Q271 374 290 369Z")
    val Folder = ionicon("Folder",
        "M60 65Q66 64 112 64H158L166 67Q173 69 190.5 81Q208 93 211.5 94.5Q215 96 333 96L452 97L457 99Q470 103 480 113" +
        "Q489 122 493 134Q495 140 496 156V171L494 173L491 176H256H21L19 173L16 171V142Q16 113 18 106Q22 91 33.5 80" +
        "Q45 69 60 65ZM19 210 21 208H256H491L493 210L496 213V306Q496 399 494 406Q490 420 479 431Q469 441 456 446" +
        "Q456 446 450 448H256H62L56 446Q43 441 33 431Q22 420 18 406Q16 399 16 306Q16 306 16 213Z")
    val Trash = ionicon("Trash",
        "M204 34Q209 33 256 32.5Q303 32 308 34Q324 39 331 54Q336 63 336 83V96H386Q436 96 439 98Q446 102 447.5 109.5" +
        "Q449 117 444 123Q439 128 424 128H415L405 283Q398 408 396 427.5Q394 447 390 455Q383 468 371 474" +
        "Q362 479 350.5 479.5Q339 480 256 480Q157 480 151 478Q120 469 116 434Q115 425 106 277L97 128H88Q73 128 68 123" +
        "Q63 117 64.5 109.5Q66 102 73 98Q76 96 126 96H176V83Q176 63 181 54Q188 39 204 34ZM301 66 299 64H256H213L211 66" +
        "L208 69V83V96H256H304V83V69ZM191 162Q184 159 178 161.5Q172 164 169 170Q168 174 172 284Q176 394 176 399" +
        "Q177 409 184 414Q198 421 205 408Q208 404 207.5 392.5Q207 381 204 277Q200 173 199 170Q197 164 191 162ZM264 162" +
        "Q258 159 252 161Q246 163 242 168L240 172V288V404L242 408Q250 422 264 414Q268 411 270 408L272 404V288V172" +
        "L270 168Q268 165 264 162ZM337 163Q337 163 337 163Q334 161 329 160.5Q324 160 321 162Q315 164 313 170" +
        "Q312 173 308 287Q304 401 305 404Q308 416 320 416Q335 416 336 400Q336 395 340 284Q340 284 344 173L342 170" +
        "Q341 166 337 163Z")
    val Grid = ionicon("Grid",
        "M57 34Q61 32 137 33H214L219 36Q232 42 237 54L239 59L240 135Q240 210 238 215Q232 232 215 238Q210 240 136 240" +
        "Q62 240 57 238Q36 231 32 209Q32 204 32 135Q32 81 32.5 69.5Q33 58 36 52Q42 39 57 34ZM297 34Q301 33 377 33H454" +
        "L460 36Q476 44 480 63Q480 69 480 136Q480 203 480 209Q478 221 470 229Q463 236 455 238Q450 240 376 240" +
        "Q302 240 298 238Q279 233 274 214Q272 209 272 134L273 59L275 54Q281 39 297 34ZM57 274Q62 272 137 272L213 273" +
        "L219 275Q234 283 238 298Q240 302 240 376Q240 450 238 455Q236 463 229 470Q221 478 209 480Q203 480 136 480" +
        "Q69 480 63 480Q44 477 36 461Q33 454 32.5 443Q32 432 32 377Q32 308 32 303Q36 281 57 274ZM299 273" +
        "Q299 273 299 273Q303 272 376.5 272Q450 272 455 274Q476 280 480 303Q480 309 480 376Q480 443 480 449" +
        "Q475 475 449 480Q443 480 376 480Q309 480 303 480Q281 476 274 455Q272 450 272 376Q272 315 272.5 305.5" +
        "Q273 296 277 289Q286 276 299 273Z")
    val Time = ionicon("Time",
        "M242 49Q263 47 283 50Q324 55 360.5 76Q397 97 421 130Q477 203 461 292Q452 341 421 382Q405 405 382 421" +
        "Q338 454 284 462Q273 464 256 464Q239 464 228 462Q174 454 130 421Q107 405 91 382Q58 338 50 284Q46 256 50 228" +
        "Q57 181 82.5 141.5Q108 102 149 78Q192 52 242 49ZM265 115Q265 115 265 115Q251 106 242 120Q242 120 240 123V200" +
        "V276L242 280Q245 284 248 286Q248 286 252 288H301Q357 289 362 284Q368 279 367.5 270Q367 261 359 258" +
        "Q355 256 314 256Q314 256 272 256V190V123L270 120Q268 117 265 115Z")
    val Settings = ionicon("Settings",
        "M202 29 207 26H256H305L309 28Q320 34 324 44Q325 47 328 68.5Q331 90 332 92.5Q333 95 337 98Q349 108 357 108" +
        "Q360 108 382 99.5Q404 91 410 91Q422 91 430 99Q433 103 453 137.5Q473 172 477 180Q483 191 477 203" +
        "Q475 207 472 210Q469 213 450 228Q437 239 435 241.5Q433 244 433 256Q433 268 435 271Q437 274 454 287.5" +
        "Q471 301 474 304Q484 316 478 330Q476 334 454 372Q436 405 431 411.5Q426 418 418 420Q412 422 407.5 421.5" +
        "Q403 421 382 412Q363 404 358.5 403.5Q354 403 345 408Q337 412 336 414Q332 417 328 443Q325 465 324 469" +
        "Q320 480 308 484Q304 486 258 486Q221 486 212.5 485.5Q204 485 199 482Q192 477 189 470Q187 466 184 444" +
        "Q181 422 180 420Q178 415 167 409Q158 404 153.5 404Q149 404 130 412Q102 423 93 420Q85 417 81 411" +
        "Q78 408 57.5 372Q37 336 34 331Q28 318 38 305Q39 302 55 290Q76 274 78 269Q79 267 79 256Q79 245 77.5 242" +
        "Q76 239 59 226Q36 208 34 200Q30 191 33 183Q34 180 57 142Q75 109 80.5 102Q86 95 92 93Q97 91 102.5 91" +
        "Q108 91 129 100Q149 108 153.5 108.5Q158 109 167 104Q177 98 179 93Q181 91 184 69Q187 47 188 43Q191 34 202 29Z" +
        "M265 177Q256 176 247 177Q211 181 190 210Q182 222 179 236Q176 244 176 256Q176 275 184 291Q190 303 201 313" +
        "Q235 347 282 332Q315 320 329 287.5Q343 255 329 223Q316 196 289 183Q278 178 265 177ZM246 209Q246 209 246 209" +
        "Q259 206 272 211Q297 220 302.5 245.5Q308 271 290 290Q275 304 256 304Q237 304 222.5 290Q208 276 208 256" +
        "Q208 239 219 226Q230 213 246 209Z")
    val FileTray = ionicon("FileTray",
        "M115 65Q121 64 255.5 64Q390 64 397 65Q431 71 444 103Q446 110 463 191L480 272V327Q480 383 480 390" +
        "Q475 433 433 446L427 448H256H85L79 446Q37 433 32 390Q32 383 32 327V272L48 193Q65 114 67 108Q74 82 96 71" +
        "Q105 67 115 65ZM400 99Q400 99 400 99L396 97H258Q120 97 117 97Q109 99 104 105Q100 110 97 120.5Q94 131 83 183" +
        "Q69 250 69 252Q69 254 70 255Q71 256 133 256Q183 256 191 256.5Q199 257 203 261Q208 265 208 273" +
        "Q208 292 222.5 306Q237 320 256 320Q266 320 276 315Q288 310 296 298Q304 286 304 273Q304 265 309 261" +
        "Q313 257 321 256.5Q329 256 379 256Q441 256 442 255Q443 254 443 252Q443 248 418 132Q415 115 411.5 109" +
        "Q408 103 400 99Z")
    val ChevronBack = ionicon("ChevronBack",
        "M322 89Q322 89 322 89Q329 87 337 90.5Q345 94 349 101Q355 112 349 123Q348 126 283 191Q283 191 218 256L283 321" +
        "Q348 386 349 389Q353 396 351 404Q350 413 342.5 419Q335 425 326 424Q319 423 309 414Q299 405 239 345" +
        "Q178 284 169 274Q160 264 160 256Q160 248 168.5 238.5Q177 229 237 169Q309 96 313.5 93Q318 90 322 89Z")

    /** RN's IconSymbol MAPPING from core's SF Symbols names (more-menu-model.ts) to the Ionicons it draws on Android. */
    // Project details (ProjectDetailModal): the type and scope help, the notes' expand, a date's clear, a dialog's close.
    val HelpCircleOutline = ionicon("HelpCircleOutline",
        "M242 65Q261 63 284 66Q313 71 340 84Q395 110 424.5 163.5Q454 217 447 278Q441 327 413 367Q385 407 340 428Q285 45" +
        "6 224.5 445.5Q164 435 120 391Q98 369 84 341Q64 301 64 256Q64 211 84 171Q113 112 172 84Q203 69 242 65ZM279 98Q2" +
        "72 97 257 96.5Q242 96 235 97Q181 105 143 143Q105 181 98 233Q94 256 98 279Q107 341 156 380.5Q205 420 267 416Q32" +
        "0 412 359.5 378Q399 344 412 293Q419 264 414 233Q407 181 369 143Q331 105 279 98ZM243 145Q248 144 261 144.5Q274 " +
        "145 279 146Q300 152 314 169Q327 185 326 207Q325 224 316.5 236.5Q308 249 287 264Q267 278 265 293Q264 305 257 30" +
        "8Q246 314 239 303Q232 292 243 270Q251 255 271 240Q290 227 295 218Q297 212 297 204Q297 196 295 192Q288 178 272 " +
        "174Q267 173 258.5 172.5Q250 172 245 173Q225 177 217 195Q214 200 214 202Q214 209 208 214Q200 220 191 213Q184 20" +
        "6 188 192Q193 174 208.5 161Q224 148 243 145ZM241 330Q241 330 241 330Q251 325 261 331Q269 337 270 346Q270 355 2" +
        "65 361Q259 368 250 368Q242 368 237 362Q229 355 230.5 345Q232 335 241 330Z")
    val ExpandOutline = ionicon("ExpandOutline",
        "M76 65Q77 64 136 64Q195 64 198 66Q207 70 207.5 79.5Q208 89 200 94L196 96H157L119 97L171 148Q223 200 223 204Q22" +
        "5 211 222 216Q219 222 213 223Q210 224 209 224Q208 224 204 223.5Q200 223 148 171L97 119L96 157V196L94 200Q89 20" +
        "8 81 208Q73 208 67 201L64 198V136V75L67 71Q70 67 76 65ZM314 66Q317 64 377 64H438L441 67Q444 70 446 72Q448 74 4" +
        "48 136V198L445 201Q439 209 431 208Q423 207 418 200L416 196V157L415 119L364 171Q312 223 308 223.5Q304 224 303 2" +
        "24Q302 224 299 223Q293 222 290 216Q287 211 289 204Q289 200 341 148L393 97L355 96H316L312 94Q304 89 304.5 79.5Q" +
        "305 70 314 66ZM215 290Q222 293 223 299Q224 302 224 303Q224 304 223.5 308Q223 312 171 363.5Q119 415 119 415.5Q1" +
        "19 416 158 416H197L200 419Q213 426 206 439Q204 442 201 445L198 448H138Q78 448 75 447Q72 446 68.5 442.5Q65 439 " +
        "64.5 436Q64 433 64 374V314L67 311Q72 304 80 304Q89 304 94 312L96 316V355L97 393L147 342Q198 291 200.5 290Q203 " +
        "289 208 288.5Q213 288 215 290ZM297 289Q297 289 297 289Q299 289 303.5 288.5Q308 288 310.5 289Q313 290 364 342Q3" +
        "64 342 415 393L416 355Q416 316 418 313Q422 304 432 304Q440 304 445 311Q445 311 448 314V374Q448 433 447.5 436Q4" +
        "47 439 443.5 442.5Q440 446 437 447Q434 448 374 448Q374 448 314 448L311 445Q308 442 306 439Q299 426 312 419Q312" +
        " 419 315 416H354Q393 416 393 415.5Q393 415 341 363.5Q289 312 289 308Q286 296 297 289Z")
    val CloseCircleOutline = ionicon("CloseCircleOutline",
        "M241 49Q256 48 269 49Q351 54 407 113Q452 161 462 228Q464 238 464 256Q464 274 462 284Q454 339 421 382Q405 405 3" +
        "82 421Q339 454 284 462Q274 464 256 464Q238 464 228 462Q173 454 130 421Q107 405 91 382Q58 339 50 284Q48 274 48 " +
        "256Q48 238 50 228Q58 174 91 130Q107 108 130 91Q181 53 241 49ZM284 82Q278 81 261.5 80.5Q245 80 240 81Q212 84 19" +
        "3 92Q149 109 119.5 145Q90 181 82 229Q81 238 81 256Q81 274 82 283Q89 326 114 360Q139 394 178 414Q214 432 256 43" +
        "2Q298 432 334 414Q372 394 397 360.5Q422 327 430 284Q431 275 431 256.5Q431 238 430 229Q420 169 378 129Q338 92 2" +
        "84 82ZM188 177Q188 177 188 177Q194 175 199 178Q201 179 228 206Q228 206 256 233L284 205Q312 178 314 177Q322 175" +
        " 327 178Q333 181 335 188Q337 192 335 197Q334 200 307 228Q307 228 279 256L307 284Q334 312 335 316Q338 327 329 3" +
        "33Q323 337 316 335Q312 334 284 307Q284 307 256 279L228 307Q200 334 196 335Q187 338 180.5 331.5Q174 325 177 316" +
        "Q178 312 205 284Q205 284 233 256L205 228Q178 200 177 196Q175 190 178.5 184Q182 178 188 177Z")
    val Close = ionicon("Close",
        "M136 121Q136 121 136 121Q145 118 154 122Q157 124 207 173Q207 173 256 222L306 173Q347 131 354 125.5Q361 120 369" +
        " 120Q375 121 378 122Q387 127 390 135Q394 145 390 154Q388 157 339 207Q339 207 290 256L339 305Q379 345 385.5 352" +
        ".5Q392 360 392 367Q392 378 385 385Q378 392 367 392Q360 392 352.5 385.5Q345 379 305 339Q305 339 256 290L207 339" +
        "Q167 379 159.5 385.5Q152 392 145 392Q134 392 127 385Q120 378 120 367Q120 360 126.5 352.5Q133 345 173 305Q173 3" +
        "05 222 256L173 207Q133 166 126.5 159Q120 152 120 144Q120 127 136 121Z")
    val bySymbol = mapOf(
        "pause.circle.fill" to PauseCircle, "arrow.up.circle.fill" to ArrowUpCircle, "clipboard.fill" to Clipboard, "book.closed.fill" to Book,
        "circle" to EllipseOutline, "calendar" to CalendarOutline, "folder.fill" to Folder, "trash.fill" to Trash, "square.grid.2x2.fill" to Grid,
        "clock.arrow.circlepath" to Time, "gearshape.fill" to Settings, "tray.fill" to FileTray,
    )
}
