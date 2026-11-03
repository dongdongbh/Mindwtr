
module.exports = {
    content: [
        "./app/**/*.{js,jsx,ts,tsx}",
        "./components/**/*.{js,jsx,ts,tsx}",
    ],
    presets: [require("nativewind/preset")],
    theme: {
        extend: {
            colors: {
                primary: {
                    DEFAULT: '#3b82f6',
                    foreground: '#ffffff',
                },
                background: '#0a0e1a',
                foreground: '#ffffff',
                muted: {
                    DEFAULT: '#1e293b',
                    foreground: '#94a3b8',
                },
                card: {
                    DEFAULT: '#0f172a',
                    foreground: '#ffffff',
                },
                border: '#1e293b',
            },
        },
    },
    plugins: [],
};
