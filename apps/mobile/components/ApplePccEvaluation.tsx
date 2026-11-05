import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { useThemeColors } from '@/hooks/use-theme-colors';
import {
  ApplePccEvaluationError,
  describeApplePccOutcome,
  getApplePccEvaluationCapability,
  isApplePccEvaluationEnabled,
  loadApplePccEvaluationFixtures,
  runApplePccEvaluation,
  type ApplePccEvaluationBackend,
  type ApplePccEvaluationCapability,
  type ApplePccEvaluationFixture,
  type ApplePccEvaluationFixtureId,
  type ApplePccEvaluationResult,
} from '@/lib/apple-pcc-evaluation';

const BACKENDS: readonly ApplePccEvaluationBackend[] = ['on_device', 'private_cloud_compute'];

const backendTitle = (backend: ApplePccEvaluationBackend): string => (
  backend === 'on_device' ? 'On-device baseline' : 'Apple Private Cloud Compute'
);


export function ApplePccEvaluation() {
  const tc = useThemeColors();
  const [fixtures, setFixtures] = useState<readonly ApplePccEvaluationFixture[]>([]);
  const [fixtureId, setFixtureId] = useState<ApplePccEvaluationFixtureId>('smoke');
  const [capabilities, setCapabilities] = useState<Partial<Record<ApplePccEvaluationBackend, ApplePccEvaluationCapability>>>({});
  const [results, setResults] = useState<Partial<Record<string, ApplePccEvaluationResult>>>({});
  const [pccConsent, setPccConsent] = useState(false);
  const [pccSmokePassed, setPccSmokePassed] = useState(false);
  const [runningBackend, setRunningBackend] = useState<ApplePccEvaluationBackend | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const activeController = useRef<AbortController | null>(null);

  const selectedFixture = useMemo(
    () => fixtures.find((fixture) => fixture.fixtureId === fixtureId) ?? null,
    [fixtureId, fixtures],
  );

  useEffect(() => {
    if (!isApplePccEvaluationEnabled()) return undefined;
    let active = true;
    void loadApplePccEvaluationFixtures().then((loadedFixtures) => {
      if (active) setFixtures(loadedFixtures);
    }).catch((error) => {
      if (active) setMessage(describeApplePccOutcome(
        error instanceof ApplePccEvaluationError ? error.code : 'unknown',
      ));
    });
    for (const backend of BACKENDS) {
      void getApplePccEvaluationCapability(backend).then((capability) => {
        if (active) {
          setCapabilities((current) => ({ ...current, [backend]: capability }));
        }
      });
    }
    return () => {
      active = false;
      activeController.current?.abort();
      activeController.current = null;
    };
  }, []);

  if (!isApplePccEvaluationEnabled()) return null;

  const resultKey = (backend: ApplePccEvaluationBackend): string => `${fixtureId}:${backend}`;

  const run = async (backend: ApplePccEvaluationBackend) => {
    if (!selectedFixture || runningBackend || activeController.current) return;
    if (backend === 'private_cloud_compute' && selectedFixture.fixtureId === 'project_planning' && !pccSmokePassed) {
      setMessage('Complete the PCC smoke request before sending the planning fixture to PCC. The on-device baseline remains available.');
      return;
    }
    if (backend === 'private_cloud_compute' && !pccConsent) {
      setMessage(describeApplePccOutcome('consent_required'));
      return;
    }
    const controller = new AbortController();
    activeController.current = controller;
    setRunningBackend(backend);
    setMessage(null);
    const consent = backend === 'private_cloud_compute' && pccConsent;
    if (backend === 'private_cloud_compute') setPccConsent(false);
    try {
      const result = await runApplePccEvaluation({
        backend,
        fixtureId: selectedFixture.fixtureId,
        consent,
        signal: controller.signal,
      });
      if (controller.signal.aborted || activeController.current !== controller) return;
      if (result.outcome === 'completed') {
        setResults((current) => ({ ...current, [`${selectedFixture.fixtureId}:${backend}`]: result }));
        if (backend === 'private_cloud_compute' && selectedFixture.fixtureId === 'smoke') {
          setPccSmokePassed(true);
        }
      } else {
        setMessage(describeApplePccOutcome(result.outcome));
      }
    } catch (error) {
      if (controller.signal.aborted && activeController.current !== controller) return;
      setMessage(describeApplePccOutcome(
        error instanceof ApplePccEvaluationError ? error.code : 'unknown',
      ));
    } finally {
      if (activeController.current === controller) {
        activeController.current = null;
        setRunningBackend(null);
      }
    }
  };

  const cancel = () => {
    const controller = activeController.current;
    activeController.current = null;
    controller?.abort();
    setRunningBackend(null);
    setMessage(describeApplePccOutcome('cancelled'));
  };

  return (
    <ScrollView contentContainerStyle={[styles.container, { backgroundColor: tc.bg }]}>
      <Text style={[styles.title, { color: tc.text }]}>Private Cloud Compute comparison</Text>
      <Text style={[styles.caption, { color: tc.secondaryText }]}>
        Development-only synthetic fixtures. This screen never reads tasks or changes Mindwtr data.
      </Text>

      <View style={styles.row}>
        {fixtures.map((fixture) => {
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: fixtureId === fixture.fixtureId, disabled: runningBackend !== null }}
              disabled={runningBackend !== null}
              key={fixture.fixtureId}
              onPress={() => {
                setFixtureId(fixture.fixtureId);
                setPccConsent(false);
                setMessage(null);
              }}
              style={[styles.choice, { borderColor: fixtureId === fixture.fixtureId ? tc.tint : tc.border }]}
            >
              <Text style={{ color: fixtureId === fixture.fixtureId ? tc.tint : tc.text }}>
                {fixture.fixtureId === 'smoke' ? '1. Signed-device smoke' : '2. Project planning'}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {!pccSmokePassed ? (
        <Text style={[styles.caption, { color: tc.secondaryText }]}>Run the on-device planning baseline at any time. Complete the PCC smoke before sending the planning fixture to PCC.</Text>
      ) : null}

      {selectedFixture ? (
        <View style={[styles.fixture, { borderColor: tc.border }]}>
          <Text style={[styles.sectionTitle, { color: tc.text }]}>Synthetic fixture sent to either model</Text>
          <Text selectable style={[styles.fixtureText, { color: tc.text }]}>{selectedFixture.text}</Text>
        </View>
      ) : (
        <Text style={[styles.caption, { color: tc.secondaryText }]}>Loading native-owned fixtures…</Text>
      )}

      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel="Consent to this PCC request"
        accessibilityState={{ checked: pccConsent, disabled: runningBackend !== null }}
        disabled={runningBackend !== null}
        onPress={() => setPccConsent((value) => !value)}
        style={[styles.consent, { borderColor: pccConsent ? tc.tint : tc.border }]}
      >
        <Text style={{ color: tc.text }}>
          {pccConsent ? '☑' : '☐'} Send this synthetic fixture to Apple Private Cloud Compute for this request only.
        </Text>
        <Text style={[styles.caption, { color: tc.secondaryText }]}>PCC uses the network and a per-person daily quota. Consent resets when a request starts.</Text>
      </Pressable>

      {BACKENDS.map((backend) => {
        const capability = capabilities[backend];
        const running = runningBackend === backend;
        const disabled = !selectedFixture
          || (runningBackend !== null && !running)
          || capability?.available !== true
          || (backend === 'private_cloud_compute' && fixtureId === 'project_planning' && !pccSmokePassed)
          || (backend === 'private_cloud_compute' && !pccConsent && !running);
        const result = results[resultKey(backend)];
        return (
          <View key={backend} style={[styles.result, { borderColor: tc.border }]}>
            <Text style={[styles.sectionTitle, { color: tc.text }]}>{backendTitle(backend)}</Text>
            <Text style={[styles.caption, { color: tc.secondaryText }]}>
              {capability?.available
                ? `Available${capability.contextSize ? ` · ${capability.contextSize} token context` : ''}`
                : capability ? describeApplePccOutcome(capability.reason ?? 'unknown') : 'Checking availability…'}
            </Text>
            <Pressable
              accessibilityRole="button"
              disabled={!running && disabled}
              onPress={running ? cancel : () => void run(backend)}
              style={[styles.runButton, { backgroundColor: tc.tint, opacity: !running && disabled ? 0.45 : 1 }]}
            >
              <Text style={[styles.runText, { color: tc.onTint }]}>{running ? `Cancel ${backendTitle(backend)}` : `Run ${backendTitle(backend)}`}</Text>
            </Pressable>
            {result ? (
              <View style={styles.output}>
                <Text style={[styles.fixtureText, { color: tc.text }]}>{result.summary}</Text>
                {result.nextActions.map((action, index) => (
                  <Text key={`${index}-${action}`} style={[styles.fixtureText, { color: tc.text }]}>{index + 1}. {action}</Text>
                ))}
                <Text style={[styles.caption, { color: tc.secondaryText }]}>{result.durationMs} ms</Text>
              </View>
            ) : null}
          </View>
        );
      })}
      {message ? <Text accessibilityRole="alert" style={[styles.message, { color: tc.danger }]}>{message}</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 1, padding: 20, gap: 14 },
  title: { fontSize: 22, fontWeight: '700' },
  caption: { fontSize: 14, lineHeight: 20 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { minHeight: 44, borderWidth: 1, borderRadius: 10, justifyContent: 'center', paddingHorizontal: 12 },
  fixture: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 8 },
  fixtureText: { fontSize: 15, lineHeight: 21 },
  sectionTitle: { fontSize: 17, fontWeight: '700' },
  consent: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 6 },
  result: { borderWidth: 1, borderRadius: 12, padding: 14, gap: 10 },
  runButton: { minHeight: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
  runText: { fontSize: 15, fontWeight: '700', textAlign: 'center' },
  output: { gap: 6 },
  message: { fontSize: 14, lineHeight: 20 },
});

export default ApplePccEvaluation;
