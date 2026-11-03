import { WaitingView } from '@/components/views/waiting-view';
import { WidgetLaunchDestination } from '@/hooks/use-widget-launch';

export default function WaitingScreen() {
  return <><WaitingView /><WidgetLaunchDestination path="/waiting" /></>;
}
