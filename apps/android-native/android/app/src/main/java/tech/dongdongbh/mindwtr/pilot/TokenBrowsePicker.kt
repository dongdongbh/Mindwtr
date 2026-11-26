package tech.dongdongbh.mindwtr.pilot

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import org.json.JSONArray

data class TokenBrowseOption(val token: String, val selected: Boolean, val text: String)

internal fun tokenBrowseOptions(values: JSONArray?): List<TokenBrowseOption> {
    if (values == null) return emptyList()
    return List(values.length()) { index ->
        val option = values.getJSONObject(index)
        val token = option.getString("token")
        TokenBrowseOption(token, option.getBoolean("selected"), option.optString("text", token))
    }
}

@Composable
internal fun TokenBrowsePicker(
    scope: String,
    fieldLabel: String,
    browseLabel: String,
    searchLabel: String,
    noMatchesLabel: String,
    options: List<TokenBrowseOption>,
    enabled: Boolean,
    onToggle: (TokenBrowseOption) -> Unit,
) {
    val colors = LocalTheme.current.colors
    var expanded by remember(scope) { mutableStateOf(false) }
    var query by remember(scope) { mutableStateOf("") }
    Row(
        Modifier.heightIn(min = 44.dp).clickable(role = Role.Button) {
            expanded = !expanded
            query = ""
        }.semantics { contentDescription = "$fieldLabel · $browseLabel" }.testTag("$scope-browse").padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text(browseLabel, style = rnText(14, 400), color = colors.tint)
        Icon(if (expanded) Lucide.ChevronUp else Lucide.ChevronDown, contentDescription = null, tint = colors.tint, modifier = Modifier.size(16.dp))
    }
    if (expanded) {
        val visible = options.filter { it.token.contains(query.trim(), ignoreCase = true) }
        val shape = RoundedCornerShape(10.dp)
        val searchShape = RoundedCornerShape(8.dp)
        Column(Modifier.fillMaxWidth().clip(shape).background(colors.cardBg).rnBorder(1.dp, colors.border, shape).padding(8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)) {
            BasicTextField(query, { query = it }, singleLine = true, textStyle = rnText(14, 400).copy(color = colors.text), cursorBrush = SolidColor(colors.tint),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = "$fieldLabel · $searchLabel" }.testTag("$scope-browse-search"),
                decorationBox = { inner ->
                    Box(Modifier.heightIn(min = 44.dp).clip(searchShape).background(colors.inputBg).rnBorder(1.dp, colors.border, searchShape)
                        .padding(horizontal = 10.dp), contentAlignment = Alignment.CenterStart) {
                        if (query.isEmpty()) Text(searchLabel, style = rnText(14, 400), color = colors.secondaryText)
                        inner()
                    }
                })
            if (visible.isEmpty()) {
                Text(noMatchesLabel, style = rnText(14, 400), color = colors.secondaryText,
                    modifier = Modifier.heightIn(min = 44.dp).padding(horizontal = 10.dp, vertical = 8.dp)
                        .semantics { liveRegion = LiveRegionMode.Polite })
            } else {
                val optionShape = RoundedCornerShape(6.dp)
                LazyColumn(Modifier.heightIn(max = 220.dp)) {
                    items(visible, key = { it.token }) { option ->
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = 44.dp).clip(optionShape)
                                .background(if (option.selected) colors.filterBg else colors.cardBg)
                                .toggleable(value = option.selected, enabled = enabled, role = Role.Checkbox, onValueChange = { onToggle(option) })
                                .padding(horizontal = 10.dp, vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(option.token, style = rnText(14, 400), color = colors.text, modifier = Modifier.weight(1f))
                            if (option.selected) Icon(Lucide.Check, contentDescription = null, tint = colors.tint, modifier = Modifier.size(18.dp))
                        }
                    }
                }
            }
        }
    }
}
