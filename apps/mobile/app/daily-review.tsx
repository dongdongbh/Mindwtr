import { router } from 'expo-router';
import { DailyReviewScreen } from '@/components/daily-review-modal';

export default function DailyReviewRoute() {
  return (
    <DailyReviewScreen
      onClose={() => {
        if (router.canGoBack()) router.back();
        else router.replace('/review-tab');
      }}
    />
  );
}
