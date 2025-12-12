import { View, Text, ScrollView, Pressable, TextInput, StyleSheet } from 'react-native';
import { useTaskStore, safeParseDate } from '@mindwtr/core';
import type { Task } from '@mindwtr/core';
import { useState } from 'react';
import { useTheme } from '../../contexts/theme-context';
import { Colors } from '@/constants/theme';

// Simple date utilities (avoiding date-fns dependency)
function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

function isSameDay(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

function isToday(date: Date): boolean {
  return isSameDay(date, new Date());
}

export function CalendarView() {
  const { tasks, addTask } = useTaskStore();
  const { isDark } = useTheme();
  const today = new Date();
  const [currentMonth, setCurrentMonth] = useState(today.getMonth());
  const [currentYear, setCurrentYear] = useState(today.getFullYear());
  const [selectedDate, setSelectedDate] = useState<Date | null>(null);
  const [newTaskTitle, setNewTaskTitle] = useState('');

  // Theme colors
  const tc = {
    bg: isDark ? Colors.dark.background : Colors.light.background,
    cardBg: isDark ? '#1F2937' : '#FFFFFF',
    text: isDark ? Colors.dark.text : Colors.light.text,
    secondaryText: isDark ? '#9CA3AF' : '#6B7280',
    border: isDark ? '#374151' : '#E5E7EB',
    inputBg: isDark ? '#374151' : '#F9FAFB',
  };

  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const firstDay = getFirstDayOfMonth(currentYear, currentMonth);
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const getTasksForDay = (day: number): Task[] => {
    const date = new Date(currentYear, currentMonth, day);
    return tasks.filter((task) => {
      if (!task.dueDate) return false;
      const dueDate = safeParseDate(task.dueDate);
      return dueDate && isSameDay(dueDate, date);
    });
  };

  const handleAddTask = () => {
    if (newTaskTitle.trim() && selectedDate) {
      const dueDate = new Date(selectedDate);
      dueDate.setHours(9, 0, 0, 0);
      addTask(newTaskTitle, {
        dueDate: dueDate.toISOString(),
        status: 'next',
      });
      setNewTaskTitle('');
      setSelectedDate(null);
    }
  };

  const handlePrevMonth = () => {
    if (currentMonth === 0) {
      setCurrentMonth(11);
      setCurrentYear(currentYear - 1);
    } else {
      setCurrentMonth(currentMonth - 1);
    }
  };

  const handleNextMonth = () => {
    if (currentMonth === 11) {
      setCurrentMonth(0);
      setCurrentYear(currentYear + 1);
    } else {
      setCurrentMonth(currentMonth + 1);
    }
  };

  // Build calendar grid
  const calendarDays: (number | null)[] = [];
  for (let i = 0; i < firstDay; i++) {
    calendarDays.push(null);
  }
  for (let day = 1; day <= daysInMonth; day++) {
    calendarDays.push(day);
  }

  return (
    <View style={[styles.container, { backgroundColor: tc.bg }]}>
      <View style={[styles.header, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
        <Pressable onPress={handlePrevMonth} style={styles.navButton}>
          <Text style={[styles.navButtonText]}>‹</Text>
        </Pressable>
        <Text style={[styles.title, { color: tc.text }]}>
          {monthNames[currentMonth]} {currentYear}
        </Text>
        <Pressable onPress={handleNextMonth} style={styles.navButton}>
          <Text style={[styles.navButtonText]}>›</Text>
        </Pressable>
      </View>

      <ScrollView style={styles.calendarScroll}>
        <View style={[styles.dayHeaders, { backgroundColor: tc.cardBg, borderBottomColor: tc.border }]}>
          {dayNames.map((day) => (
            <View key={day} style={styles.dayHeader}>
              <Text style={[styles.dayHeaderText, { color: tc.secondaryText }]}>{day}</Text>
            </View>
          ))}
        </View>

        <View style={styles.calendarGrid}>
          {calendarDays.map((day, index) => {
            if (day === null) {
              return <View key={`empty-${index}`} style={styles.dayCell} />;
            }

            const date = new Date(currentYear, currentMonth, day);
            const dayTasks = getTasksForDay(day);
            const isSelected = selectedDate && isSameDay(date, selectedDate);

            return (
              <Pressable
                key={day}
                style={[
                  styles.dayCell,
                  isToday(date) && styles.todayCell,
                  isSelected && styles.selectedCell,
                ]}
                onPress={() => setSelectedDate(date)}
              >
                <View
                  style={[
                    styles.dayNumber,
                    isToday(date) && styles.todayNumber,
                  ]}
                >
                  <Text
                    style={[
                      styles.dayText,
                      { color: tc.text },
                      isToday(date) && styles.todayText,
                    ]}
                  >
                    {day}
                  </Text>
                </View>
                {dayTasks.length > 0 && (
                  <View style={styles.taskDot}>
                    <Text style={styles.taskDotText}>{dayTasks.length}</Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>

        {selectedDate && (
          <View style={[styles.selectedDateSection, { backgroundColor: tc.cardBg }]}>
            <Text style={[styles.selectedDateTitle, { color: tc.text }]}>
              {selectedDate.toLocaleDateString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </Text>

            <View style={styles.addTaskForm}>
              <TextInput
                style={[styles.input, { backgroundColor: tc.inputBg, borderColor: tc.border, color: tc.text }]}
                value={newTaskTitle}
                onChangeText={setNewTaskTitle}
                placeholder="Add new task..."
                placeholderTextColor="#9CA3AF"
              />
              <Pressable
                style={[styles.addButton, !newTaskTitle.trim() && styles.addButtonDisabled]}
                onPress={handleAddTask}
                disabled={!newTaskTitle.trim()}
              >
                <Text style={styles.addButtonText}>Add</Text>
              </Pressable>
            </View>

            <View style={styles.tasksList}>
              {getTasksForDay(selectedDate.getDate()).map((task) => (
                <View key={task.id} style={[styles.taskItem, { backgroundColor: tc.inputBg }]}>
                  <Text style={[styles.taskItemTitle, { color: tc.text }]} numberOfLines={1}>
                    {task.title}
                  </Text>
                  {task.startTime && (
                    <Text style={[styles.taskItemTime, { color: tc.secondaryText }]}>
                      {(() => {
                        const date = safeParseDate(task.startTime);
                        return date ? date.toLocaleTimeString('en-US', {
                          hour: '2-digit',
                          minute: '2-digit',
                        }) : '';
                      })()}
                    </Text>
                  )}
                </View>
              ))}
              {getTasksForDay(selectedDate.getDate()).length === 0 && (
                <Text style={[styles.noTasks, { color: tc.secondaryText }]}>No tasks for this day</Text>
              )}
            </View>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
  },
  navButton: {
    padding: 8,
  },
  navButtonText: {
    fontSize: 32,
    color: '#3B82F6',
    fontWeight: 'bold',
  },
  calendarScroll: {
    flex: 1,
  },
  dayHeaders: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    paddingVertical: 8,
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
    padding: 4,
  },
  dayCell: {
    width: '14.28%',
    aspectRatio: 1,
    padding: 4,
    alignItems: 'center',
    justifyContent: 'flex-start',
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
  todayNumber: {
    backgroundColor: '#3B82F6',
  },
  dayText: {
    fontSize: 14,
    color: '#111827',
  },
  todayText: {
    color: '#FFFFFF',
    fontWeight: 'bold',
  },
  taskDot: {
    marginTop: 2,
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
  addButton: {
    backgroundColor: '#3B82F6',
    paddingHorizontal: 20,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addButtonDisabled: {
    backgroundColor: '#9CA3AF',
  },
  addButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  tasksList: {
    gap: 8,
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
  taskItemTitle: {
    flex: 1,
    fontSize: 14,
    color: '#111827',
  },
  taskItemTime: {
    fontSize: 12,
    color: '#6B7280',
    marginLeft: 8,
  },
  noTasks: {
    textAlign: 'center',
    color: '#9CA3AF',
    fontSize: 14,
    paddingVertical: 16,
  },
});
