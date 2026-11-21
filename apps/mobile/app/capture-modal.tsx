import React, { useEffect } from 'react';
import { markCaptureRouteMounted } from '@/lib/capture-route-presence';
import { useLocalSearchParams } from 'expo-router';
import { CaptureForm } from '@/components/CaptureForm';
import type { CaptureModalParams } from '@mindwtr/core/capture-modal-model';

export { sanitizeCaptureReturnToParam } from '@mindwtr/core/capture-modal-model';

export default function CaptureScreen() {
  const params = useLocalSearchParams<CaptureModalParams>();
  useEffect(() => markCaptureRouteMounted(), []);
  return <CaptureForm params={params} />;
}
