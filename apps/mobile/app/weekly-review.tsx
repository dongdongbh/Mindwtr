import { router } from 'expo-router';

import { ReviewModal } from '@/components/review-modal';

export default function WeeklyReviewRoute() {
  return (
    <ReviewModal
      visible
      onClose={() => {
        if (router.canGoBack()) router.back();
        else router.replace('/review-tab');
      }}
    />
  );
}
