import { SomedayView } from '@/components/views/someday-view';
import { WidgetLaunchDestination } from '@/hooks/use-widget-launch';

export default function SomedayScreen() {
  return <><SomedayView /><WidgetLaunchDestination path="/someday" /></>;
}
