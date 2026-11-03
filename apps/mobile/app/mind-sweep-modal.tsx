import React from 'react';
import { useRouter } from 'expo-router';

import { MindSweepModalContent } from '../components/mind-sweep-modal-content';
import { ThemedAlertHost } from '../components/themed-alert';

export default function MindSweepModalScreen() {
  const router = useRouter();
  return (
    <>
      <MindSweepModalContent onClose={() => router.back()} />
      {
                                      }
      <ThemedAlertHost />
    </>
  );
}
