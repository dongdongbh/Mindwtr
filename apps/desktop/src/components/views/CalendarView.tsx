import React from 'react';
import { format, startOfMonth, endOfMonth, eachDayOfInterval, isSameMonth, isSameDay, isToday } from 'date-fns';
import { useTaskStore, safeParseDate } from '@mindwtr/core';
import { cn } from '../../lib/utils';

export function CalendarView() {
    const { tasks, addTask } = useTaskStore();
    const today = new Date();
    const [currentMonth, _setCurrentMonth] = React.useState(today);
    const [addingDate, setAddingDate] = React.useState<Date | null>(null);
    const [newTaskTitle, setNewTaskTitle] = React.useState('');

    const days = eachDayOfInterval({
        start: startOfMonth(currentMonth),
        end: endOfMonth(currentMonth),
    });

    const getTasksForDay = (date: Date) => {
        return tasks.filter(task => {
            if (!task.dueDate) return false;
            const dueDate = safeParseDate(task.dueDate);
            return dueDate && isSameDay(dueDate, date);
        });
    };

    const handleAddTask = (e: React.FormEvent) => {
        e.preventDefault();
        if (newTaskTitle.trim() && addingDate) {
            // Set time to 9:00 AM by default for calendar tasks
            const dueDate = new Date(addingDate);
            dueDate.setHours(9, 0, 0, 0);

            addTask(newTaskTitle, {
                dueDate: dueDate.toISOString(),
                status: 'next' // Default to 'next' if scheduled
            });
            setNewTaskTitle('');
            setAddingDate(null);
        }
    };

    return (
        <div className="space-y-6">
            <header className="flex items-center justify-between">
                <h2 className="text-3xl font-bold tracking-tight">Calendar</h2>
                <div className="text-lg font-medium text-muted-foreground">
                    {format(currentMonth, 'MMMM yyyy')}
                </div>
            </header>

            <div className="grid grid-cols-7 gap-px bg-border rounded-lg overflow-hidden shadow-sm">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                    <div key={day} className="bg-card p-2 text-center text-sm font-medium text-muted-foreground">
                        {day}
                    </div>
                ))}

                {days.map((day, _dayIdx) => {
                    const dayTasks = getTasksForDay(day);
                    const isAddingToThisDay = addingDate && isSameDay(day, addingDate);

                    return (
                        <div
                            key={day.toString()}
                            className={cn(
                                "group bg-card min-h-[120px] p-2 transition-colors hover:bg-accent/50 relative",
                                !isSameMonth(day, currentMonth) && "bg-muted/50 text-muted-foreground",
                                isToday(day) && "bg-accent/20"
                            )}
                            onClick={() => !isAddingToThisDay && setAddingDate(day)}
                        >
                            <div className="flex justify-between items-start">
                                <div className={cn(
                                    "text-sm font-medium w-6 h-6 flex items-center justify-center rounded-full mb-1",
                                    isToday(day) && "bg-primary text-primary-foreground"
                                )}>
                                    {format(day, 'd')}
                                </div>
                                {/* Add button that appears on hover */}
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        setAddingDate(day);
                                    }}
                                    className="opacity-0 group-hover:opacity-100 transition-opacity text-xs bg-primary text-primary-foreground px-1.5 rounded hover:bg-primary/90"
                                >
                                    +
                                </button>
                            </div>

                            <div className="space-y-1">
                                {dayTasks.map(task => (
                                    <div
                                        key={task.id}
                                        className="text-xs truncate px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20"
                                        title={task.title}
                                        onClick={(e) => e.stopPropagation()} // Prevent triggering add on task click
                                    >
                                        {task.title}
                                    </div>
                                ))}

                                {isAddingToThisDay && (
                                    <form
                                        onSubmit={handleAddTask}
                                        className="mt-1"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <input
                                            autoFocus
                                            type="text"
                                            value={newTaskTitle}
                                            onChange={(e) => setNewTaskTitle(e.target.value)}
                                            onBlur={() => !newTaskTitle && setAddingDate(null)}
                                            placeholder="New task..."
                                            className="w-full text-xs p-1 rounded border border-primary focus:ring-1 focus:ring-primary outline-none"
                                        />
                                    </form>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
