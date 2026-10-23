import SwiftUI

// Presentation tokens from mobile/constants/theme{,-presets}.ts and use-theme-tokens.ts.
// Core supplies the selected theme descriptor and all status/priority colors.
struct AppPalette {
    let values: [String]
    let dark: Bool
    let material: Bool
    var bg: Color { color(0) }
    var card: Color { color(1) }
    var row: Color { color(2) }
    var text: Color { color(3) }
    var secondary: Color { color(4) }
    var border: Color { color(5) }
    var tint: Color { color(6) }
    var onTint: Color { color(7) }
    var input: Color { color(8) }
    var danger: Color { color(9) }
    var success: Color { color(10) }
    var warning: Color { color(11) }
    var filter: Color { color(12) }
    var captureBackground: Color { material ? Color(hex: dark ? "00458B" : "D7E2FF") : tint }
    var captureForeground: Color { material ? Color(hex: dark ? "D7E2FF" : "001B3E") : onTint }
    private func color(_ index: Int) -> Color { Color(hex: values[index]) }

    init(theme: CoreObject, system: ColorScheme) {
        dark = theme.text("scheme").isEmpty ? system == .dark : theme.text("scheme") == "dark"
        material = theme.flag("material")
        let preset = theme.object("presets").text(dark ? "dark" : "light")
        if let colors = Self.presets[preset] { values = colors }
        else if material {
            values = dark
                ? ["111318", "1B1E24", "22252B", "E3E2E6", "C3C6CF", "8D9199", "AAC7FF", "003063", "43474E", "FFB4AB", "7CDC94", "F2C16E", "43474E"]
                : ["F9FAFF", "EEF1F7", "E5E9F0", "1A1C1E", "43474F", "73777F", "1B6EF3", "FFFFFF", "DFE3EB", "BA1A1A", "0F7B3D", "8C5A00", "DFE3EB"]
        } else {
            values = dark
                ? ["151718", "1F2937", "1F2937", "ECEDEE", "9CA3AF", "374151", "60A5FA", "0F172A", "374151", "EF4444", "10B981", "F59E0B", "374151"]
                : ["F6F7FB", "FFFFFF", "F1F5F9", "0F172A", "4B5563", "E2E8F0", "2563EB", "FFFFFF", "EEF2F7", "EF4444", "10B981", "F59E0B", "EEF2F7"]
        }
    }

    private static let presets = [
        "eink": ["FFFFFF", "FFFFFF", "FFFFFF", "000000", "000000", "000000", "000000", "FFFFFF", "FFFFFF", "000000", "000000", "000000", "FFFFFF"],
        "nord": ["2E3440", "3B4252", "3B4252", "ECEFF4", "D8DEE9", "4C566A", "88C0D0", "2E3440", "434C5E", "BF616A", "A3BE8C", "EBCB8B", "434C5E"],
        "catppuccin-macchiato": ["24273A", "363A4F", "363A4F", "CAD3F5", "A5ADCB", "5B6078", "C6A0F6", "24273A", "494D64", "ED8796", "A6DA95", "EED49F", "494D64"],
        "dracula": ["282A36", "343746", "343746", "F8F8F2", "ADB5CB", "44475A", "BD93F9", "282A36", "424450", "FF5555", "50FA7B", "FFB86C", "424450"],
        "gruvbox-light": ["F2E5BC", "FBF1C7", "FBF1C7", "3C3836", "665C54", "D5C4A1", "076678", "FBF1C7", "EBDBB2", "9D0006", "79740E", "AD3903", "EBDBB2"],
        "gruvbox-dark": ["282828", "32302F", "32302F", "EBDBB2", "BDAE93", "504945", "9EB9AE", "282828", "3C3836", "FB4934", "B8BB26", "FABD2F", "3C3836"],
        "sepia": ["F4ECD8", "FAF3E3", "FAF3E3", "3B2F2F", "7A5C3E", "E2D3B5", "956735", "FFF6E7", "F0E3C8", "B44B3B", "5F7D4A", "B5813C", "EFE2C7"],
        "oled": ["000000", "000000", "000000", "E5E7EB", "9CA3AF", "1F2937", "4F9DFF", "000000", "0B0B0B", "F87171", "34D399", "FBBF24", "0B0B0B"],
    ]
}

extension Color {
    init(hex: String) {
        let number = UInt64(hex.trimmingCharacters(in: CharacterSet(charactersIn: "#")), radix: 16) ?? 0
        self.init(.sRGB, red: Double((number >> 16) & 255) / 255,
                  green: Double((number >> 8) & 255) / 255, blue: Double(number & 255) / 255, opacity: 1)
    }
}

private struct RNFont: ViewModifier {
    @ScaledMetric var size: Double
    let weight: Font.Weight
    let maximumSize: Double?
    init(size: Double, weight: Font.Weight, maxScale: Double?) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: .body)
        self.weight = weight
        maximumSize = maxScale.map { size * $0 }
    }
    func body(content: Content) -> some View {
        content.font(.system(size: min(size, maximumSize ?? size), weight: weight))
    }
}

extension View {
    // RN caps compact controls explicitly; reading content keeps full scaling.
    func rnFont(_ size: Double, _ weight: Font.Weight = .regular, maxScale: Double? = nil) -> some View {
        modifier(RNFont(size: size, weight: weight, maxScale: maxScale))
    }
}

// Lucide assets are copied from the installed RN dependency, retaining its ISC license.
struct AppIcon: View {
    let name: String
    var size: CGFloat = 24

    var body: some View {
        Image("icon-" + name)
            .resizable()
            .renderingMode(.template)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

// Match RN FocusStarIcon in capture, task rows and Projects.
struct AppFocusStar: View {
    let focused: Bool
    var disabled = false
    let inactiveColor: Color
    var size: CGFloat = 22

    var body: some View {
        AppIcon(name: focused ? "star-filled" : "star", size: size)
            .foregroundStyle(focused ? Color(hex: "#F59E0B") : inactiveColor)
            .opacity(focused ? 1 : disabled ? 0.3 : 0.6)
    }
}
