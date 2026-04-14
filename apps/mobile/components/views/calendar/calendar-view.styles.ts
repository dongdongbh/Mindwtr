import { StyleSheet } from 'react-native';

export const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 2,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  title: {
    fontSize: 17,
    fontWeight: 'bold',
    color: '#111827',
  },
  navButton: {
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  navButtonText: {
    fontSize: 26,
    color: '#3B82F6',
    fontWeight: 'bold',
  },
  monthCalendar: {
    flexShrink: 0,
  },
  monthDetailsPane: {
    flexShrink: 0,
    maxHeight: 300,
    borderTopWidth: 1,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    overflow: 'hidden',
  },
  monthDetailsContent: {
    padding: 16,
    paddingBottom: 24,
  },
  monthDetailsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginBottom: 6,
  },
  addTaskButton: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  addTaskButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  calendarScroll: {
    flex: 1,
  },
  dayHeaders: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  dayHeader: {
    flex: 1,
    alignItems: 'center',
  },
  dayHeaderText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#6B7280',
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 4,
    paddingTop: 0,
  },
  calendarGridCompact: {
    paddingHorizontal: 12,
  },
  dayCell: {
    width: '14.28%',
    aspectRatio: 1,
    padding: 4,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  dayCellCompact: {
    aspectRatio: 0.88,
    padding: 3,
  },
  todayCell: {
    backgroundColor: '#EFF6FF',
  },
  selectedCell: {
    backgroundColor: '#DBEAFE',
  },
  dayNumber: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayNumberCompact: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  todayNumber: {
    backgroundColor: '#3B82F6',
  },
  dayText: {
    fontSize: 14,
    color: '#111827',
  },
  dayTextCompact: {
    fontSize: 13,
  },
  todayText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
  },
  taskDot: {
    backgroundColor: '#3B82F6',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 8,
    minWidth: 16,
    alignItems: 'center',
  },
  taskDotText: {
    fontSize: 10,
    color: '#FFFFFF',
    fontWeight: '600',
  },
  indicatorRow: {
    marginTop: 2,
    flexDirection: 'row',
    gap: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eventDot: {
    backgroundColor: '#6B7280',
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 8,
    minWidth: 16,
    alignItems: 'center',
  },
  eventDotText: {
    fontSize: 10,
    color: '#FFFFFF',
    fontWeight: '600',
  },
  selectedDateSection: {
    backgroundColor: '#FFFFFF',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  selectedDateTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
    marginBottom: 12,
  },
  addTaskForm: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    borderRadius: 8,
    padding: 12,
    fontSize: 14,
    backgroundColor: '#F9FAFB',
    color: '#111827',
  },
  tasksList: {
    gap: 8,
  },
  scheduleResults: {
    gap: 8,
    marginBottom: 12,
  },
  scheduleResultsTitle: {
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 2,
  },
  taskItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#F9FAFB',
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#3B82F6',
  },
  eventItem: {
    borderLeftColor: '#6B7280',
  },
  taskItemMain: {
    flex: 1,
    minWidth: 0,
  },
  taskItemTitle: {
    fontSize: 14,
    color: '#111827',
  },
  taskItemTime: {
    fontSize: 12,
    color: '#6B7280',
  },
  quickDoneButton: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginLeft: 8,
  },
  quickDoneButtonText: {
    fontSize: 12,
    fontWeight: '600',
  },
  noTasks: {
    textAlign: 'center',
    color: '#9CA3AF',
    fontSize: 14,
    paddingVertical: 16,
  },
  dayModeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    gap: 10,
  },
  dayModeBack: {
    paddingVertical: 6,
    paddingHorizontal: 6,
  },
  dayModeBackText: {
    fontSize: 14,
    fontWeight: '700',
  },
  dayModeTitle: {
    flex: 1,
    textAlign: 'center',
    fontSize: 16,
    fontWeight: '800',
  },
  dayModeNav: {
    flexDirection: 'row',
    gap: 8,
  },
  dayNavButton: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  dayNavText: {
    fontSize: 22,
    fontWeight: '800',
  },
  dayScroll: {
    flex: 1,
  },
  dayScrollContent: {
    padding: 16,
    gap: 12,
    paddingBottom: 24,
  },
  allDayCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
  },
  sectionLabel: {
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  allDayItem: {
    fontSize: 13,
    paddingVertical: 2,
  },
  timelineCard: {
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  timelineArea: {
    position: 'relative',
  },
  hourLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    height: 18,
    paddingRight: 12,
  },
  hourLabel: {
    width: 56,
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'right',
    paddingRight: 8,
  },
  hourDivider: {
    flex: 1,
    height: 1,
  },
  eventBlock: {
    position: 'absolute',
    left: 56,
    right: 12,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
  },
  eventBlockTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  eventBlockTime: {
    fontSize: 11,
    marginTop: 2,
  },
  taskBlock: {
    position: 'absolute',
    left: 56,
    right: 12,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 1,
  },
  taskBlockTitle: {
    fontSize: 13,
    fontWeight: '800',
    color: '#FFFFFF',
  },
  taskBlockTitleCompact: {
    fontSize: 12,
    lineHeight: 14,
  },
  taskBlockTime: {
    fontSize: 11,
    marginTop: 2,
    color: 'rgba(255,255,255,0.9)',
  },
  dayScheduleCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 12,
    gap: 12,
  },
});
