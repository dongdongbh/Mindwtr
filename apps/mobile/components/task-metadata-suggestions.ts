import { getPersonSuggestionNames, type Person, type Task } from '@mindwtr/core';


export const rankTokenSuggestions = (
  pool: string[],
  selected: Iterable<string>,
  terms: string[],
  limit: number,
): string[] => {
  const selectedTokens = new Set(selected);
  const candidates = pool.filter((token) => !selectedTokens.has(token));
  if (candidates.length === 0) return [];
  const fromInput = candidates.filter((token) => {
    const normalizedToken = token.slice(1).toLowerCase();
    return terms.some((term) => normalizedToken.includes(term));
  });
  const merged = [...fromInput, ...candidates.filter((token) => !fromInput.includes(token))];
  return merged.slice(0, limit);
};

export const getAssignedToSuggestions = (
  tasks: Task[],
  value: string | undefined,
  limit: number,
  people: Person[] = [],
): string[] => {
  return getPersonSuggestionNames(people, tasks, value, limit);
};
