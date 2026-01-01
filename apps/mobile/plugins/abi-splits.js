const { createRunOncePlugin, withAppBuildGradle, withGradleProperties } = require('@expo/config-plugins');

function buildAbiSplitsBlock() {
    return `
    def reactNativeArchitectures = (findProperty('reactNativeArchitectures') ?: 'arm64-v8a')
        .split(',')
        .collect { it.trim() }
        .findAll { it }
    splits {
        abi {
            enable true
            reset()
            include(*reactNativeArchitectures)
            universalApk false
        }
    }
`;
}

function withAbiSplits(config, props = {}) {
    config = withGradleProperties(config, (config) => {
        const architectures = Array.isArray(props.architectures) && props.architectures.length > 0
            ? props.architectures
            : ['arm64-v8a'];
        const value = architectures.join(',');
        const existing = config.modResults.find(
            (item) => item.type === 'property' && item.key === 'reactNativeArchitectures'
        );
        if (existing) {
            existing.value = value;
        } else {
            config.modResults.push({ type: 'property', key: 'reactNativeArchitectures', value });
        }
        return config;
    });

    return withAppBuildGradle(config, (config) => {
        if (config.modResults.language !== 'groovy') {
            return config;
        }

        const contents = config.modResults.contents;
        if (contents.includes('splits {') || contents.includes('universalApk')) {
            return config;
        }

        const match = contents.match(/defaultConfig\\s*\\{[\\s\\S]*?\\n    \\}/);
        if (!match) {
            return config;
        }

        const block = buildAbiSplitsBlock();
        config.modResults.contents = contents.replace(match[0], `${match[0]}${block}`);
        return config;
    });
}

module.exports = createRunOncePlugin(withAbiSplits, 'mindwtr-abi-splits', '1.0.0');
