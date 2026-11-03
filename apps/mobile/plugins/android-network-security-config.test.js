const fs = require('fs');
const os = require('os');
const path = require('path');
import { describe, expect, it } from 'vitest';

const {
  CONFIG_FILE_NAME,
  MANIFEST_ATTRIBUTE,
  NETWORK_SECURITY_CONFIG_XML,
  RESOURCE_DIR,
  setNetworkSecurityConfigAttribute,
  writeNetworkSecurityConfigResource,
} = require('./android-network-security-config').__testables;

describe('android-network-security-config plugin', () => {
  it('writes a config trusting system AND user CAs that keeps cleartext permitted', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mindwtr-nsc-'));
    try {
      writeNetworkSecurityConfigResource(projectRoot);
      const written = fs.readFileSync(path.join(projectRoot, RESOURCE_DIR, CONFIG_FILE_NAME), 'utf8');
      expect(written).toBe(NETWORK_SECURITY_CONFIG_XML);
      expect(written).toContain('<certificates src="system" />');
      expect(written).toContain('<certificates src="user" />');


      expect(written).toContain('cleartextTrafficPermitted="true"');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('points the application manifest at the config resource', () => {
    const manifest = { manifest: { application: [{ $: { 'android:name': '.MainApplication' } }] } };
    setNetworkSecurityConfigAttribute(manifest);
    expect(manifest.manifest.application[0].$['android:networkSecurityConfig']).toBe(MANIFEST_ATTRIBUTE);
  });
});
